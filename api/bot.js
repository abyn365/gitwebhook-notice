/**
 * api/bot.js — Telegram admin dashboard bot
 *
 * Set your bot's webhook to: https://<your-vercel-url>/api/bot
 *   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
 *     -H "Content-Type: application/json" \
 *     -d '{"url":"https://<host>/api/bot","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
 *
 * Required env vars:
 *   BOT_TOKEN          — shared with github.js
 *   ADMIN_USER_IDS     — comma-separated Telegram user IDs allowed to use this bot
 *   DASHBOARD_PASSWORD — password required after user-ID check
 *
 * Recommended for group routing:
 *   BOT_USERNAME       — bot username without @, e.g. abyngithubBot
 *
 * Optional (for config editing):
 *   VERCEL_TOKEN       — Vercel API token
 *   VERCEL_PROJECT_ID  — Vercel project ID
 *   VERCEL_TEAM_ID     — Vercel team ID (if applicable)
 *
 * Optional (for activity log):
 *   REDIS_URL / UPSTASH_REDIS_URL — same as github.js
 */

import { createClient } from "redis";

export const config = { runtime: "nodejs" };

// ─── constants ───────────────────────────────────────────────────────────────

const SESSION_TTL_S      = 8 * 60 * 60;      // 8 hours
const SESSION_KEY        = (uid) => `admin:session:${uid}`;
const PENDING_KEY        = (uid, chatId) => `admin:pending_edit:${uid}:${chatId}`;
const LEGACY_PENDING_KEY = (uid) => `admin:pending_edit:${uid}`;
const ACTIVITY_KEY       = "github:activity_log";
const RUNTIME_CONFIG_KEY = "admin:runtime_config";

const ALL_EVENTS = [
  "push", "pull_request", "issues", "issue_comment", "workflow_run",
  "pull_request_review", "pull_request_review_comment",
  "discussion", "discussion_comment",
  "release", "deployment_status", "check_run", "check_suite",
  "watch", "fork", "create", "delete",
  "dependabot_alert", "secret_scanning_alert", "code_scanning_alert",
  "member", "membership", "team", "team_add", "repository",
];

const EDITABLE_KEYS = [
  "BOT_TOKEN", "BOT_USERNAME", "CHAT_ID", "WEBHOOK_SECRET", "REDIS_URL",
  "ALLOWED_REPOS", "ALLOWED_BRANCH", "WORKFLOW_NAME_FILTER",
  "ONLY_FAILURES", "SILENT_LOW_PRIORITY", "DISABLED_EVENTS",
];

const SENSITIVE = new Set(["BOT_TOKEN", "WEBHOOK_SECRET", "REDIS_URL"]);

// ─── env helpers ─────────────────────────────────────────────────────────────

const BOT_TOKEN      = () => process.env.BOT_TOKEN || "";
const ADMIN_PASSWORD = () => (process.env.DASHBOARD_PASSWORD || "").trim();
const VERCEL_TOKEN   = () => (process.env.VERCEL_TOKEN || "").trim();
const VERCEL_PROJECT = () => (process.env.VERCEL_PROJECT_ID || "").trim();
const VERCEL_TEAM    = () => (process.env.VERCEL_TEAM_ID || "").trim();
const BOT_USERNAME   = () => (process.env.BOT_USERNAME || "").trim().replace(/^@/, "");

// ─── group / command routing ──────────────────────────────────────────────────

const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);
const DIRECT_COMMANDS  = new Set(["start", "login", "menu", "help", "cancel"]);

// Cached bot username (populated from env or getMe API call)
let _botUsername = BOT_USERNAME() || null;

function isGroupChat(chat) {
  return GROUP_CHAT_TYPES.has(chat?.type);
}

/**
 * Parse a Telegram bot command, including optional @BotName suffix and arguments.
 * Returns null if the text is not a command.
 */
function parseCommand(text = "") {
  const match = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name:   match[1].toLowerCase(),
    target: match[2]?.toLowerCase() || null,
    args:   (match[3] || "").trim(),
  };
}

function knownBotUsername() {
  return (BOT_USERNAME() || _botUsername || "").toLowerCase();
}

/**
 * Returns true if this command is one of our direct commands AND is either
 * un-addressed or addressed to this bot specifically.
 */
function isDirectCommandForThisBot(command) {
  if (!command || !DIRECT_COMMANDS.has(command.name)) return false;
  if (!command.target) return true;                  // /start (no @mention)
  const known = knownBotUsername();
  // If we don't know the username yet, trust Telegram's routing
  return known ? command.target === known : true;
}

/**
 * Resolve and cache the bot's username via getMe if not already known.
 * Called lazily so it never blocks the main request path.
 */
