import crypto from "crypto";
import { createClient } from "redis";

export const config = {
  runtime: "nodejs",
};

const EVENT_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const WORKFLOW_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_DEDUP_TTL_SECONDS = EVENT_DEDUP_TTL_MS / 1000;
const WORKFLOW_MESSAGE_TTL_SECONDS = WORKFLOW_MESSAGE_TTL_MS / 1000;
const RUNTIME_CONFIG_KEY = "admin:runtime_config";
const REDIS_RUNTIME_READ_TIMEOUT_MS = 150;

const processedEvents = new Map();
const workflowMessageMap = new Map();

let redisClient = null;
let redisConnectPromise = null;
let redisDisabledUntil = 0;

const REDIS_CONNECT_TIMEOUT_MS = 1200;
const REDIS_COOLDOWN_MS = 60_000;

function disableRedis() {
  redisDisabledUntil = Date.now() + REDIS_COOLDOWN_MS;
  redisClient = null;
}

function getRedisUrl() {
  return (
    process.env.REDIS_URL ||
    process.env.UPSTASH_REDIS_URL ||
    process.env.webhook_REDIS_URL ||
    null
  );
}

function getAllowedRepos(raw = process.env.ALLOWED_REPOS || "") {
  return (raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function getAllowedBranch(raw = process.env.ALLOWED_BRANCH || "") {
  const branch = (raw || "").trim();
  return branch || null;
}

function getWorkflowFilter(raw = process.env.WORKFLOW_NAME_FILTER || "") {
  const filter = (raw || "").trim();
  return filter || null;
}

function parseChatTargets(raw) {
  return (raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx > 1) {
        const chatId = entry.slice(0, colonIdx);
        const threadId = Number(entry.slice(colonIdx + 1));
        if (Number.isFinite(threadId) && threadId > 0) {
          return { chatId, threadId };
        }
      }
      return { chatId: entry, threadId: null };
    });
}

function onlyFailuresEnabled(raw = process.env.ONLY_FAILURES) {
  return raw === "true";
}

function lowPrioritySilentEnabled(raw = process.env.SILENT_LOW_PRIORITY) {
  const v = raw;
  if (v === undefined || v === null || v === "") return true;
  return v !== "false";
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
  if (Date.now() < redisDisabledUntil) return null;

  if (!redisClient) {
    redisClient = createClient({ url });
    redisClient.on("error", (error) => {
      console.error("Redis error:", error);
      disableRedis();
    });
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    redisConnectPromise = (async () => {
      try {
        await Promise.race([
          redisClient.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Redis connection timeout")), REDIS_CONNECT_TIMEOUT_MS)
          ),
        ]);
        return redisClient;
      } catch (error) {
        try {
          if (redisClient.isOpen) {
            await redisClient.disconnect();
          }
        } catch {}
        console.error("Redis connect failed:", error?.message || error);
        disableRedis();
        return null;
      } finally {
        redisConnectPromise = null;
      }
    })();
  }

  await redisConnectPromise;
  return redisClient?.isOpen ? redisClient : null;
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

// ── generic tracking (check_run, check_suite) ─────────────────────────────────

async function getMessageTracking(trackingKey, chatId) {
  const key = `github:msg:${trackingKey}:${chatId}`;
  const redis = await getRedisClient();

  if (!redis) {
    cleanupMap(workflowMessageMap, WORKFLOW_MESSAGE_TTL_MS);
    return workflowMessageMap.get(`${trackingKey}:${chatId}`) || null;
  }

  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function saveMessageTracking(trackingKey, chatId, trackingData, ttlSeconds = WORKFLOW_MESSAGE_TTL_SECONDS) {
  const key = `github:msg:${trackingKey}:${chatId}`;
  const redis = await getRedisClient();

  if (!redis) {
    workflowMessageMap.set(`${trackingKey}:${chatId}`, {
      ...trackingData,
      updatedAt: Date.now(),
    });
    return;
  }

  await redis.set(key, JSON.stringify(trackingData), {
    EX: ttlSeconds,
  });
}

async function getWorkflowTracking(workflowRunId, chatId) {
  return getMessageTracking(`workflow:${workflowRunId}`, chatId);
}

async function saveWorkflowTracking(workflowRunId, chatId, trackingData) {
  return saveMessageTracking(`workflow:${workflowRunId}`, chatId, trackingData);
}

// ── activity log ─────────────────────────────────────────────────────────────
const ACTIVITY_LOG_KEY = "github:activity_log";
const ACTIVITY_LOG_MAX = 50;

async function appendActivityLog(entry) {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.lPush(ACTIVITY_LOG_KEY, JSON.stringify(entry));
    await redis.lTrim(ACTIVITY_LOG_KEY, 0, ACTIVITY_LOG_MAX - 1);
  } catch (err) {
    console.error("Activity log write error:", err.message);
  }
}

