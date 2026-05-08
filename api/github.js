import crypto from "crypto";
import { createClient } from "redis";

export const config = {
  runtime: "nodejs",
};

const EVENT_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const WORKFLOW_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_DEDUP_TTL_SECONDS = EVENT_DEDUP_TTL_MS / 1000;
const WORKFLOW_MESSAGE_TTL_SECONDS = WORKFLOW_MESSAGE_TTL_MS / 1000;

const processedEvents = new Map();
const workflowMessageMap = new Map();

let redisClient = null;
let redisConnectPromise = null;

function getRedisUrl() {
  return (
    process.env.REDIS_URL ||
    process.env.UPSTASH_REDIS_URL ||
    process.env.webhook_REDIS_URL ||
    null
  );
}

function getAllowedRepos() {
  return (process.env.ALLOWED_REPOS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function getAllowedBranch() {
  const branch = (process.env.ALLOWED_BRANCH || "").trim();
  return branch || null;
}

function getWorkflowFilter() {
  const filter = (process.env.WORKFLOW_NAME_FILTER || "").trim();
  return filter || null;
}

function getThreadId() {
  const raw = (process.env.TELEGRAM_THREAD_ID || "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function onlyFailuresEnabled() {
  return process.env.ONLY_FAILURES === "true";
}

function cleanupMap(map, ttl) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (now - value.updatedAt > ttl) {
      map.delete(key);
    }
  }
}

async function getRedisClient() {
  const url = getRedisUrl();
  if (!url) return null;

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) => {
      console.error("Redis error:", error);
    });
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    redisConnectPromise = (async () => {
      const connectPromise = redisClient.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Redis connection timeout")), 5000);
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
        return redisClient;
      } catch (error) {
        try {
          await redisClient.disconnect();
        } catch {}
        redisClient = null;
        throw error;
      } finally {
        redisConnectPromise = null;
      }
    })();
  }

  await redisConnectPromise;
  return redisClient;
}

function buildEventKey(req) {
  const event = req.headers["x-github-event"] || "unknown";
  const delivery = req.headers["x-github-delivery"] || "no-delivery";
  const action = req.body?.action || "no-action";
  return `${event}:${delivery}:${action}`;
}

function isDuplicateEventInMemory(eventKey) {
  cleanupMap(processedEvents, EVENT_DEDUP_TTL_MS);

  if (processedEvents.has(eventKey)) {
    return true;
  }

  processedEvents.set(eventKey, { updatedAt: Date.now() });
  return false;
}

async function isDuplicateEvent(eventKey) {
  const redis = await getRedisClient();

  if (!redis) {
    return isDuplicateEventInMemory(eventKey);
  }

  const key = `github:dedup:${eventKey}`;
  const result = await redis.set(key, "1", {
    EX: EVENT_DEDUP_TTL_SECONDS,
    NX: true,
  });

  return result !== "OK";
}