async function ensureBotUsername() {
  if (_botUsername || !BOT_TOKEN()) return _botUsername;
  try {
    // Fast path: BOT_USERNAME env var is set
    const envName = BOT_USERNAME();
    if (envName) {
      _botUsername = envName;
      return _botUsername;
    }

    // Prefer Redis runtime config when the current deployment has not been
    // restarted/redeployed with the mirrored Vercel env var yet.
    const runtimeName = (await getRuntimeConfig("BOT_USERNAME"))?.trim().replace(/^@/, "");
    if (runtimeName) {
      _botUsername = runtimeName;
      return _botUsername;
    }

    // Try Redis cache before hitting the API
    const redis = await getRedis();
    const cached = await redis?.get("admin:bot_username").catch(() => null);
    if (cached) {
      _botUsername = cached;
      return _botUsername;
    }

    // Fall back to getMe
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN()}/getMe`,
      { signal: AbortSignal.timeout(2_000) }
    );
    const d = await r.json();
    if (d.ok && d.result?.username) {
      _botUsername = d.result.username;
      await redis?.set("admin:bot_username", _botUsername, { EX: 24 * 60 * 60 }).catch(() => {});
    }
  } catch {
    // Non-fatal — will retry next invocation
  }
  return _botUsername;
}

// ─── admin user list ──────────────────────────────────────────────────────────

function getAdminUserIds() {
  return (process.env.ADMIN_USER_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean).map(Number).filter(Boolean);
}

function isAllowedUser(userId) {
  const ids = getAdminUserIds();
  return ids.length > 0 && ids.includes(userId);
}

// ─── redis ────────────────────────────────────────────────────────────────────

let _redis          = null;
let _redisPromise   = null;
let _redisDisabledUntil = 0;

const REDIS_CONNECT_TIMEOUT_MS = 1200;
const REDIS_COOLDOWN_MS        = 60_000;

function disableRedis() {
  _redisDisabledUntil = Date.now() + REDIS_COOLDOWN_MS;
  _redis = null;
}

async function getRedis() {
  const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.webhook_REDIS_URL;
  if (!url) return null;
  if (Date.now() < _redisDisabledUntil) return null;
  if (_redis?.isOpen) return _redis;

  if (!_redis) {
    _redis = createClient({ url });
    _redis.on("error", e => {
      console.error("Redis:", e);
      disableRedis();
    });
  }

  if (!_redisPromise) {
    _redisPromise = (async () => {
      try {
        await Promise.race([
          _redis.connect(),
          new Promise((_, r) => setTimeout(() => r(new Error("timeout")), REDIS_CONNECT_TIMEOUT_MS)),
        ]);
      } catch (err) {
        console.error("Redis connect failed:", err?.message || err);
        disableRedis();
      } finally {
        _redisPromise = null;
      }
    })();
  }

  await _redisPromise;
  return _redis?.isOpen ? _redis : null;
}

// ─── session (Redis-backed, in-memory fallback) ───────────────────────────────

const _memSessions = new Map();

async function isAuthenticated(userId) {
  const exp = _memSessions.get(userId);
  if (exp && Date.now() < exp) return true;

  const redis = await getRedis();
  if (redis) {
    const v = await redis.get(SESSION_KEY(userId)).catch(() => null);
    return v === "1";
  }
  return false;
}

async function setAuthenticated(userId) {
  _memSessions.set(userId, Date.now() + SESSION_TTL_S * 1000);
  const redis = await getRedis();
  if (redis) {
    await redis.set(SESSION_KEY(userId), "1", { EX: SESSION_TTL_S }).catch(() => {});
  }
}

async function clearAuthenticated(userId) {
  _memSessions.delete(userId);
  const redis = await getRedis();
  if (redis) {
    await redis.del(SESSION_KEY(userId)).catch(() => {});
  }
}

// ─── pending edit state ───────────────────────────────────────────────────────

const _memPending = new Map();

function pendingMemoryKey(userId, chatId) {
  return `${userId}:${chatId}`;
}

async function setPending(userId, chatId, data) {
  const val = JSON.stringify(data);
  _memPending.set(pendingMemoryKey(userId, chatId), { data, exp: Date.now() + 300_000 });
  const redis = await getRedis();
  if (redis) await redis.set(PENDING_KEY(userId, chatId), val, { EX: 300 }).catch(() => {});
}

async function getPending(userId, chatId) {
  const entry = _memPending.get(pendingMemoryKey(userId, chatId));
  if (entry && Date.now() <= entry.exp) return entry.data;

  const redis = await getRedis();
  if (redis) {
    const v = await redis.get(PENDING_KEY(userId, chatId)).catch(() => null);
    if (v) return JSON.parse(v);

    // Backward compat: edits started before per-chat scoping was added
    const legacy = await redis.get(LEGACY_PENDING_KEY(userId)).catch(() => null);
    return legacy ? JSON.parse(legacy) : null;
  }
  return null;
}

async function clearPending(userId, chatId) {
  _memPending.delete(pendingMemoryKey(userId, chatId));
  const redis = await getRedis();
  if (redis) {
    await redis.del([PENDING_KEY(userId, chatId), LEGACY_PENDING_KEY(userId)]).catch(() => {});
  }
}

// ─── runtime config (Redis hash) ─────────────────────────────────────────────

async function setRuntimeConfig(key, value) {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    await redis.hSet(RUNTIME_CONFIG_KEY, key, value);
    return true;
  } catch {
    return false;
  }
}

async function getRuntimeConfig(key) {
  const redis = await getRedis();
  if (!redis) return null;
  return redis.hGet(RUNTIME_CONFIG_KEY, key).catch(() => null);
}

async function getRuntimeConfigValues(keys) {
  const redis = await getRedis();
  if (!redis) return {};

  const values = await redis.hmGet(RUNTIME_CONFIG_KEY, keys).catch(() => null);
  if (!Array.isArray(values)) return {};

  return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null]));
}

function hasVercelConfig() {
  return !!(VERCEL_TOKEN() && VERCEL_PROJECT());
}

function valueIsSet(value) {
  return value !== undefined && value !== null && value !== "";
}

async function getEffectiveConfig(key) {
  const stored = await getRuntimeConfig(key);
  return stored ?? process.env[key] ?? "";
}

async function getEffectiveConfigValues(keys) {
  const stored = await getRuntimeConfigValues(keys);
  return Object.fromEntries(keys.map((key) => [key, stored[key] ?? process.env[key] ?? ""]));
}

async function mirrorConfigToVercel(key, value) {
  if (value === "") {
    await vercelDeleteEnv(key);
  } else {
    await vercelUpsertEnv(key, value);
  }
}

function queueVercelMirror(key, value, chatId = null) {
  if (!hasVercelConfig()) return false;

  const task = mirrorConfigToVercel(key, value).catch(err => {
    console.error(`Vercel mirror failed for ${key}:`, err?.message || err);
    if (chatId) {
      return send(chatId, `⚠️ Vercel mirror failed for <b>${esc(key)}</b>: ${esc(err?.message || err)}`).catch(() => {});
    }
    return null;
  });
  if (typeof globalThis.waitUntil === "function") globalThis.waitUntil(task);
  return true;
}

async function saveConfigValue(key, value, { awaitMirror = false, mirrorErrorChatId = null } = {}) {
  const savedToRedis = await setRuntimeConfig(key, value);
  process.env[key] = value;

  if (!hasVercelConfig()) {
    return { savedToRedis, mirroredToVercel: false, mirrorQueued: false, vercelError: null };
  }

  if (!awaitMirror) {
    const mirrorQueued = queueVercelMirror(key, value, mirrorErrorChatId);
    return { savedToRedis, mirroredToVercel: false, mirrorQueued, vercelError: null };
  }

  try {
    await mirrorConfigToVercel(key, value);
    return { savedToRedis, mirroredToVercel: true, mirrorQueued: false, vercelError: null };
  } catch (err) {
    return { savedToRedis, mirroredToVercel: false, mirrorQueued: false, vercelError: err };
  }
}

async function getRedisStats() {
  const redis = await getRedis();
  if (!redis) return { configured: false, keyCount: null };
  const keyCount = await redis.dbSize().catch(() => null);
  return { configured: true, keyCount };
}

async function getDisabledEvents() {
  const stored = await getRuntimeConfig("DISABLED_EVENTS");
  const raw = stored ?? process.env.DISABLED_EVENTS ?? "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// ─── activity log ─────────────────────────────────────────────────────────────

async function getActivityLog(limit = 15) {
  const redis = await getRedis();
  if (!redis) return null;
  const raw = await redis.lRange(ACTIVITY_KEY, 0, limit - 1).catch(() => []);
  return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return r.json();
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function edit(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
}

async function answerCallback(callbackQueryId, text = "") {
  return tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function kb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

// ─── Vercel API ───────────────────────────────────────────────────────────────

function vercelEnvsUrl() {
  const base = `https://api.vercel.com/v10/projects/${VERCEL_PROJECT()}/env`;
  const team = VERCEL_TEAM();
  return team ? `${base}?teamId=${team}` : base;
}