async function getRuntimeConfig(key) {
  const redis = await getRedisClient();
  if (!redis) return null;

  return Promise.race([
    redis.hGet(RUNTIME_CONFIG_KEY, key),
    new Promise((resolve) => setTimeout(() => resolve(null), REDIS_RUNTIME_READ_TIMEOUT_MS)),
  ]).catch(() => null);
}

async function getRuntimeConfigValues(keys) {
  const redis = await getRedisClient();
  if (!redis) return {};

  return Promise.race([
    redis.hmGet(RUNTIME_CONFIG_KEY, keys),
    new Promise((resolve) => setTimeout(() => resolve(null), REDIS_RUNTIME_READ_TIMEOUT_MS)),
  ]).then((values) => {
    if (!Array.isArray(values)) return {};
    return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null]));
  }).catch(() => ({}));
}

function runtimeOrEnv(runtimeConfig, key) {
  return runtimeConfig?.[key] ?? process.env[key] ?? "";
}

async function getDisabledEvents(runtimeConfig = null) {
  const stored = runtimeConfig ? runtimeConfig.DISABLED_EVENTS : await getRuntimeConfig("DISABLED_EVENTS");
  const raw = stored ?? process.env.DISABLED_EVENTS ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function repoAllowed(fullName, allowedRepos = getAllowedRepos()) {
  if (!allowedRepos.length) return true;
  return allowedRepos.includes(fullName);
}

function shouldTrackWorkflow(name, filter = getWorkflowFilter()) {
  if (!filter) return true;
  return (name || "").toLowerCase().includes(filter.toLowerCase());
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

function buildIssueText(repository, issue, action) {
  const emojiMap = {
    opened: "🟢",
    closed: "🔴",
    reopened: "🔁",
    edited: "✏️",
    labeled: "🏷️",
    unlabeled: "🏷️",
    assigned: "👤",
    unassigned: "👤",
    locked: "🔒",
    unlocked: "🔓",
    pinned: "📌",
    unpinned: "📌",
    transferred: "📦",
    milestoned: "🎯",
    demilestoned: "🎯",
  };

  const emoji = emojiMap[action] || "ℹ️";
  const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => l.name).filter(Boolean) : [];

  return `${emoji} Issue ${action}

Repo: ${repository.full_name}
Title: ${issue.title}
Author: ${issue.user?.login || "unknown"}
State: ${issue.state || "-"}

${labels.length ? `Labels: ${labels.join(", ")}\n` : ""}${issue.html_url}`;
}

function buildIssueCommentText(repository, issue, comment, action) {
  const emojiMap = {
    created: "💬",
    edited: "✏️",
    deleted: "🗑️",
  };

  const emoji = emojiMap[action] || "💬";

  return `${emoji} Issue Comment ${action}

Repo: ${repository.full_name}
Issue: #${issue.number}
Title: ${issue.title}
Author: ${comment.user?.login || "unknown"}

${comment.html_url || issue.html_url}`;
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
  } else if (action === "review_requested") {
    emoji = "🧑‍💻";
  } else if (action === "review_request_removed") {
    emoji = "🧹";
  }

  return `${emoji} Pull Request ${label}

Repo: ${repository.full_name}
Title: ${pr.title}
Author: ${pr.user?.login || "unknown"}
Branch: ${pr.head?.ref || "?"} → ${pr.base?.ref || "?"}
${pr.draft ? "Draft: yes\n" : ""}${merged && pr.merged_by?.login ? `Merged by: ${pr.merged_by.login}\n` : ""}${isRevert ? "Revert: yes\n" : ""}
${pr.html_url}`;
}

