GitHub → Telegram Webhook Notifier

A production-ready GitHub webhook listener built for Vercel that sends rich, deduplicated notifications to Telegram with Redis-backed persistence and workflow state tracking.

Supports push events, GitHub Actions, pull requests, issues, deployments, releases, security alerts, discussions, stars, forks, organization events, and more.


---

Features

Real-time GitHub → Telegram notifications

Redis-backed deduplication (Upstash Redis supported)

GitHub Actions workflow status tracking

Edits existing workflow messages instead of spamming

Multiple Telegram chats support

Silent low-priority notifications

Secure webhook signature validation

Supports repository and organization webhooks

Optimized for Vercel serverless runtime

Branch filtering

Repository filtering

Optional workflow name filtering

Thread/topic support for Telegram forums

Redis-backed admin sessions, pending edits, cached bot identity, and instant runtime event toggles

Group-safe Telegram admin bot command handling (ignores GIFs, stickers, and normal group chatter)

Security alert notifications

Pull request revert detection

Deployment status monitoring

PR review and discussion notifications



---

Supported GitHub Events

Repository Activity

Pushes

Branch/tag creation

Branch/tag deletion

Stars

Forks

Repository updates

Branch protection changes


Pull Requests

Opened

Merged

Closed

Reopened

Draft conversion

Review requests

Synchronization updates

Revert PR detection


GitHub Actions / CI

Workflow runs

Check runs

Check suites

Deployment statuses


Issues & Discussions

Issues

Issue comments

Discussions

Discussion comments

PR review comments

PR reviews


Releases & Deployments

Releases

Deployments

Deployment statuses


Security

Dependabot alerts

Secret scanning alerts

Code scanning alerts


Organization Events

Organization members

Teams

Membership changes



---

Architecture

GitHub Webhook
       ↓
Vercel Serverless Function
       ↓
Redis Deduplication Layer
       ↓
Telegram Bot API
       ↓
Telegram Chats / Groups / Topics


---

Requirements

Node.js 18+

Vercel account

Telegram bot

GitHub repository

Optional: Upstash Redis



---

Group Admin Bot Usage

The Telegram admin webhook is safe to add to groups and supergroups. It only responds to explicit commands from allowed admin users, such as `/start`, `/login`, `/menu`, `/help`, and `/cancel` (including addressed forms like `/menu@YourBot`). Non-text messages such as GIFs, stickers, photos, and regular group chatter are ignored so the bot does not reply accidentally.

Admin edit state is scoped by both user ID and chat ID, then stored in Redis when available, so editing config in one chat will not consume messages from another chat. Event toggle changes are written immediately to Redis runtime config and mirrored to Vercel env vars when Vercel credentials are configured.



---

Installation

1. Clone Repository

git clone https://github.com/yourusername/github-telegram-webhook.git
cd github-telegram-webhook


---

2. Install Dependencies

npm install redis


---

3. Create Telegram Bot

Open Telegram and message:

@BotFather

Create a new bot and obtain:

BOT_TOKEN


---

4. Get Telegram Chat ID

Add your bot to a group/channel/private chat.

Then open:

https://api.telegram.org/bot<BOT_TOKEN>/getUpdates

Find:

"chat": {
  "id": 123456789
}

Use that as:

CHAT_ID=123456789

Multiple chats supported:

CHAT_ID=123456789,-100987654321


---

Redis Setup (Recommended)

Upstash Redis

Create a database at:

Upstash Redis

Copy the Redis connection string:

REDIS_URL=rediss://default:password@host:port


---

Environment Variables

Create:

.env.local

Example:

BOT_TOKEN=123456:ABCDEF
CHAT_ID=123456789,-100987654321
WEBHOOK_SECRET=my_super_secret

REDIS_URL=rediss://default:password@host:port

ALLOWED_BRANCH=main
WORKFLOW_NAME_FILTER=deploy
ALLOWED_REPOS=owner/repo1,owner/repo2