async function vercelFetchEnvs() {
  const r = await fetch(vercelEnvsUrl(), {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`Vercel ${r.status}`);
  const d = await r.json();
  return d.envs || [];
}

async function vercelUpsertEnv(key, value) {
  const envs = await vercelFetchEnvs();
  const existing = envs.find(e => e.key === key);
  const team = VERCEL_TEAM();
  const proj = VERCEL_PROJECT();
  const qs = team ? `?teamId=${team}` : "";

  if (existing) {
    const r = await fetch(
      `https://api.vercel.com/v10/projects/${proj}/env/${existing.id}${qs}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${VERCEL_TOKEN()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value, target: existing.target || ["production", "preview", "development"] }),
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!r.ok) throw new Error(`Vercel PATCH ${r.status}: ${await r.text()}`);
  } else {
    const r = await fetch(
      `https://api.vercel.com/v10/projects/${proj}/env${qs}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${VERCEL_TOKEN()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, type: "encrypted", target: ["production", "preview", "development"] }),
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!r.ok) throw new Error(`Vercel POST ${r.status}: ${await r.text()}`);
  }
}

async function vercelDeleteEnv(key) {
  const envs = await vercelFetchEnvs();
  const existing = envs.find(e => e.key === key);
  if (!existing) return;
  const team = VERCEL_TEAM();
  const proj = VERCEL_PROJECT();
  const qs = team ? `?teamId=${team}` : "";
  const r = await fetch(
    `https://api.vercel.com/v10/projects/${proj}/env/${existing.id}${qs}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${VERCEL_TOKEN()}` },
      signal: AbortSignal.timeout(8_000),
    }
  );
  if (!r.ok) throw new Error(`Vercel DELETE ${r.status}`);
}