function buildPullRequestReviewText(repository, pr, review, action) {
  const emojiMap = {
    submitted: "🧪",
    edited: "✏️",
    dismissed: "🚫",
  };

  const emoji = emojiMap[action] || "🧪";

  return `${emoji} PR Review ${action}

Repo: ${repository.full_name}
PR: #${pr.number}
Title: ${pr.title}
Reviewer: ${review.user?.login || "unknown"}
State: ${review.state || "-"}

${review.html_url || pr.html_url}`;
}

function buildPullRequestReviewCommentText(repository, pr, comment, action) {
  const emojiMap = {
    created: "💬",
    edited: "✏️",
    deleted: "🗑️",
  };

  const emoji = emojiMap[action] || "💬";

  return `${emoji} PR Review Comment ${action}

Repo: ${repository.full_name}
PR: #${pr.number}
Title: ${pr.title}
Author: ${comment.user?.login || "unknown"}

${comment.html_url || pr.html_url}`;
}

function buildDiscussionText(repository, discussion, action) {
  const emojiMap = {
    created: "💬",
    edited: "✏️",
    answered: "✅",
    category_changed: "📁",
    deleted: "🗑️",
    transferred: "📦",
    pinned: "📌",
    unpinned: "📌",
    locked: "🔒",
    unlocked: "🔓",
    labeled: "🏷️",
    unlabeled: "🏷️",
  };

  const emoji = emojiMap[action] || "💬";

  return `${emoji} Discussion ${action}

Repo: ${repository.full_name}
Title: ${discussion.title}
Author: ${discussion.user?.login || "unknown"}
Category: ${discussion.category?.name || "-"}

${discussion.html_url}`;
}

function buildDiscussionCommentText(repository, discussion, comment, action) {
  const emojiMap = {
    created: "💬",
    edited: "✏️",
    deleted: "🗑️",
  };

  const emoji = emojiMap[action] || "💬";

  return `${emoji} Discussion Comment ${action}

Repo: ${repository.full_name}
Discussion: ${discussion.title}
Author: ${comment.user?.login || "unknown"}

${comment.html_url || discussion.html_url}`;
}

function buildReleaseText(repository, release, action) {
  return `📦 Release ${action}

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

${deploymentStatus.environment_url || deploymentStatus.target_url || deployment.payload?.url || ""}`;
}

function buildDependabotText(repository, alert) {
  return `🚨 Dependabot Alert

Repo: ${repository.full_name}
Package: ${alert.dependency?.package?.name || "unknown"}
Severity: ${alert.security_advisory?.severity || "unknown"}
Summary: ${alert.security_advisory?.summary || "-"}
State: ${alert.state || "unknown"}

${alert.html_url || ""}`;
}

function buildSecretScanningText(repository, alert) {
  return `🔑 Secret Scanning Alert

Repo: ${repository.full_name}
Secret Type: ${alert.secret_type || "unknown"}
State: ${alert.state || "unknown"}
Resolution: ${alert.resolution || "-"}

${alert.html_url || ""}`;
}

function buildCodeScanningText(repository, alert) {
  return `🛡️ Code Scanning Alert

Repo: ${repository.full_name}
Rule: ${alert.rule?.description || alert.rule?.id || "unknown"}
Severity: ${alert.rule?.security_severity_level || alert.rule?.severity || "unknown"}
State: ${alert.state || "unknown"}

${alert.html_url || ""}`;
}

function buildStarText(repository, sender) {
  return `⭐ Star

Repo: ${repository.full_name}
User: ${sender?.login || "unknown"}

${repository.html_url}`;
}

function buildForkText(repository, forkee, sender) {
  return `🍴 Fork

Repo: ${repository.full_name}
Fork: ${forkee?.full_name || forkee?.html_url || "unknown"}
By: ${sender?.login || "unknown"}

${forkee?.html_url || repository.html_url}`;
}

function buildCreateText(repository, refType, ref) {
  return `✨ Created

Repo: ${repository.full_name}
Type: ${refType}
Name: ${ref}

${repository.html_url}`;
}

function buildDeleteText(repository, refType, ref) {
  return `🗑️ Deleted

Repo: ${repository.full_name}
Type: ${refType}
Name: ${ref}

${repository.html_url}`;
}

function buildBranchProtectionText(repository, rule, action) {
  return `🛡️ Branch Protection Rule ${action}

Repo: ${repository.full_name}
Pattern: ${rule.pattern || "-"}
Name: ${rule.name || "-"}

${repository.html_url}`;
}