ONLY_FAILURES=false
SILENT_LOW_PRIORITY=true

TELEGRAM_THREAD_ID=1234


---

Variable Reference

Variable	Required	Description

BOT_TOKEN	Yes	Telegram bot token
CHAT_ID	Yes	One or multiple Telegram chat IDs
WEBHOOK_SECRET	Yes	GitHub webhook secret
REDIS_URL	No	Upstash Redis URL
ALLOWED_BRANCH	No	Only process a specific branch
WORKFLOW_NAME_FILTER	No	Filter workflow names
ALLOWED_REPOS	No	Comma-separated allowed repositories
ONLY_FAILURES	No	Only notify failures
SILENT_LOW_PRIORITY	No	Silence stars/forks
TELEGRAM_THREAD_ID	No	Telegram topic/thread ID



---

Deploy to Vercel

1. Import Project

Go to:

Vercel Dashboard

Import your GitHub repository.


---

2. Add Environment Variables

In:

Project Settings → Environment Variables

Add all variables from .env.local.


---

3. Deploy

vercel --prod


---

GitHub Webhook Setup

Open:

Repository → Settings → Webhooks

Add webhook:

Setting	Value

Payload URL	https://yourdomain.vercel.app/api/github
Content Type	application/json
Secret	Same as WEBHOOK_SECRET
SSL Verification	Enable
Events	Send me everything



---

Organization Webhook Setup

For organization-level events:

Organization → Settings → Webhooks

Use the same URL and secret.


---

Telegram Topics / Forum Support

If using Telegram forum groups:

1. Create a topic


2. Send a message inside topic


3. Use:



getUpdates

Find:

"message_thread_id": 1234

Set:

TELEGRAM_THREAD_ID=1234


---

Security

Webhook Signature Validation

Every request is validated using:

X-Hub-Signature-256

with HMAC SHA256 verification.


---

Deduplication

Uses Redis NX writes to prevent duplicate processing:

github:dedup:<event>


---

Workflow State Tracking

Workflow messages are edited instead of creating spam:

Queued → Building → Success/Failure


---

Example Notifications

Push

🚀 Git Push

Repo: owner/repo
Branch: main

• user: Fix API bug
• user: Add Redis support


---

Pull Request

✅ Pull Request merged

Repo: owner/repo
Title: Add webhook support


---

Deployment

🚀 Deployment success

Environment: production


---

Security Alert

🚨 Dependabot Alert

Severity: high
Package: axios


---

Production Recommendations

Recommended

Use Redis

Enable webhook secret

Use repository filtering

Use branch filtering

Use silent notifications for stars/forks

Use Telegram topics for organization


Optional

Enable ONLY_FAILURES in noisy repositories

Separate production/staging chats

Add rate limiting

Add log aggregation



---

Scaling Notes

This project is optimized for:

Vercel serverless

Multiple repositories

Organization-wide monitoring

High event volume

Persistent workflow tracking


Redis significantly improves reliability under concurrent webhook bursts.


---

Troubleshooting

No Telegram Messages

Check:

Bot added to group

Bot has permission to send messages

Correct CHAT_ID

Correct BOT_TOKEN



---

Webhook Timeout

Usually caused by:

Redis connection issues

Telegram API timeout

Infinite retries


Ensure:

REDIS_URL

is valid.


---

Invalid Signature

Ensure:

WEBHOOK_SECRET

matches GitHub webhook secret exactly.


---

License

MIT License


---

Suggested Future Improvements

Slack/Discord support

Message templates

Database event history

GitHub App integration

Rate limiting

Admin dashboard

Analytics

Event routing rules

Per-chat subscriptions

Retry queues

Web UI



---

Tech Stack

Node.js

Vercel Serverless Functions

Redis / Upstash

Telegram Bot API

GitHub Webhooks



---

Credits

Built for production-grade GitHub repository monitoring with Telegram notifications.