// ─── formatting helpers ───────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dot(ok) { return ok ? "🟢" : "🔴"; }

async function configSummary() {
  const cfg = await getEffectiveConfigValues([
    "BOT_TOKEN",
    "BOT_USERNAME",
    "CHAT_ID",
    "WEBHOOK_SECRET",
    "REDIS_URL",
    "ALLOWED_REPOS",
    "ALLOWED_BRANCH",
    "WORKFLOW_NAME_FILTER",
    "ONLY_FAILURES",
    "SILENT_LOW_PRIORITY",
    "DISABLED_EVENTS",
  ]);
  const botUsername = (cfg.BOT_USERNAME || "").trim().replace(/^@/, "");
  const chatRaw  = cfg.CHAT_ID || "";
  const chats    = chatRaw.split(",").map(s => s.trim()).filter(Boolean);
  const repos    = cfg.ALLOWED_REPOS || "—";
  const branch   = cfg.ALLOWED_BRANCH || "—";
  const wfFilter = cfg.WORKFLOW_NAME_FILTER || "—";
  const onlyFail = cfg.ONLY_FAILURES === "true";
  const silent   = cfg.SILENT_LOW_PRIORITY !== "false";
  const disabled = (cfg.DISABLED_EVENTS || "").split(",").map(s => s.trim()).filter(Boolean);
  const hasRedis = !!(cfg.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.webhook_REDIS_URL);

  return `<b>⚙️ Current Configuration</b>

${dot(!!cfg.BOT_TOKEN)} <b>BOT_TOKEN</b>: ${cfg.BOT_TOKEN ? "configured" : "missing"}
${dot(!!botUsername)} <b>BOT_USERNAME</b>: ${botUsername ? `<code>${esc(botUsername)}</code>` : "recommended for groups"}
${dot(chats.length > 0)} <b>CHAT_ID</b>: ${chats.length ? chats.map(c => `<code>${esc(c)}</code>`).join(", ") : "missing"}
${dot(!!cfg.WEBHOOK_SECRET)} <b>WEBHOOK_SECRET</b>: ${cfg.WEBHOOK_SECRET ? "configured" : "missing"}
${dot(hasRedis)} <b>Redis</b>: ${hasRedis ? "connected" : "in-memory fallback"}

<b>Filters</b>
• Repos: <code>${esc(repos)}</code>
• Branch: <code>${esc(branch)}</code>
• Workflow: <code>${esc(wfFilter)}</code>

<b>Behaviour</b>
• Only failures: ${onlyFail ? "yes" : "no"}
• Silent low-priority: ${silent ? "yes" : "no"}
• Disabled events: ${disabled.length ? disabled.map(e => `<code>${esc(e)}</code>`).join(", ") : "none"}`;
}

