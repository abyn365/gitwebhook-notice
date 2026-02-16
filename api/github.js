// simpan message id sementara di memory
const deployMessages = {};

if (event === "workflow_run") {
  const wf = req.body.workflow_run;

  // hanya workflow cloudflare
  if (!wf.name.toLowerCase().includes("cloudflare")) {
    return res.status(200).end();
  }

  const key = wf.id; // unique tiap run
  const repo = req.body.repository.full_name;
  const branch = wf.head_branch;
  const url = wf.html_url;

  // ================= START BUILD =================
  if (wf.status === "in_progress") {

    const message =
`☁️ Cloudflare Deploy

Repo: ${repo}
Branch: ${branch}
Status: building...

${url}`;

    const resTelegram = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      })
    });

    const data = await resTelegram.json();

    // simpan message id
    deployMessages[key] = {
      message_id: data.result.message_id,
      start: Date.now()
    };
  }

  // ================= FINISHED =================
  if (wf.status === "completed") {

    const msg = deployMessages[key];

    let duration = "";
    if (msg?.start) {
      duration = Math.round((Date.now() - msg.start) / 1000);
    }

    const finalMessage =
`☁️ Cloudflare Deploy

Repo: ${repo}
Branch: ${branch}
Status: ${wf.conclusion}
Duration: ${duration}s

${url}`;

    if (msg?.message_id) {
      // edit pesan lama
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          chat_id: CHAT_ID,
          message_id: msg.message_id,
          text: finalMessage
        })
      });

      delete deployMessages[key];
    } else {
      // fallback kalau message id tidak ada
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: finalMessage
        })
      });
    }
  }
}