function buildCheckRunText(repository, checkRun, status, conclusion) {
  let emoji = "⏳";
  if (status === "in_progress") emoji = "🛠️";
  else if (status === "completed") emoji = conclusion === "success" ? "✅" : "❌";

  const conclusionStr = conclusion ? ` / ${conclusion}` : "";

  return `${emoji} Check Run

Repo: ${repository.full_name}
Name: ${checkRun.name}
Status: ${status}${conclusionStr}

${checkRun.html_url || repository.html_url}`;
}

function buildCheckSuiteText(repository, checkSuite, status, conclusion) {
  let emoji = "⏳";
  if (status === "in_progress") emoji = "🛠️";
  else if (status === "completed") emoji = conclusion === "success" ? "✅" : "❌";

  const conclusionStr = conclusion ? ` / ${conclusion}` : "";

  return `${emoji} Check Suite

Repo: ${repository.full_name}
Head branch: ${checkSuite.head_branch || "-"}
Status: ${status}${conclusionStr}

${checkSuite.url || repository.html_url}`;
}

function buildRepoEventText(repository, action) {
  return `📁 Repository ${action}

Repo: ${repository.full_name}
Default branch: ${repository.default_branch || "-"}

${repository.html_url}`;
}

function buildMemberEventText(eventName, action, repository, subject) {
  return `👥 ${eventName} ${action}

Repo: ${repository.full_name}
User/Team: ${subject}

${repository.html_url}`;
}

function buildGenericOrgEventText(eventName, action, body) {
  const org = body.organization?.login || body.organization?.name || body.sender?.login || "unknown";
  const repo = body.repository?.full_name || null;

  return `${eventName} ${action}

Org: ${org}${repo ? `\nRepo: ${repo}` : ""}

${body.organization?.html_url || body.repository?.html_url || ""}`;
}

async function telegramRequest(botToken, method, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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

function buildTelegramPayload(chatId, text, { silent = false, replyMarkup = null, disableWebPagePreview = true, threadId = null } = {}) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disableWebPagePreview,
    disable_notification: silent,
  };

  if (threadId) {
    payload.message_thread_id = threadId;
  }

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  return payload;
}

async function sendToAllChats(botToken, chatTargets, text, options = {}) {
  for (const { chatId, threadId } of chatTargets) {
    try {
      await telegramRequest(
        botToken,
        "sendMessage",
        buildTelegramPayload(chatId, text, { ...options, threadId })
      );
    } catch (error) {
      console.error(`Failed sending to ${chatId}${threadId ? `:${threadId}` : ""}:`, error);
    }
  }
}