function statusSummary(botInfo, webhookInfo, stats = {}) {
  const env = {
    hasBot:    !!process.env.BOT_TOKEN,
    hasChatId: !!(process.env.CHAT_ID || "").trim(),
    hasSecret: !!process.env.WEBHOOK_SECRET,
    hasRedis:  !!(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.webhook_REDIS_URL),
    hasVercel: hasVercelConfig(),
  };

  let out = `<b>📊 Status</b>\n\n`;

  if (botInfo) {
    out += `🤖 <b>@${esc(botInfo.username)}</b> — ${esc(botInfo.first_name)}\n`;
    out += `   ID: <code>${botInfo.id}</code>\n\n`;
  } else {
    out += `🤖 Bot: ${env.hasBot ? "token set but unreachable" : "not configured"}\n\n`;
  }

  out += `${dot(env.hasBot)}    BOT_TOKEN\n`;
  out += `${dot(env.hasChatId)} CHAT_ID\n`;
  out += `${dot(env.hasSecret)} WEBHOOK_SECRET\n`;
  out += `${dot(env.hasRedis)}  Redis\n`;
  out += `${dot(env.hasVercel)} Vercel API (optional config mirror)\n`;

  const uptimeSeconds = Math.floor(process.uptime());
  const uptime = uptimeSeconds < 3600
    ? `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`
    : `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`;
  const redisKeys = stats.redis?.keyCount === null || stats.redis?.keyCount === undefined
    ? (stats.redis?.configured ? "unavailable" : "Redis unavailable")
    : String(stats.redis.keyCount);
  out += `\n<b>📊 Stats</b>\n`;
  out += `Redis keys: <code>${esc(redisKeys)}</code>\n`;
  out += `Uptime: <code>${esc(uptime)}</code>\n`;

  if (webhookInfo?.url) {
    const pending = webhookInfo.pending_update_count ?? 0;
    const err = webhookInfo.last_error_message;
    out += `\n<b>Webhook</b>\n`;
    out += `<code>${esc(webhookInfo.url)}</code>\n`;
    out += `Pending: ${pending}`;
    if (err) out += `\n⚠️ Last error: ${esc(err)}`;
  }

  return out;
}

function activitySummary(log) {
  if (!log) return "⚠️ Activity log requires Redis. No Redis is configured.";
  if (!log.length) return "📭 No recent activity recorded yet.";

  const lines = log.map(entry => {
    const ago    = timeAgo(entry.ts);
    const repo   = entry.repo ? ` — <code>${esc(entry.repo)}</code>` : "";
    const action = entry.action ? `/${esc(entry.action)}` : "";
    return `• <b>${esc(entry.event)}${action}</b>${repo} <i>${ago}</i>`;
  });

  return `<b>📋 Recent Activity</b> (last ${log.length})\n\n` + lines.join("\n");
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── menus ────────────────────────────────────────────────────────────────────

function mainMenu() {
  return kb([
    [{ text: "📊 Status",       callback_data: "status"   },
     { text: "⚙️ Config",       callback_data: "config"   }],
    [{ text: "📋 Activity Log", callback_data: "activity" },
     { text: "🔔 Events",       callback_data: "events"   }],
    [{ text: "✏️ Edit Config",  callback_data: "edit"     },
     { text: "📨 Test Message", callback_data: "test"     }],
    [{ text: "🔒 Sign out",     callback_data: "logout"   }],
  ]);
}

function backMenu(target = "home") {
  return kb([[{ text: "← Back", callback_data: target }]]);
}

function editMenu() {
  const rows = [];
  const keys = EDITABLE_KEYS.filter(k => !["ONLY_FAILURES", "SILENT_LOW_PRIORITY", "DISABLED_EVENTS"].includes(k));
  for (let i = 0; i < keys.length; i += 2) {
    const row = [{ text: keys[i], callback_data: `edit_key:${keys[i]}` }];
    if (keys[i + 1]) row.push({ text: keys[i + 1], callback_data: `edit_key:${keys[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "🔁 Toggle ONLY_FAILURES",      callback_data: "toggle:ONLY_FAILURES"      }]);
  rows.push([{ text: "🔁 Toggle SILENT_LOW_PRIORITY", callback_data: "toggle:SILENT_LOW_PRIORITY" }]);
  rows.push([{ text: "← Back", callback_data: "home" }]);
  return kb(rows);
}

function eventsMenu(disabled = new Set()) {
  const rows = [];
  for (let i = 0; i < ALL_EVENTS.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, ALL_EVENTS.length); j++) {
      const ev  = ALL_EVENTS[j];
      const off = disabled.has(ev);
      row.push({ text: `${off ? "🔴" : "🟢"} ${ev}`, callback_data: `ev_toggle:${ev}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "← Back", callback_data: "home" }]);
  return kb(rows);
}

function authPromptText(groupChat = false) {
  const command = groupChat ? "/start &lt;password&gt;" : "your dashboard password";
  return `🔐 <b>gh-notify Admin</b>\n\nYou're on the allow-list. Enter ${command} to continue.`;
}

// ─── handlers ─────────────────────────────────────────────────────────────────

async function handleAuth(chatId, userId, text) {
  const password = ADMIN_PASSWORD();

  if (!password) {
    await send(chatId, "⚠️ <b>DASHBOARD_PASSWORD</b> is not set. Configure it in your Vercel environment variables.");
    return;
  }

  if (text.trim() !== password) {
    await send(chatId, "❌ Wrong password. Try again.");
    return;
  }

  await setAuthenticated(userId);
  await send(
    chatId,
    `✅ <b>Authenticated.</b> Session valid for 8 hours.\n\nUse the menu below to manage your webhook.`,
    mainMenu()
  );
}

async function handleHome(chatId, messageId = null) {
  const text = "🏠 <b>gh-notify Admin</b>\n\nWhat would you like to do?";
  if (messageId) {
    await edit(chatId, messageId, text, mainMenu());
  } else {
    await send(chatId, text, mainMenu());
  }
}

async function handleStatus(chatId, messageId) {
  let botInfo     = null;
  let webhookInfo = null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getMe`, { signal: AbortSignal.timeout(5_000) });
    const d = await r.json();
    if (d.ok) botInfo = d.result;
  } catch {}
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/getWebhookInfo`, { signal: AbortSignal.timeout(5_000) });
    const d = await r.json();
    if (d.ok) webhookInfo = d.result;
  } catch {}

  const stats = { redis: await getRedisStats() };
  await edit(chatId, messageId, statusSummary(botInfo, webhookInfo, stats), kb([
    [{ text: "🔄 Reload", callback_data: "status" }],
    [{ text: "← Back", callback_data: "home" }],
  ]));
}

