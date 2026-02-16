import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

app.post("/github-webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (event === "push") {
    const repo = payload.repository.full_name;
    const pusher = payload.pusher.name;
    const branch = payload.ref.replace("refs/heads/", "");
    const commits = payload.commits;

    let commitText = commits.map(c => {
      return `• <b>${c.author.name}</b>\n${c.message}\n<a href="${c.url}">view commit</a>`;
    }).join("\n\n");

    const text = `
🚀 <b>GitHub Push Detected</b>

<b>Repo:</b> ${repo}
<b>Branch:</b> ${branch}
<b>Pusher:</b> ${pusher}

<b>Commits:</b>
${commitText}
    `;

    await sendTelegram(text);
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("Webhook running on port 3000");
});
