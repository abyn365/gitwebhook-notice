# GitHub → Telegram Webhook Notifier

A small Vercel app that receives GitHub webhooks and sends useful Telegram notifications. It supports Redis-backed deduplication, GitHub Actions status updates, Telegram groups/topics, and an optional Telegram admin bot for runtime configuration.

## What it does

- Sends GitHub events to one or more Telegram chats.
- Deduplicates deliveries with Redis when configured.
- Tracks GitHub Actions workflows and edits the same Telegram message as status changes.
- Filters by repository, branch, workflow name, failure-only mode, and disabled event types.
- Supports Telegram supergroups and forum topics through `CHAT_ID` entries.
- Includes an admin bot at `/api/bot` for status, testing, and editing runtime config.

## Project structure

```text
api/github.js  # GitHub webhook receiver
api/bot.js     # Telegram admin dashboard bot
```

## Requirements

- Node.js 18+
- Vercel project
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- GitHub repository or organization webhook
- Optional but recommended: Upstash Redis

## Quick setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather).
2. Create a bot.
3. Copy the bot token into `BOT_TOKEN`.
4. For group usage, also copy the bot username into `BOT_USERNAME` without `@`.

### 3. Find your chat ID

Add the bot to the target private chat, group, or channel, send a message, then open:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Use the returned `chat.id` as `CHAT_ID`.

Examples:

```env
CHAT_ID=123456789
CHAT_ID=123456789,-100987654321
```

For Telegram forum topics, append the topic/thread ID after the chat ID:

```env
CHAT_ID=-100987654321:1234
```

### 4. Configure environment variables

Set these in Vercel project settings.

```env
BOT_TOKEN=123456:ABCDEF
BOT_USERNAME=yourBotName
CHAT_ID=-100987654321
WEBHOOK_SECRET=change_me

# Recommended
REDIS_URL=rediss://default:password@host:port

# Optional filters
ALLOWED_REPOS=owner/repo1,owner/repo2
ALLOWED_BRANCH=main
WORKFLOW_NAME_FILTER=deploy
ONLY_FAILURES=false
SILENT_LOW_PRIORITY=true
DISABLED_EVENTS=

# Optional Telegram admin bot
ADMIN_USER_IDS=123456789
DASHBOARD_PASSWORD=change_me_too

# Optional: lets the admin bot mirror runtime edits back to Vercel env vars
VERCEL_TOKEN=
VERCEL_PROJECT_ID=
VERCEL_TEAM_ID=
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `BOT_TOKEN` | Yes | Telegram bot token. |
| `CHAT_ID` | Yes | One or more chat IDs, comma-separated. Use `chatId:threadId` for forum topics. |
| `WEBHOOK_SECRET` | Yes | Shared secret used by GitHub webhook signature validation and Telegram admin webhook secret token. |
| `BOT_USERNAME` | Recommended | Bot username without `@`; improves group command routing. |
| `REDIS_URL` | Recommended | Redis connection string. `UPSTASH_REDIS_URL` and `webhook_REDIS_URL` are also supported. |
| `ALLOWED_REPOS` | No | Comma-separated `owner/repo` allow-list. Empty means all repos. |
| `ALLOWED_BRANCH` | No | Only notify for one branch, for example `main`. |
| `WORKFLOW_NAME_FILTER` | No | Only notify workflows whose names include this text. |
| `ONLY_FAILURES` | No | Set to `true` to suppress successful/non-failure notifications. |
| `SILENT_LOW_PRIORITY` | No | Defaults to silent notifications for low-priority events unless set to `false`. |
| `DISABLED_EVENTS` | No | Comma-separated GitHub event names to ignore. |
| `ADMIN_USER_IDS` | Admin bot | Comma-separated Telegram user IDs allowed to use `/api/bot`. |
| `DASHBOARD_PASSWORD` | Admin bot | Password required after the user ID allow-list check. |
| `VERCEL_TOKEN` | Optional | Vercel token used to mirror admin edits to Vercel env vars. |
| `VERCEL_PROJECT_ID` | Optional | Vercel project ID for env var mirroring. |
| `VERCEL_TEAM_ID` | Optional | Vercel team ID, if the project belongs to a team. |

## Deploy to Vercel

1. Import this repository in Vercel.
2. Add the environment variables above.
3. Deploy the project.
4. Your GitHub webhook URL will be:

```text
https://<your-vercel-domain>/api/github
```

## GitHub webhook setup

In your repository or organization settings, create a webhook:

| Setting | Value |
| --- | --- |
| Payload URL | `https://<your-vercel-domain>/api/github` |
| Content type | `application/json` |
| Secret | Same value as `WEBHOOK_SECRET` |
| SSL verification | Enabled |
| Events | Send everything, or select only the events you want |

## Telegram admin bot

The admin bot lives at:

```text
https://<your-vercel-domain>/api/bot
```

Set its Telegram webhook:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-vercel-domain>/api/bot","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

Admin commands:

- `/start` or `/login` — authenticate.
- `/menu` or `/help` — open the dashboard.
- `/cancel` — cancel a pending edit.

In groups, use `/start <dashboard-password>` or `/login <dashboard-password>`. Plain password messages are ignored in groups so the bot does not react to normal chat messages.

### Runtime config behavior

Admin edits are saved to Redis runtime config first. If Vercel credentials are configured, the bot also mirrors the value to Vercel env vars.

Important: Vercel env vars are deployment-time values. If a value is mirrored to Vercel, the current deployment may still use the Redis runtime value until the project is redeployed or restarted.

## Supported events

Common supported events include:

- Pushes, branch/tag creates, branch/tag deletes
- Pull requests, reviews, review comments
- GitHub Actions workflow runs, check runs, check suites
- Issues and issue comments
- Discussions and discussion comments
- Releases and deployment statuses
- Stars, forks, repository events
- Dependabot, secret scanning, and code scanning alerts
- Organization member/team/membership events

## Troubleshooting

### `BOT_USERNAME` says recommended even though Vercel has it

Use the latest version of this repo. The dashboard should read the effective runtime value from Redis first, then fall back to `process.env`.

If it still looks wrong:

1. Check that Redis is connected in the admin dashboard.
2. Open the edit screen for `BOT_USERNAME` and confirm the current value.
3. Redeploy Vercel if you need the deployment-time `process.env.BOT_USERNAME` to update.

### No Telegram messages

Check:

- `BOT_TOKEN` is correct.
- The bot is in the chat and can send messages.
- `CHAT_ID` matches the target chat or topic.
- `WEBHOOK_SECRET` matches the GitHub webhook secret.
- Vercel function logs for Telegram API errors.

### Invalid GitHub signature

Make sure the GitHub webhook secret exactly matches `WEBHOOK_SECRET`.

### Duplicate or missing workflow updates

Use Redis. Without Redis, deduplication and workflow tracking fall back to process memory and are less reliable in serverless environments.

## License

MIT