async function handleConfig(chatId, messageId) {
  await edit(chatId, messageId, await configSummary(), backMenu("home"));
}

async function handleActivity(chatId, messageId) {
  const log = await getActivityLog(15);
  await edit(chatId, messageId, activitySummary(log), backMenu("home"));
}

async function handleEvents(chatId, messageId) {
  const disabled = await getDisabledEvents();
  const text = `<b>🔔 Event Toggles</b>\n\n🟢 = enabled (will notify)  🔴 = disabled\n\n<b>Disabled events:</b> ${disabled.size ? [...disabled].map(e => `<code>${esc(e)}</code>`).join(", ") : "none"}\n\n<i>Tap an event to toggle it on/off. Changes are saved immediately in Redis and mirrored to Vercel when configured.</i>`;
  await edit(chatId, messageId, text, eventsMenu(disabled));
}

async function handleToggleEvent(chatId, messageId, callbackId, eventName) {
  const disabled  = await getDisabledEvents();

  if (disabled.has(eventName)) {
    disabled.delete(eventName);
  } else {
    disabled.add(eventName);
  }

  const newValue = [...disabled].join(",");
  const result = await saveConfigValue("DISABLED_EVENTS", newValue, { mirrorErrorChatId: chatId });

  if (result.savedToRedis) {
    await answerCallback(callbackId, disabled.has(eventName) ? `🔴 ${eventName} disabled` : `🟢 ${eventName} enabled`);
  } else {
    await answerCallback(callbackId, `⚠️ Temporary — Redis not configured`);
  }

  await handleEvents(chatId, messageId);
}

async function handleEditMenu(chatId, messageId) {
  const mirrorText = hasVercelConfig()
    ? "Changes are saved to Redis runtime config and mirrored to Vercel."
    : "⚠️ <b>Redis-only mode:</b> Vercel is not configured, so changes are saved only to Redis runtime config (or process memory if Redis is unavailable).";
  await edit(
    chatId, messageId,
    `✏️ <b>Edit Config</b>

${mirrorText}

Select a variable to update. Sensitive values (token, secret) are write-only.`,
    editMenu()
  );
}

async function handleEditKey(chatId, messageId, userId, key) {
  await setPending(userId, chatId, { key, promptMessageId: messageId });
  const isSensitive = SENSITIVE.has(key);
  const effective = await getEffectiveConfig(key);
  const current = isSensitive
    ? (valueIsSet(effective) ? "(hidden)" : "(not set)")
    : (valueIsSet(effective) ? `<code>${esc(effective)}</code>` : "(not set)");
  const saveMode = hasVercelConfig()
    ? "Saved first to Redis runtime config, then mirrored to Vercel."
    : "⚠️ Redis-only mode: Vercel is not configured, so this will not update Vercel environment variables.";

  await edit(
    chatId, messageId,
    `✏️ <b>Editing: ${esc(key)}</b>

Current value: ${current}

<i>${saveMode}</i>

Send the new value as a message, or send <code>-</code> to clear it. You will be asked to confirm clearing.

Send /cancel to abort.`,
    kb([[{ text: "Cancel", callback_data: "edit" }]])
  );
}

async function handleToggle(chatId, messageId, callbackId, key) {
  const currentValue = await getEffectiveConfig(key);
  const current = currentValue === "true";
  const newVal  = current ? "false" : "true";
  const result = await saveConfigValue(key, newVal, { mirrorErrorChatId: chatId });

  if (result.vercelError) {
    await answerCallback(callbackId, `Saved in Redis; Vercel error: ${result.vercelError.message}`);
  } else if (result.savedToRedis) {
    await answerCallback(callbackId, result.mirrorQueued ? `${key} → ${newVal}; Vercel mirror queued` : `${key} → ${newVal}`);
  } else {
    await answerCallback(callbackId, `⚠️ Temporary — Redis not configured`);
  }

  await handleEditMenu(chatId, messageId);
}

