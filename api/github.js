if (event === "workflow_run") {
  const wf = req.body.workflow_run;

  // hanya workflow cloudflare
  if (!wf.name.toLowerCase().includes("cloudflare")) {
    return res.status(200).end();
  }

  const repo = req.body.repository.full_name;
  const branch = wf.head_branch;
  const url = wf.html_url;

  // ===== IGNORE phase awal =====
  if (wf.status === "requested" || wf.status === "queued") {
    return res.status(200).end();
  }

  // ===== BUILD START =====
  if (wf.status === "in_progress") {

    const message =
`☁️ Cloudflare Deploy

Repo: ${repo}
Branch: ${branch}
Status: building...

${url}`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      })
    });

    return res.status(200).end();
  }

  // ===== COMPLETED =====
  if (wf.status === "completed") {

    const finalMessage =
`☁️ Cloudflare Deploy

Repo: ${repo}
Branch: ${branch}
Status: ${wf.conclusion}

${url}`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: finalMessage
      })
    });

    return res.status(200).end();
  }
}
