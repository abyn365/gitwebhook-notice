import crypto from "crypto";
import { createClient } from "redis";

export const config = {
  runtime: "nodejs"
};

// ================= REDIS =================

let redisClient = null;
let redisPromise = null;

async function getRedis() {
  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL
    });

    redisClient.on(
      "error",
      (err) => {
        console.error(
          "Redis Error:",
          err
        );
      }
    );
  }

  if (!redisPromise) {
    redisPromise =
      redisClient
        .connect()
        .then(() => {
          console.log(
            "Redis connected"
          );
        })
        .catch((err) => {
          redisPromise = null;
          throw err;
        });
  }

  await Promise.race([
    redisPromise,
    new Promise(
      (_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Redis timeout"
              )
            ),
          5000
        )
    )
  ]);

  return redisClient;
}

// ================= HELPERS =================

async function telegramRequest(
  botToken,
  method,
  payload
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () =>
      controller.abort(),
    10000
  );

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${botToken}/${method}`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify(
            payload
          ),
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      const text =
        await response.text();

      throw new Error(
        `Telegram API error: ${text}`
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function shouldTrackWorkflow(
  name
) {
  const filter =
    process.env
      .WORKFLOW_NAME_FILTER;

  // Empty filter = all workflows
  if (!filter) {
    return true;
  }

  return name
    .toLowerCase()
    .includes(
      filter.toLowerCase()
    );
}

function mapWorkflowStatus(wf) {
  if (wf.status === "queued") {
    return {
      emoji: "⏳",
      label: "queued"
    };
  }

  if (
    wf.status === "in_progress"
  ) {
    return {
      emoji: "🛠️",
      label: "building"
    };
  }

  if (
    wf.status === "completed"
  ) {
    return {
      emoji:
        wf.conclusion ===
        "success"
          ? "✅"
          : "❌",
      label:
        wf.conclusion ||
        "completed"
    };
  }

  return null;
}

function formatWorkflowMessage(
  repository,
  wf,
  status
) {
  return `${status.emoji} GitHub Action

Repo: ${repository.full_name}
Workflow: ${wf.name}
Branch: ${wf.head_branch}
Status: ${status.label}
Actor: ${
    wf.actor?.login ||
    "unknown"
  }

${wf.html_url}`;
}

async function isDuplicateEvent(
  redis,
  eventKey
) {
  const key = `github:event:${eventKey}`;

  const result =
    await redis.set(
      key,
      "1",
      {
        EX: 21600,
        NX: true
      }
    );

  return result !== "OK";
}

async function getWorkflowTracking(
  redis,
  workflowId,
  chatId
) {
  const key = `github:workflow:${workflowId}:${chatId}`;

  const raw =
    await redis.get(key);

  return raw
    ? JSON.parse(raw)
    : null;
}

async function saveWorkflowTracking(
  redis,
  workflowId,
  chatId,
  data
) {
  const key = `github:workflow:${workflowId}:${chatId}`;

  await redis.set(
    key,
    JSON.stringify(data),
    {
      EX: 86400
    }
  );
}

async function upsertWorkflowMessage(
  redis,
  botToken,
  chatId,
  workflow,
  text
) {
  const existing =
    await getWorkflowTracking(
      redis,
      workflow.id,
      chatId
    );

  if (!existing) {
    const sent =
      await telegramRequest(
        botToken,
        "sendMessage",
        {
          chat_id: chatId,
          text,
          disable_web_page_preview:
            true
        }
      );

    await saveWorkflowTracking(
      redis,
      workflow.id,
      chatId,
      {
        messageId:
          sent.result
            ?.message_id,
        status:
          workflow.status,
        conclusion:
          workflow.conclusion ||
          null
      }
    );

    return;
  }

  const sameStatus =
    existing.status ===
    workflow.status;

  const sameConclusion =
    existing.conclusion ===
    (workflow.conclusion ||
      null);

  if (
    sameStatus &&
    sameConclusion
  ) {
    return;
  }

  if (existing.messageId) {
    await telegramRequest(
      botToken,
      "editMessageText",
      {
        chat_id: chatId,
        message_id:
          existing.messageId,
        text,
        disable_web_page_preview:
          true
      }
    );
  }

  await saveWorkflowTracking(
    redis,
    workflow.id,
    chatId,
    {
      messageId:
        existing.messageId,
      status:
        workflow.status,
      conclusion:
        workflow.conclusion ||
        null
    }
  );
}

// ================= MAIN =================

export default async function handler(
  req,
  res
) {
  try {
    const event =
      req.headers[
        "x-github-event"
      ];

    // GitHub webhook test
    if (event === "ping") {
      return res
        .status(200)
        .json({
          ok: true,
          pong: true
        });
    }

    const BOT_TOKEN =
      process.env.BOT_TOKEN;

    const CHAT_IDS = (
      process.env.CHAT_ID ||
      ""
    )
      .split(",")
      .map((v) =>
        v.trim()
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
      !SECRET ||
      !process.env.REDIS_URL
    ) {
      return res
        .status(500)
        .json({
          error:
            "Missing environment variables"
        });
    }

    // Signature validation
    const signature =
      req.headers[
        "x-hub-signature-256"
      ];

    const raw = JSON.stringify(
      req.body
    );

    const digest = `sha256=${crypto
      .createHmac(
        "sha256",
        SECRET
      )
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

    // Redis
    const redis =
      await getRedis();

    // Dedup
    const delivery =
      req.headers[
        "x-github-delivery"
      ] || "unknown";

    const action =
      req.body?.action ||
      "none";

    const eventKey = `${event}:${delivery}:${action}`;

    const duplicate =
      await isDuplicateEvent(
        redis,
        eventKey
      );

    if (duplicate) {
      return res
        .status(200)
        .json({
          duplicate: true
        });
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

      const compare =
        req.body.compare;

      let text = `🚀 Git Push

Repo: ${repo}
Branch: ${branch}

`;

      for (const c of commits) {
        text += `• ${c.author.name}: ${c.message}
${c.url}

`;
      }

      text += `View Push:
${compare}`;

      for (const chatId of CHAT_IDS) {
        await telegramRequest(
          BOT_TOKEN,
          "sendMessage",
          {
            chat_id: chatId,
            text,
            disable_web_page_preview:
              false
          }
        );
      }

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    // ================= WORKFLOW =================

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
        await upsertWorkflowMessage(
          redis,
          BOT_TOKEN,
          chatId,
          wf,
          message
        );
      }

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    return res
      .status(200)
      .json({
        ignored: true
      });
  } catch (error) {
    console.error(error);

    return res
      .status(500)
      .json({
        error:
          error.message ||
          "Internal Server Error"
      });
  }
}