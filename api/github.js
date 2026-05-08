import crypto from "crypto";
import { createClient } from "redis";

export const config = {
  runtime: "nodejs"
};

const processedEvents = new Map();
const workflowMessageMap = new Map();

const EVENT_DEDUP_TTL_MS =
  6 * 60 * 60 * 1000;

const WORKFLOW_MESSAGE_TTL_MS =
  24 * 60 * 60 * 1000;

const EVENT_DEDUP_TTL_SECONDS =
  EVENT_DEDUP_TTL_MS / 1000;

const WORKFLOW_MESSAGE_TTL_SECONDS =
  WORKFLOW_MESSAGE_TTL_MS / 1000;

let redisClient;
let redisConnectPromise;

function getRedisUrl() {
  return (
    process.env.webhook_REDIS_URL ||
    process.env.REDIS_URL ||
    null
  );
}

function canUseRedis() {
  return Boolean(getRedisUrl());
}

async function getRedisClient() {
  if (!canUseRedis()) {
    return null;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: getRedisUrl()
    });

    redisClient.on("error", (error) => {
      console.error(
        "Redis error:",
        error
      );
    });
  }

  if (redisClient.isOpen) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    redisConnectPromise =
      redisClient
        .connect()
        .catch((error) => {
          redisConnectPromise =
            null;

          throw error;
        })
        .then(() => {
          redisConnectPromise =
            null;
        });
  }

  await redisConnectPromise;

  return redisClient;
}

function cleanupMap(map, ttl) {
  const now = Date.now();

  for (const [key, value] of map.entries()) {
    if (
      now - value.updatedAt >
      ttl
    ) {
      map.delete(key);
    }
  }
}

function buildEventKey(req) {
  const event =
    req.headers["x-github-event"];

  const delivery =
    req.headers[
      "x-github-delivery"
    ] || "no-delivery";

  const action =
    req.body?.action ||
    "no-action";

  return `${event}:${delivery}:${action}`;
}

function isDuplicateEventInMemory(
  eventKey
) {
  cleanupMap(
    processedEvents,
    EVENT_DEDUP_TTL_MS
  );

  if (
    processedEvents.has(eventKey)
  ) {
    return true;
  }

  processedEvents.set(eventKey, {
    updatedAt: Date.now()
  });

  return false;
}

async function isDuplicateEvent(
  eventKey
) {
  const redis =
    await getRedisClient();

  if (!redis) {
    return isDuplicateEventInMemory(
      eventKey
    );
  }

  const key = `github:dedup:${eventKey}`;

  const result = await redis.set(
    key,
    "1",
    {
      EX: EVENT_DEDUP_TTL_SECONDS,
      NX: true
    }
  );

  return result !== "OK";
}

async function telegramRequest(
  botToken,
  method,
  payload
) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Telegram API ${method} failed: ${response.status} ${errorText}`
    );
  }

  return response.json();
}

function mapWorkflowStatus(wf) {
  if (wf.status === "queued") {
    return {
      label: "queued",
      emoji: "⏳"
    };
  }

  if (
    wf.status === "in_progress"
  ) {
    return {
      label: "building",
      emoji: "🛠️"
    };
  }

  if (
    wf.status === "completed"
  ) {
    if (
      wf.conclusion ===
      "success"
    ) {
      return {
        label: "success",
        emoji: "✅"
      };
    }

    return {
      label:
        wf.conclusion ||
        "failure",
      emoji: "❌"
    };
  }

  return null;
}

function formatDuration(
  startedAt,
  endedAt
) {
  if (
    !startedAt ||
    !endedAt
  ) {
    return "-";
  }

  const ms =
    new Date(endedAt).getTime() -
    new Date(startedAt).getTime();

  if (
    Number.isNaN(ms) ||
    ms < 0
  ) {
    return "-";
  }

  const totalSeconds =
    Math.floor(ms / 1000);

  const minutes =
    Math.floor(
      totalSeconds / 60
    );

  const seconds =
    totalSeconds % 60;

  return `${minutes}m ${seconds}s`;
}

function formatWorkflowMessage(
  repository,
  wf,
  status
) {
  const duration =
    wf.status === "completed"
      ? formatDuration(
          wf.run_started_at,
          wf.updated_at
        )
      : "-";

  return `${status.emoji} GitHub Action