async function handlePendingEdit(chatId, messageId, userId, text) {
  const pending = await getPending(userId, chatId);
  if (!pending) return false; // not in edit mode

  const command = parseCommand(text);
  if ((command?.name === "cancel" && isDirectCommandForThisBot(command)) || text.toLowerCase() === "cancel") {
    await clearPending(userId, chatId);
    await send(chatId, "❌ Edit cancelled.", mainMenu());
    return true;
  }

  const { key } = pending;
  const trimmed = text.trim();

  if (trimmed === "-" && !pending.confirmClear) {
    await setPending(userId, chatId, { ...pending, confirmClear: true });
    await send(
      chatId,
      `⚠️ Clear <b>${esc(key)}</b>?

Send <code>-</code> again to confirm, or send /cancel to abort.`,
      kb([[{ text: "Cancel", callback_data: "edit" }]])
    );
    return true;
  }

  await clearPending(userId, chatId);
  const newValue = trimmed === "-" && pending.confirmClear ? "" : trimmed;

  await send(chatId, `💾 Saving <b>${esc(key)}</b>…`);

  const result = await saveConfigValue(key, newValue, { mirrorErrorChatId: chatId });
  const display = SENSITIVE.has(key) && newValue ? "••••••••" : `<code>${esc(newValue || "(cleared)")}</code>`;
  let suffix = "";
  if (result.vercelError) {
    suffix = `\n⚠️ Saved to Redis runtime config, but Vercel mirror failed: ${esc(result.vercelError.message)}`;
  } else if (result.mirroredToVercel) {
    suffix = "\n🔁 Mirrored to Vercel.";
  } else if (result.mirrorQueued) {
    suffix = "\n🔁 Vercel mirror queued.";
  } else if (result.savedToRedis) {
    suffix = "\n💾 Saved to Redis runtime config.";
  } else {
    suffix = "\n⚠️ Redis is unavailable; saved only for this running process.";
  }

  await send(chatId, `✅ <b>${esc(key)}</b> updated to ${display}${suffix}`, mainMenu());
  return true;
}

async function handleTest(chatId, messageId) {
  const chatRaw = await getEffectiveConfig("CHAT_ID");
  const targets = chatRaw.split(",").map(s => s.trim()).filter(Boolean);

  if (!targets.length) {
    await edit(chatId, messageId,
      "⚠️ No CHAT_ID configured — nowhere to send the test message.",
      backMenu("home")
    );
    return;
  }

  await edit(chatId, messageId, `📨 Sending test message to ${targets.length} chat(s)…`, backMenu("home"));

  const msg = `🧪 <b>gh-notify test message</b>\n\nIf you see this, your Telegram integration is working correctly.\n\n<i>Sent from admin bot</i>`;
  let ok = 0, fail = 0;

  for (const entry of targets) {
    const colonIdx = entry.lastIndexOf(":");
    let targetChatId = entry, threadId = null;
    if (colonIdx > 1) {
      const tid = Number(entry.slice(colonIdx + 1));
      if (Number.isFinite(tid) && tid > 0) {
        targetChatId = entry.slice(0, colonIdx);
        threadId = tid;
      }
    }
    try {
      const payload = { chat_id: targetChatId, text: msg, parse_mode: "HTML", disable_web_page_preview: true };
      if (threadId) payload.message_thread_id = threadId;
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      const d = await r.json();
      if (d.ok) { ok++; } else { fail++; console.error("Test send failed:", d); }
    } catch (e) {
      fail++;
      console.error("Test send error:", e);
    }
  }

  const result = fail === 0
    ? `✅ Test message delivered to all ${ok} chat(s).`
    : `⚠️ Delivered to ${ok}/${targets.length} chats. ${fail} failed — check logs.`;

  await send(chatId, result, mainMenu());
}

