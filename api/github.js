import crypto from "crypto";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const ALLOWED_BRANCH = process.env.ALLOWED_BRANCH || "main";

function verifySignature(reqBody, signature) {
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", SECRET);
  const digest = "sha256=" + hmac.update(reqBody).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const signature = req.headers["x-hub-signature-256"];
  const rawBody = JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const event = req.headers["x-github-event"];
  const payload = req.body;

  try {

    // ================= PUSH EVENT =================
    if (event === "push") {
      const branch = payload.ref.replace("refs/heads/", "");
      if (branch !== ALLOWED_BRANCH) return res.status(200).end();

      const repo = payload.repository.full_name;
      const pusher = payload.pusher.name;
      const commits = payload.commits.slice(-5);

      let commitText = commits.map(c => {
        return `• <b>${c.author.name}</b>\n${c.message}\n<a href="${c.url}">view commit</a>`;
      }).join("\n\n");

      const message = `
🚀 <b>Git Push</b>

<b>Repo:</b> ${repo}
<b>Branch:</b> ${branch}
<b>Pusher:</b> ${pusher}

<b>Commits:</b>
${commitText}
`;

      await sendTelegram(message);
    }

    // ================= WORKFLOW RESULT =================
    if (event === "workflow_run") {
      const wf = payload.workflow_run;

      const message = `
🤖 <b>Deployment Result</b>

<b>Repo:</b> ${payload.repository.full_name}
<b>Workflow:</b> ${wf.name}
<b>Branch:</b> ${wf.head_branch}
<b>Actor:</b> ${wf.actor.login}
<b>Status:</b> ${wf.conclusion}

<a href="${wf.html_url}">View details</a>
`;

      await sendTelegram(message);
    }

    res.status(200).end();

  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
}