Repo: ${repository.full_name}
Branch: ${wf.head_branch}
Workflow: ${wf.name}
Status: ${status.label}
Actor: ${
    wf.actor?.login ||
    "unknown"
  }
Commit: ${
    wf.head_commit?.id?.slice(
      0,
      7
    ) || "-"
  }
Duration: ${duration}

${wf.html_url}`;
}

function shouldTrackWorkflow(
  name
) {
  const workflowFilter =
    process.env
      .WORKFLOW_NAME_FILTER;

  // No filter = all workflows
  if (!workflowFilter) {
    return true;
  }

  return name
    .toLowerCase()
    .includes(
      workflowFilter.toLowerCase()
    );
}

async function getWorkflowTracking(
  workflowRunId,
  chatId
) {
  const key = `github:workflow:${workflowRunId}:${chatId}`;

  const redis =
    await getRedisClient();

  if (!redis) {
    cleanupMap(
      workflowMessageMap,
      WORKFLOW_MESSAGE_TTL_MS
    );

    return (
      workflowMessageMap.get(
        `${workflowRunId}:${chatId}`
      ) || null
    );
  }

  const raw =
    await redis.get(key);

  return raw
    ? JSON.parse(raw)
    : null;
}

async function saveWorkflowTracking(
  workflowRunId,
  chatId,
  trackingData
) {
  const key = `github:workflow:${workflowRunId}:${chatId}`;

  const redis =
    await getRedisClient();

  if (!redis) {
    workflowMessageMap.set(
      `${workflowRunId}:${chatId}`,
      {
        ...trackingData,
        updatedAt: Date.now()
      }
    );

    return;
  }

  await redis.set(
    key,
    JSON.stringify(
      trackingData
    ),
    {
      EX: WORKFLOW_MESSAGE_TTL_SECONDS
    }
  );
}

async function upsertWorkflowNotification(
  botToken,
  chatId,
  workflowRun,
  message
) {
  cleanupMap(
    workflowMessageMap,
    WORKFLOW_MESSAGE_TTL_MS
  );

  const tracked =
    await getWorkflowTracking(
      workflowRun.id,
      chatId
    );

  if (!tracked) {
    const created =
      await telegramRequest(
        botToken,
        "sendMessage",
        {
          chat_id: chatId,
          text: message,
          disable_web_page_preview:
            true
        }
      );

    await saveWorkflowTracking(
      workflowRun.id,
      chatId,
      {
        messageId:
          created.result
            ?.message_id,
        lastStatus:
          workflowRun.status,
        lastConclusion:
          workflowRun.conclusion ||
          null
      }
    );

    return;
  }

  const sameStatus =
    tracked.lastStatus ===
    workflowRun.status;

  const sameConclusion =
    tracked.lastConclusion ===
    (workflowRun.conclusion ||
      null);

  if (
    sameStatus &&
    sameConclusion
  ) {
    return;
  }

  if (tracked.messageId) {
    await telegramRequest(
      botToken,
      "editMessageText",
      {
        chat_id: chatId,
        message_id:
          tracked.messageId,
        text: message,
        disable_web_page_preview:
          true
      }
    );
  } else {
    const created =
      await telegramRequest(
        botToken,
        "sendMessage",
        {
          chat_id: chatId,
          text: message,
          disable_web_page_preview:
            true
        }
      );

    tracked.messageId =
      created.result
        ?.message_id;
  }

  await saveWorkflowTracking(
    workflowRun.id,
    chatId,
    {
      messageId:
        tracked.messageId,
      lastStatus:
        workflowRun.status,
      lastConclusion:
        workflowRun.conclusion ||
        null
    }
  );
}

async function sendToAllChats(
  botToken,
  chatIds,
  method,
  payloadBuilder
) {
  for (const chatId of chatIds) {
    try {
      await telegramRequest(
        botToken,
        method,
        payloadBuilder(chatId)
      );
    } catch (error) {
      console.error(
        `Failed sending to ${chatId}:`,
        error
      );
    }
  }
}

export default async function handler(
  req,
  res
) {
  try {
    const BOT_TOKEN =
      process.env.BOT_TOKEN;

    const CHAT_IDS = (
      process.env.CHAT_ID ||
      ""
    )
      .split(",")
      .map((id) =>
        id.trim()
      )
      .filter(Boolean);

    const SECRET =
      process.env
        .WEBHOOK_SECRET;

    const ALLOWED_BRANCH =
      process.env
        .ALLOWED_BRANCH ||
      "main";

    if (
      !BOT_TOKEN ||
      !CHAT_IDS.length ||
      !SECRET
    ) {
      return res
        .status(500)
        .send(
          "Missing environment variables"
        );
    }

    const signature =
      req.headers[
        "x-hub-signature-256"
      ];

    const event =
      req.headers[
        "x-github-event"
      ];

    const raw = JSON.stringify(
      req.body
    );

    const hmac =
      crypto.createHmac(
        "sha256",
        SECRET
      );

    const digest = `sha256=${hmac
      .update(raw)
      .digest("hex")}`;

    if (
      !signature ||
      signature !== digest
    ) {
      return res
        .status(401)
        .send(
          "Invalid signature"
        );
    }

    const eventKey =
      buildEventKey(req);

    if (
      await isDuplicateEvent(
        eventKey
      )
    ) {
      return res
        .status(200)
        .send(
          "Duplicate webhook ignored"
        );
    }

    // ================= PUSH =================

    if (event === "push") {
      const branch =
        req.body.ref.replace(
          "refs/heads/",
          ""
        );

      if (
        branch !==
        ALLOWED_BRANCH
      ) {
        return res
          .status(200)
          .end();
      }

      const repo =
        req.body.repository
          .full_name;

      const commits =
        req.body.commits.slice(
          -3
        );

      const pushUrl =
        req.body.compare;

      let text = `🚀 Git Push