// ─── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Verify the request comes from Telegram using the secret token header.
  // Set this when calling setWebhook: ?secret_token=<WEBHOOK_SECRET>
  const secretHeader  = req.headers["x-telegram-bot-api-secret-token"];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secretHeader !== expectedSecret) {
    return res.status(401).end();
  }

  // Resolve bot username early (non-blocking) so group command routing works.
  ensureBotUsername().catch(() => {});

  try {
    const update = req.body;

    // ── callback query (button press) ──────────────────────────────────────
    if (update.callback_query) {
      const cq        = update.callback_query;
      const userId    = cq.from.id;
      const chatId    = cq.message.chat.id;
      const messageId = cq.message.message_id;
      const data      = cq.data;

      if (!isAllowedUser(userId)) {
        await answerCallback(cq.id, "⛔ Not authorized.");
        return res.status(200).end();
      }
      if (!(await isAuthenticated(userId))) {
        await answerCallback(cq.id, "🔒 Session expired. Send /start to log in again.");
        return res.status(200).end();
      }

      await answerCallback(cq.id);

      if (data === "home")     { await handleHome(chatId, messageId);     return res.status(200).end(); }
      if (data === "status")   { await handleStatus(chatId, messageId);   return res.status(200).end(); }
      if (data === "config")   { await handleConfig(chatId, messageId);   return res.status(200).end(); }
      if (data === "activity") { await handleActivity(chatId, messageId); return res.status(200).end(); }
      if (data === "events")   { await handleEvents(chatId, messageId);   return res.status(200).end(); }
      if (data === "edit")     { await handleEditMenu(chatId, messageId); return res.status(200).end(); }
      if (data === "test")     { await handleTest(chatId, messageId);     return res.status(200).end(); }

      if (data === "logout") {
        await clearAuthenticated(userId);
        await edit(chatId, messageId, "🔒 Signed out. Send /start to log in again.");
        return res.status(200).end();
      }

      if (data.startsWith("edit_key:")) {
        const key = data.slice("edit_key:".length);
        if (EDITABLE_KEYS.includes(key)) await handleEditKey(chatId, messageId, userId, key);
        return res.status(200).end();
      }

      if (data.startsWith("toggle:")) {
        const key = data.slice("toggle:".length);
        if (["ONLY_FAILURES", "SILENT_LOW_PRIORITY"].includes(key)) {
          await handleToggle(chatId, messageId, cq.id, key);
        }
        return res.status(200).end();
      }

      if (data.startsWith("ev_toggle:")) {
        const ev = data.slice("ev_toggle:".length);
        if (ALL_EVENTS.includes(ev)) await handleToggleEvent(chatId, messageId, cq.id, ev);
        return res.status(200).end();
      }

      return res.status(200).end();
    }

    // ── message ────────────────────────────────────────────────────────────
    if (update.message) {
      const msg       = update.message;
      const userId    = msg.from?.id;
      const chatId    = msg.chat.id;
      const text      = typeof msg.text === "string" ? msg.text.trim() : "";
      const command   = parseCommand(text);
      const groupChat = isGroupChat(msg.chat);

      const directCommand = isDirectCommandForThisBot(command);

      // Ignore GIFs, stickers, photos, and empty messages.
      if (!text) {
        return res.status(200).end();
      }

      // Reject unauthorised users (stay silent in groups unless they sent a command)
      if (!isAllowedUser(userId)) {
        if (!groupChat || directCommand) {
          await send(chatId, "⛔ You are not authorized to use this bot.");
        }
        return res.status(200).end();
      }

      // In groups, ordinary text is normally ignored, but a pending config edit
      // is allowed to consume the user's next message as the new value.
      if (groupChat && !directCommand) {
        if (await isAuthenticated(userId)) {
          const handled = await handlePendingEdit(chatId, msg.message_id, userId, text);
          if (handled) return res.status(200).end();
        }
        return res.status(200).end();
      }

      // ── /start or /login ────────────────────────────────────────────────
      if (directCommand && (command.name === "start" || command.name === "login")) {
        const authenticated = await isAuthenticated(userId);
        if (authenticated) {
          await send(chatId, "✅ You're already signed in.", mainMenu());
        } else if (command.args) {
          await handleAuth(chatId, userId, command.args);
        } else {
          await send(chatId, authPromptText(groupChat));
        }
        return res.status(200).end();
      }

      // ── /cancel ─────────────────────────────────────────────────────────
      if (directCommand && command.name === "cancel") {
        await clearPending(userId, chatId);
        await send(chatId, "❌ Cancelled.", mainMenu());
        return res.status(200).end();
      }

      const authenticated = await isAuthenticated(userId);

      // ── /menu or /help ───────────────────────────────────────────────────
      if (directCommand && (command.name === "menu" || command.name === "help")) {
        if (!authenticated) {
          await send(chatId, authPromptText(groupChat));
          return res.status(200).end();
        }
        await handleHome(chatId);
        return res.status(200).end();
      }

      // Not authenticated — only private messages are treated as password attempts
      if (!authenticated) {
        if (!groupChat) await handleAuth(chatId, userId, text);
        return res.status(200).end();
      }

      // Authenticated — check for a pending config edit
      const handled = await handlePendingEdit(chatId, msg.message_id, userId, text);
      if (handled) return res.status(200).end();

      // Fallback: guide the user in private chat, stay silent in groups
      if (!groupChat) {
        await send(chatId, "Use the menu to navigate.", mainMenu());
      }
      return res.status(200).end();
    }

    // Unknown update type — acknowledge it so Telegram doesn't retry
    return res.status(200).end();

  } catch (err) {
    console.error("Bot handler error:", err);
    if (!res.headersSent) {
      res.status(200).end(); // Always 200 to Telegram — never let it retry on our errors
    }
  }
}