async function getWorkflowTracking(workflowRunId, chatId) {
  const key = `github:workflow:${workflowRunId}:${chatId}`;
  const redis = await getRedisClient();

  if (!redis) {
    cleanupMap(workflowMessageMap, WORKFLOW_MESSAGE_TTL_MS);
    return workflowMessageMap.get(`${workflowRunId}:${chatId}`) || null;
  }

  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function saveWorkflowTracking(workflowRunId, chatId, trackingData) {
  const key = `github:workflow:${workflowRunId}:${chatId}`;
  const redis = await getRedisClient();

  if (!redis) {
    workflowMessageMap.set(`${workflowRunId}:${chatId}`, {
      ...trackingData,
      updatedAt: Date.now(),
    });
    return;
  }

  await redis.set(key, JSON.stringify(trackingData), {
    EX: WORKFLOW_MESSAGE_TTL_SECONDS,
  });
}

async function telegramRequest(botToken, method, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API ${method} failed: ${response.status} ${errorText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildSendMessagePayload(chatId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    ...extra,
  };

  const threadId = getThreadId();
  if (threadId) {
    payload.message_thread_id = threadId;
  }

  return payload;
}

async function sendToAllChats(botToken, chatIds, method, payloadBuilder) {
  for (const chatId of chatIds) {
    try {
      await telegramRequest(botToken, method, payloadBuilder(chatId));
    } catch (error) {
      console.error(`Failed sending to ${chatId}:`, error);
    }
  }
}

function shouldTrackWorkflow(name) {
  const filter = getWorkflowFilter();
  if (!filter) return true;
  return name.toLowerCase().includes(filter.toLowerCase());
}

function repoAllowed(fullName) {
  const allowedRepos = getAllowedRepos();
  if (!allowedRepos.length) return true;
  return allowedRepos.includes(fullName);
}

function mapWorkflowStatus(wf) {
  if (wf.status === "queued") {
    return { label: "queued", emoji: "⏳" };
  }

  if (wf.status === "in_progress") {
    return { label: "building", emoji: "🛠️" };
  }

  if (wf.status === "completed") {
    if (wf.conclusion === "success") {
      return { label: "success", emoji: "✅" };
    }
    return { label: wf.conclusion || "failure", emoji: "❌" };
  }

  return null;
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "-";

  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatWorkflowMessage(repository, wf, status) {
  const duration = wf.status === "completed" ? formatDuration(wf.run_started_at, wf.updated_at) : "-";

  return `${status.emoji} GitHub Action

Repo: ${repository.full_name}
Workflow: ${wf.name}
Branch: ${wf.head_branch}
Status: ${status.label}
Actor: ${wf.actor?.login || "unknown"}
Commit: ${wf.head_commit?.id?.slice(0, 7) || "-"}
Duration: ${duration}

${wf.html_url}`;
}

function isRevertPullRequest(pr) {
  const title = (pr?.title || "").toLowerCase();
  const body = (pr?.body || "").toLowerCase();

  return (
    title.startsWith("revert") ||
    title.includes("revert ") ||
    title.includes("revert:") ||
    body.includes("this reverts commit")
  );
}

function buildPullRequestText(repository, pr, action) {
  const merged = action === "closed" && pr.merged;
  const isRevert = merged && isRevertPullRequest(pr);

  let emoji = "🔀";
  let label = action;

  if (merged) {
    emoji = isRevert ? "⏪" : "✅";
    label = isRevert ? "merged revert" : "merged";
  } else if (action === "opened") {
    emoji = "🆕";
  } else if (action === "reopened") {
    emoji = "🔁";
  } else if (action === "ready_for_review") {
    emoji = "👀";
  } else if (action === "converted_to_draft") {
    emoji = "📝";
  } else if (action === "synchronize") {
    emoji = "♻️";
  }

  const text = `${emoji} Pull Request ${label}

Repo: ${repository.full_name}
Title: ${pr.title}
Author: ${pr.user?.login || "unknown"}
Branch: ${pr.head?.ref || "?"} → ${pr.base?.ref || "?"}
${pr.draft ? "Draft: yes\n" : ""}${merged && pr.merged_by?.login ? `Merged by: ${pr.merged_by.login}\n` : ""}
${isRevert ? "Revert: yes\n" : ""}
${pr.html_url}`;

  return { text, isRevert };
}

function buildReleaseText(repository, release) {
  return `📦 Release Published

Repo: ${repository.full_name}
Tag: ${release.tag_name}
Name: ${release.name || "untitled"}
Author: ${release.author?.login || "unknown"}
Prerelease: ${release.prerelease ? "yes" : "no"}

${release.html_url}`;
}

function buildDeploymentStatusText(repository, deployment, deploymentStatus) {
  return `🚀 Deployment ${deploymentStatus.state}

Repo: ${repository.full_name}
Environment: ${deployment.environment || deploymentStatus.environment || "unknown"}
Description: ${deploymentStatus.description || deployment.description || "-"}
Target URL: ${deploymentStatus.target_url || deployment.payload?.url || "-"}

${deploymentStatus.environment_url || deploymentStatus.target_url || ""}`.trim();
}

function buildDependabotText(repository, alert) {
  return `🚨 Dependabot Alert

Repo: ${repository.full_name}
Package: ${alert.dependency?.package?.name || "unknown"}
Severity: ${alert.security_advisory?.severity || "unknown"}
Summary: ${alert.security_advisory?.summary || "-"}
State: ${alert.state || "unknown"}

${alert.html_url || ""}`.trim();
}

function buildSecretScanningText(repository, alert) {
  return `🔑 Secret Scanning Alert

Repo: ${repository.full_name}
Secret Type: ${alert.secret_type || "unknown"}
State: ${alert.state || "unknown"}
Resolution: ${alert.resolution || "-"}

${alert.html_url || ""}`.trim();
}

function buildCodeScanningText(repository, alert) {
  return `🛡️ Code Scanning Alert

Repo: ${repository.full_name}
Rule: ${alert.rule?.description || alert.rule?.id || "unknown"}
Severity: ${alert.rule?.security_severity_level || alert.rule?.severity || "unknown"}
State: ${alert.state || "unknown"}

${alert.html_url || ""}`.trim();
}

async function upsertWorkflowNotification(botToken, chatId, workflowRun, message) {
  cleanupMap(workflowMessageMap, WORKFLOW_MESSAGE_TTL_MS);

  const tracked = await getWorkflowTracking(workflowRun.id, chatId);

  if (!tracked) {
    const created = await telegramRequest(
      botToken,
      "sendMessage",
      buildSendMessagePayload(chatId, message, {
        disable_web_page_preview: true,
      })
    );

    await saveWorkflowTracking(workflowRun.id, chatId, {
      messageId: created.result?.message_id,
      lastStatus: workflowRun.status,
      lastConclusion: workflowRun.conclusion || null,
    });

    return;
  }

  const sameStatus = tracked.lastStatus === workflowRun.status;
  const sameConclusion = tracked.lastConclusion === (workflowRun.conclusion || null);

  if (sameStatus && sameConclusion) {
    return;
  }

  if (tracked.messageId) {
    await telegramRequest(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: tracked.messageId,
      text: message,
      disable_web_page_preview: true,
    });
  } else {
    const created = await telegramRequest(
      botToken,
      "sendMessage",
      buildSendMessagePayload(chatId, message, {
        disable_web_page_preview: true,
      })
    );

    tracked.messageId = created.result?.message_id;
  }

  await saveWorkflowTracking(workflowRun.id, chatId, {
    messageId: tracked.messageId,
    lastStatus: workflowRun.status,
    lastConclusion: workflowRun.conclusion || null,
  });
}

export default async function handler(req, res) {
  try {
    const event = req.headers["x-github-event"];

    if (event === "ping") {
      return res.status(200).json({ ok: true, pong: true });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_IDS = (process.env.CHAT_ID || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const SECRET = process.env.WEBHOOK_SECRET;
    const allowedBranch = getAllowedBranch();
    const onlyFailures = onlyFailuresEnabled();

    if (!BOT_TOKEN || !CHAT_IDS.length || !SECRET) {
      return res.status(500).json({
        error: "Missing environment variables",
      });
    }

    const signature = req.headers["x-hub-signature-256"];
    const raw = JSON.stringify(req.body);
    const digest = `sha256=${crypto.createHmac("sha256", SECRET).update(raw).digest("hex")}`;

    if (!signature || signature !== digest) {
      return res.status(401).send("Invalid signature");
    }

    const repositoryName = req.body?.repository?.full_name;
    if (repositoryName && !repoAllowed(repositoryName)) {
      return res.status(200).json({ ignored: true, reason: "repo_not_allowed" });
    }

    const eventKey = buildEventKey(req);
    if (await isDuplicateEvent(eventKey)) {
      return res.status(200).send("Duplicate webhook ignored");
    }

    if (event === "push") {
      const branch = (req.body.ref || "").replace("refs/heads/", "");

      if (allowedBranch && branch !== allowedBranch) {
        return res.status(200).end();
      }

      const repo = req.body.repository.full_name;
      const commits = (req.body.commits || []).slice(-3);
      const compare = req.body.compare;
      const headCommit = req.body.head_commit;
      const importantKeywords = ["security", "hotfix", "urgent", "prod", "revert", "rollback"];
      const important = commits.some((c) =>
        importantKeywords.some((k) => (c.message || "").toLowerCase().includes(k))
      );

      let text = `${important ? "🚨 IMPORTANT PUSH" : "🚀 Git Push"}

Repo: ${repo}
Branch: ${branch}

`;

      for (const c of commits) {
        text += `• ${c.author?.name || "unknown"}: ${c.message || "(no message)"}
${c.url || ""}

`;
      }

      const added = headCommit?.added || [];
      const modified = headCommit?.modified || [];
      const removed = headCommit?.removed || [];
      const changedFiles = [...added, ...modified, ...removed].slice(0, 10);

      if (changedFiles.length) {
        text += `Changed files:\n`;
        for (const file of changedFiles) {
          text += `• ${file}\n`;
        }
        text += `\n`;
      }

      text += `View push:\n${compare}`;

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "workflow_run") {
      const wf = req.body.workflow_run;
      if (!wf) return res.status(200).end();

      if (onlyFailures && wf.status === "completed" && wf.conclusion === "success") {
        return res.status(200).end();
      }

      if (!shouldTrackWorkflow(wf.name || "")) {
        return res.status(200).end();
      }

      if (allowedBranch && wf.head_branch !== allowedBranch) {
        return res.status(200).end();
      }

      const status = mapWorkflowStatus(wf);
      if (!status) {
        return res.status(200).end();
      }

      const message = formatWorkflowMessage(req.body.repository, wf, status);

      for (const chatId of CHAT_IDS) {
        await upsertWorkflowNotification(BOT_TOKEN, chatId, wf, message);
      }

      return res.status(200).json({ ok: true });
    }

    if (event === "pull_request") {
      const pr = req.body.pull_request;
      const action = req.body.action;

      const allowedActions = [
        "opened",
        "closed",
        "reopened",
        "review_requested",
        "ready_for_review",
        "converted_to_draft",
        "synchronize",
      ];

      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const { text } = buildPullRequestText(req.body.repository, pr, action);
      const prUrl = pr.html_url;

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: {
            inline_keyboard: [[{ text: "Open PR", url: prUrl }]],
          },
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "release") {
      if (req.body.action && req.body.action !== "published") {
        return res.status(200).end();
      }

      const release = req.body.release;
      if (!release) return res.status(200).end();

      if (onlyFailures) {
        return res.status(200).end();
      }

      const text = buildReleaseText(req.body.repository, release);

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: {
            inline_keyboard: [[{ text: "Open Release", url: release.html_url }]],
          },
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "deployment_status") {
      const deploymentStatus = req.body.deployment_status;
      const deployment = req.body.deployment;

      if (!deploymentStatus || !deployment) {
        return res.status(200).end();
      }

      if (onlyFailures && deploymentStatus.state === "success") {
        return res.status(200).end();
      }

      const text = buildDeploymentStatusText(req.body.repository, deployment, deploymentStatus);

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: deploymentStatus.target_url
            ? { inline_keyboard: [[{ text: "Open Deployment", url: deploymentStatus.target_url }]] }
            : undefined,
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "dependabot_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildDependabotText(req.body.repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: alert.html_url
            ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
            : undefined,
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "secret_scanning_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildSecretScanningText(req.body.repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: alert.html_url
            ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
            : undefined,
        })
      );

      return res.status(200).json({ ok: true });
    }

    if (event === "code_scanning_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildCodeScanningText(req.body.repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_IDS, "sendMessage", (chatId) =>
        buildSendMessagePayload(chatId, text, {
          disable_web_page_preview: false,
          reply_markup: alert.html_url
            ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
            : undefined,
        })
      );

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ignored: true, event });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || "Internal Server Error" });
  }
}