Repo: ${repo}
Branch: ${branch}

`;

      commits.forEach((c) => {
        text += `• ${c.author.name}: ${c.message}
${c.url}

`;
      });

      text += `View push:
${pushUrl}`;

      await sendToAllChats(
        BOT_TOKEN,
        CHAT_IDS,
        "sendMessage",
        (chatId) => ({
          chat_id: chatId,
          text,
          disable_web_page_preview:
            false
        })
      );
    }

    // ================= WORKFLOW RUN =================

    if (
      event ===
      "workflow_run"
    ) {
      const wf =
        req.body.workflow_run;

      if (
        !shouldTrackWorkflow(
          wf.name
        )
      ) {
        return res
          .status(200)
          .end();
      }

      if (
        wf.head_branch !==
        ALLOWED_BRANCH
      ) {
        return res
          .status(200)
          .end();
      }

      const status =
        mapWorkflowStatus(
          wf
        );

      if (!status) {
        return res
          .status(200)
          .end();
      }

      const message =
        formatWorkflowMessage(
          req.body.repository,
          wf,
          status
        );

      for (const chatId of CHAT_IDS) {
        await upsertWorkflowNotification(
          BOT_TOKEN,
          chatId,
          wf,
          message
        );
      }
    }

    return res
      .status(200)
      .end();
  } catch (error) {
    console.error(error);

    return res
      .status(500)
      .send(
        error?.message ||
          "Internal Server Error"
      );
  }
}