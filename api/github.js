import crypto from "crypto";

export default async function handler(req, res) {
  try {

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;
    const SECRET = process.env.WEBHOOK_SECRET;
    const ALLOWED_BRANCH = process.env.ALLOWED_BRANCH || "main";

    if (!BOT_TOKEN || !CHAT_ID || !SECRET) {
      return res.status(500).send("Missing ENV");
    }

    const signature = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];

    // verify signature
    const raw = JSON.stringify(req.body);
    const hmac = crypto.createHmac("sha256", SECRET);
    const digest = "sha256=" + hmac.update(raw).digest("hex");

    if (!signature || signature !== digest) {
      return res.status(401).send("Invalid signature");
    }

    // ===== PUSH EVENT =====
    if (event === "push") {
      const branch = req.body.ref.replace("refs/heads/", "");
      if (branch !== ALLOWED_BRANCH) {
        return res.status(200).end();
      }

      const repo = req.body.repository.full_name;
      const commits = req.body.commits.slice(-3);

      let text = `🚀 Git Push\nRepo: ${repo}\nBranch: ${branch}\n\n`;

      commits.forEach(c => {
        text += `• ${c.author.name}: ${c.message}\n`;
      });

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text
        })
      });
    }

    res.status(200).end();

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(500).send("Server crashed");
  }
}