async function upsertWorkflowNotification(botToken, chatTarget, workflowRun, message) {
  const { chatId, threadId } = chatTarget;
  cleanupMap(workflowMessageMap, WORKFLOW_MESSAGE_TTL_MS);

  const tracked = await getWorkflowTracking(workflowRun.id, chatId);

  if (!tracked) {
    const created = await telegramRequest(
      botToken,
      "sendMessage",
      buildTelegramPayload(chatId, message, {
        silent: false,
        disableWebPagePreview: true,
        threadId,
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
      buildTelegramPayload(chatId, message, {
        silent: false,
        disableWebPagePreview: true,
        threadId,
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

/**
 * Upsert a Telegram message for check_run or check_suite events.
 * Tracks by (trackingKey, chatId). Edits the existing message when
 * status/conclusion changes; sends a new one on first occurrence.
 */
async function upsertCheckNotification(botToken, chatTarget, trackingKey, message, currentStatus, currentConclusion, replyMarkup = null) {
  const { chatId, threadId } = chatTarget;

  const tracked = await getMessageTracking(trackingKey, chatId);

  if (!tracked) {
    const created = await telegramRequest(
      botToken,
      "sendMessage",
      buildTelegramPayload(chatId, message, {
        silent: false,
        disableWebPagePreview: true,
        threadId,
        replyMarkup,
      })
    );

    await saveMessageTracking(trackingKey, chatId, {
      messageId: created.result?.message_id,
      lastStatus: currentStatus,
      lastConclusion: currentConclusion || null,
    });

    return;
  }

  const sameStatus = tracked.lastStatus === currentStatus;
  const sameConclusion = tracked.lastConclusion === (currentConclusion || null);

  if (sameStatus && sameConclusion) {
    return;
  }

  if (tracked.messageId) {
    const editPayload = {
      chat_id: chatId,
      message_id: tracked.messageId,
      text: message,
      disable_web_page_preview: true,
    };
    if (replyMarkup) editPayload.reply_markup = replyMarkup;
    await telegramRequest(botToken, "editMessageText", editPayload);
  } else {
    const created = await telegramRequest(
      botToken,
      "sendMessage",
      buildTelegramPayload(chatId, message, {
        silent: false,
        disableWebPagePreview: true,
        threadId,
        replyMarkup,
      })
    );
    tracked.messageId = created.result?.message_id;
  }

  await saveMessageTracking(trackingKey, chatId, {
    messageId: tracked.messageId,
    lastStatus: currentStatus,
    lastConclusion: currentConclusion || null,
  });
}

export default async function handler(req, res) {
  try {
    const event = req.headers["x-github-event"];

    if (event === "ping") {
      return res.status(200).json({ ok: true, pong: true });
    }

    const runtimeConfig = await getRuntimeConfigValues([
      "BOT_TOKEN",
      "CHAT_ID",
      "WEBHOOK_SECRET",
      "ALLOWED_REPOS",
      "ALLOWED_BRANCH",
      "WORKFLOW_NAME_FILTER",
      "ONLY_FAILURES",
      "SILENT_LOW_PRIORITY",
      "DISABLED_EVENTS",
    ]);
    const BOT_TOKEN = runtimeOrEnv(runtimeConfig, "BOT_TOKEN");
    const CHAT_TARGETS = parseChatTargets(runtimeOrEnv(runtimeConfig, "CHAT_ID"));
    const SECRET = runtimeOrEnv(runtimeConfig, "WEBHOOK_SECRET");
    const allowedRepos = getAllowedRepos(runtimeOrEnv(runtimeConfig, "ALLOWED_REPOS"));
    const allowedBranch = getAllowedBranch(runtimeOrEnv(runtimeConfig, "ALLOWED_BRANCH"));
    const workflowFilter = getWorkflowFilter(runtimeOrEnv(runtimeConfig, "WORKFLOW_NAME_FILTER"));
    const onlyFailures = onlyFailuresEnabled(runtimeOrEnv(runtimeConfig, "ONLY_FAILURES"));
    const silentLowPriority = lowPrioritySilentEnabled(runtimeOrEnv(runtimeConfig, "SILENT_LOW_PRIORITY"));

    if (!BOT_TOKEN || !CHAT_TARGETS.length || !SECRET) {
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

    const disabledEvents = await getDisabledEvents(runtimeConfig);
    if (disabledEvents.has(event)) {
      return res.status(200).json({ ignored: true, reason: "event_disabled", event });
    }

    const repositoryName = req.body?.repository?.full_name;
    if (repositoryName && !repoAllowed(repositoryName, allowedRepos)) {
      return res.status(200).json({ ignored: true, reason: "repo_not_allowed" });
    }

    const eventKey = buildEventKey(req);
    if (await isDuplicateEvent(eventKey)) {
      return res.status(200).send("Duplicate webhook ignored");
    }

    appendActivityLog({
      ts: Date.now(),
      event,
      action: req.body?.action || null,
      repo: repositoryName || null,
    }).catch(() => {});
    const repository = req.body.repository || {};

    if (event === "watch") {
      if (req.body.action !== "started") {
        return res.status(200).end();
      }

      const text = buildStarText(repository, req.body.sender);
      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: silentLowPriority,
        disableWebPagePreview: false,
      });
      return res.status(200).json({ ok: true });
    }

    if (event === "fork") {
      const text = buildForkText(repository, req.body.forkee, req.body.sender);
      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: silentLowPriority,
        disableWebPagePreview: false,
      });
      return res.status(200).json({ ok: true });
    }

    if (event === "create") {
      const text = buildCreateText(repository, req.body.ref_type, req.body.ref);
      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
      });
      return res.status(200).json({ ok: true });
    }

    if (event === "delete") {
      const text = buildDeleteText(repository, req.body.ref_type, req.body.ref);
      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
      });
      return res.status(200).json({ ok: true });
    }

    if (event === "push") {
      const branch = (req.body.ref || "").replace("refs/heads/", "");

      if (allowedBranch && branch !== allowedBranch) {
        return res.status(200).end();
      }

      const commits = (req.body.commits || []).slice(-3);
      const compare = req.body.compare;
      const headCommit = req.body.head_commit;
      const importantKeywords = ["security", "hotfix", "urgent", "prod", "revert", "rollback"];
      const important = commits.some((c) =>
        importantKeywords.some((k) => (c.message || "").toLowerCase().includes(k))
      );

      let text = `${important ? "🚨 IMPORTANT PUSH" : "🚀 Git Push"}

Repo: ${repository.full_name}
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

      text += `View push:\n${compare || repository.html_url || ""}`;

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "workflow_run") {
      const wf = req.body.workflow_run;
      if (!wf) return res.status(200).end();

      if (onlyFailures && wf.status === "completed" && wf.conclusion === "success") {
        return res.status(200).end();
      }

      if (!shouldTrackWorkflow(wf.name || "", workflowFilter)) {
        return res.status(200).end();
      }

      if (allowedBranch && wf.head_branch !== allowedBranch) {
        return res.status(200).end();
      }

      const status = mapWorkflowStatus(wf);
      if (!status) {
        return res.status(200).end();
      }

      const message = formatWorkflowMessage(repository, wf, status);

      for (const chatTarget of CHAT_TARGETS) {
        await upsertWorkflowNotification(BOT_TOKEN, chatTarget, wf, message);
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
        "review_request_removed",
        "ready_for_review",
        "converted_to_draft",
        "synchronize",
        "assigned",
        "unassigned",
        "labeled",
        "unlabeled",
        "locked",
        "unlocked",
        "edited",
        "auto_merge_enabled",
        "auto_merge_disabled",
      ];

      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const text = buildPullRequestText(repository, pr, action);
      const isRevert = action === "closed" && pr?.merged && isRevertPullRequest(pr);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[
            { text: isRevert ? "Open Revert PR" : "Open PR", url: pr.html_url },
          ]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "pull_request_review") {
      const pr = req.body.pull_request;
      const review = req.body.review;
      const action = req.body.action;

      if (!["submitted", "edited", "dismissed"].includes(action)) {
        return res.status(200).end();
      }

      const text = buildPullRequestReviewText(repository, pr, review, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open PR", url: pr.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "pull_request_review_comment") {
      const pr = req.body.pull_request;
      const comment = req.body.comment;
      const action = req.body.action;

      if (!["created", "edited", "deleted"].includes(action)) {
        return res.status(200).end();
      }

      const text = buildPullRequestReviewCommentText(repository, pr, comment, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open PR", url: pr.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "issues") {
      const issue = req.body.issue;
      const action = req.body.action;

      if (!issue || issue.pull_request) {
        return res.status(200).end();
      }

      const allowedActions = [
        "opened",
        "closed",
        "reopened",
        "edited",
        "labeled",
        "unlabeled",
        "assigned",
        "unassigned",
        "locked",
        "unlocked",
        "pinned",
        "unpinned",
        "transferred",
        "milestoned",
        "demilestoned",
      ];

      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const text = buildIssueText(repository, issue, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open Issue", url: issue.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "issue_comment") {
      const issue = req.body.issue;
      const comment = req.body.comment;
      const action = req.body.action;

      if (!issue || issue.pull_request) {
        return res.status(200).end();
      }

      if (!["created", "edited", "deleted"].includes(action)) {
        return res.status(200).end();
      }

      const text = buildIssueCommentText(repository, issue, comment, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open Issue", url: issue.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "discussion") {
      const discussion = req.body.discussion;
      const action = req.body.action;

      const allowedActions = [
        "created",
        "edited",
        "answered",
        "category_changed",
        "deleted",
        "transferred",
        "pinned",
        "unpinned",
        "locked",
        "unlocked",
        "labeled",
        "unlabeled",
      ];

      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const text = buildDiscussionText(repository, discussion, action);
      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open Discussion", url: discussion.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "discussion_comment") {
      const discussion = req.body.discussion;
      const comment = req.body.comment;
      const action = req.body.action;

      if (!["created", "edited", "deleted"].includes(action)) {
        return res.status(200).end();
      }

      const text = buildDiscussionCommentText(repository, discussion, comment, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open Discussion", url: discussion.html_url }]],
        },
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "release") {
      const release = req.body.release;
      const action = req.body.action || "published";

      if (!release) return res.status(200).end();
      if (onlyFailures) return res.status(200).end();

      const allowedActions = ["published", "prereleased", "released", "edited"];
      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const text = buildReleaseText(repository, release, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Open Release", url: release.html_url }]],
        },
      });

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

      const text = buildDeploymentStatusText(repository, deployment, deploymentStatus);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: deploymentStatus.target_url
          ? { inline_keyboard: [[{ text: "Open Deployment", url: deploymentStatus.target_url }]] }
          : undefined,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "check_run") {
      const checkRun = req.body.check_run;
      const action = req.body.action;

      if (!checkRun) return res.status(200).end();
      if (!["created", "requested_action", "completed", "rerequested"].includes(action)) {
        return res.status(200).end();
      }

      if (onlyFailures && action === "completed" && checkRun.conclusion === "success") {
        return res.status(200).end();
      }

      const currentStatus = checkRun.status || "queued";
      const currentConclusion = checkRun.conclusion || null;
      const trackingKey = `check_run:${checkRun.id}`;
      const text = buildCheckRunText(repository, checkRun, currentStatus, currentConclusion);
      const replyMarkup = checkRun.html_url
        ? { inline_keyboard: [[{ text: "Open Check", url: checkRun.html_url }]] }
        : null;

      for (const chatTarget of CHAT_TARGETS) {
        await upsertCheckNotification(BOT_TOKEN, chatTarget, trackingKey, text, currentStatus, currentConclusion, replyMarkup);
      }

      return res.status(200).json({ ok: true });
    }

    if (event === "check_suite") {
      const checkSuite = req.body.check_suite;
      const action = req.body.action;

      if (!checkSuite) return res.status(200).end();
      if (!["completed", "requested", "rerequested", "created"].includes(action)) {
        return res.status(200).end();
      }

      if (onlyFailures && action === "completed" && checkSuite.conclusion === "success") {
        return res.status(200).end();
      }

      const currentStatus = checkSuite.status || "queued";
      const currentConclusion = checkSuite.conclusion || null;
      const trackingKey = `check_suite:${checkSuite.id}`;
      const text = buildCheckSuiteText(repository, checkSuite, currentStatus, currentConclusion);
      const replyMarkup = checkSuite.url
        ? { inline_keyboard: [[{ text: "Open Check Suite", url: checkSuite.url }]] }
        : null;

      for (const chatTarget of CHAT_TARGETS) {
        await upsertCheckNotification(BOT_TOKEN, chatTarget, trackingKey, text, currentStatus, currentConclusion, replyMarkup);
      }

      return res.status(200).json({ ok: true });
    }

    if (event === "branch_protection_rule") {
      const rule = req.body.rule;
      const action = req.body.action;

      if (!["created", "edited", "deleted"].includes(action)) {
        return res.status(200).end();
      }

      const text = buildBranchProtectionText(repository, rule, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "dependabot_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildDependabotText(repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: alert.html_url
          ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
          : undefined,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "secret_scanning_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildSecretScanningText(repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: alert.html_url
          ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
          : undefined,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "code_scanning_alert") {
      const alert = req.body.alert;
      if (!alert) return res.status(200).end();

      const text = buildCodeScanningText(repository, alert);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
        replyMarkup: alert.html_url
          ? { inline_keyboard: [[{ text: "Open Alert", url: alert.html_url }]] }
          : undefined,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "member" || event === "membership" || event === "team" || event === "team_add") {
      const action = req.body.action || "updated";
      const subject =
        req.body.member?.login ||
        req.body.team?.name ||
        req.body.sender?.login ||
        "unknown";

      const text = buildMemberEventText(event, action, repository, subject);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: true,
        disableWebPagePreview: false,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "organization_member") {
      const action = req.body.action || "updated";
      const text = buildGenericOrgEventText("organization_member", action, req.body);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: true,
        disableWebPagePreview: false,
      });

      return res.status(200).json({ ok: true });
    }

    if (event === "repository") {
      const action = req.body.action;
      const allowedActions = ["created", "deleted", "publicized", "privatized", "renamed", "archived", "unarchived", "edited", "transferred"];

      if (!allowedActions.includes(action)) {
        return res.status(200).end();
      }

      const text = buildRepoEventText(repository, action);

      await sendToAllChats(BOT_TOKEN, CHAT_TARGETS, text, {
        silent: false,
        disableWebPagePreview: false,
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ignored: true, event });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || "Internal Server Error" });
  }
}
