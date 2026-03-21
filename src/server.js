import http from "http";

// ── Suggested prompt ──────────────────────────────────────────────────────────

function getSuggestedPrompt(projectName, projectType, projectDir) {
  return [
    `You are a senior ${projectType} engineer pairing with me on "${projectName}".`,
    `The full codebase is at ${projectDir} — you have complete read/write access via the filesystem MCP.`,
    `You also have terminal access to run commands (grep, npm, python, etc.) within the project directory.`,
    ``,
    `Before we start, do a thorough orientation:`,
    `1. List the directory tree (skip node_modules, .git, dist, build)`,
    `2. Read every meaningful source file — don't skim, understand the actual logic`,
    `3. Identify the core data flow: how does a request/action enter the system and what happens end-to-end?`,
    `4. Spot anything that looks incomplete, inconsistent, or worth flagging`,
    ``,
    `Then give me a concise brief (5–10 lines max):`,
    `- What this project does and who it's for`,
    `- How it's structured and the key files`,
    `- Any concerns or open questions you noticed`,
    ``,
    `End with: "What do you want to work on?"`,
    ``,
    `When making changes:`,
    `- Edit only the files that need changing — don't rewrite things that work`,
    `- Keep the existing code style and conventions`,
    `- After each change, briefly explain what you did and why`,
    `- If a change touches multiple files, do them all before summarising`,
  ].join("\n");
}

// ── HTML shell ────────────────────────────────────────────────────────────────

function buildPage({ projectDir, projectName, projectSlug, projectType, fileCount, configPath, shadow, watcherOk, port }) {
  const prompt   = getSuggestedPrompt(projectName, projectType, projectDir);
  const shadowOk = shadow?.ok;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>claude-web · ${projectName}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Berkeley+Mono:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0c0c0e; --surface: #131316; --surface2: #1a1a1f; --border: #2a2a32;
      --accent: #7c6af7; --accent-dim: #7c6af720; --accent-glow: #7c6af740;
      --green: #3ddc84; --green-dim: #3ddc8420;
      --amber: #f4b942; --amber-dim: #f4b94220;
      --red: #ff5f57; --red-dim: #ff5f5720;
      --text: #e8e8f0; --muted: #6b6b80;
      --mono: 'Berkeley Mono', 'Fira Code', monospace;
      --sans: 'DM Sans', sans-serif;
    }

    body {
      background: var(--bg); color: var(--text); font-family: var(--sans);
      font-size: 15px; min-height: 100vh;
      display: flex; flex-direction: column; align-items: center;
      padding: 48px 20px 80px; line-height: 1.6;
    }
    body::before {
      content: ''; position: fixed; inset: 0;
      background-image: linear-gradient(var(--border) 1px, transparent 1px),
                        linear-gradient(90deg, var(--border) 1px, transparent 1px);
      background-size: 40px 40px; opacity: 0.18; pointer-events: none; z-index: 0;
    }
    .wrap {
      position: relative; z-index: 1; width: 100%; max-width: 680px;
      display: flex; flex-direction: column; gap: 20px;
    }

    /* ── Header ── */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 24px; border-bottom: 1px solid var(--border);
    }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-mark {
      width: 32px; height: 32px; background: var(--accent); border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 16px; font-weight: 700; color: #fff;
    }
    .logo-text { font-family: var(--mono); font-size: 14px; font-weight: 700; letter-spacing: .04em; }
    .status-pill {
      display: flex; align-items: center; gap: 6px;
      background: var(--green-dim); border: 1px solid #3ddc8440;
      color: var(--green); font-family: var(--mono); font-size: 11px;
      padding: 4px 10px; border-radius: 99px;
    }
    .status-pill::before {
      content: ''; width: 6px; height: 6px; background: var(--green);
      border-radius: 50%; animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    /* ── Cards ── */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .card-header {
      padding: 14px 20px; background: var(--surface2); border-bottom: 1px solid var(--border);
      font-family: var(--mono); font-size: 11px; color: var(--muted);
      text-transform: uppercase; letter-spacing: .1em;
      display: flex; align-items: center; justify-content: space-between;
    }
    .card-body { padding: 20px; }

    .badge { font-size: 10px; padding: 2px 8px; border-radius: 99px; letter-spacing: .06em; font-family: var(--mono); }
    .badge-green { background: var(--green-dim); border: 1px solid #3ddc8440; color: var(--green); }
    .badge-amber { background: var(--amber-dim); border: 1px solid #f4b94240; color: var(--amber); }

    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .meta-item label {
      display: block; font-size: 11px; color: var(--muted); font-family: var(--mono);
      text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px;
    }
    .meta-item .value { font-family: var(--mono); font-size: 13px; word-break: break-all; }
    .meta-item .value.accent { color: var(--accent); }
    .meta-item .value.green  { color: var(--green); }
    .meta-item .value.muted  { color: var(--muted); }
    .meta-item.full { grid-column: 1/-1; }

    /* ── Snapshot list ── */
    #snapshot-list { display: flex; flex-direction: column; gap: 1px; }
    .snap-row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 20px; background: var(--surface); border: 1px solid var(--border);
    }
    .snap-row.is-start { background: #131316; }
    .snap-hash { font-family: var(--mono); font-size: 12px; color: var(--accent); width: 56px; flex-shrink: 0; }
    .snap-info { flex: 1; min-width: 0; }
    .snap-subject { font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .snap-date { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 2px; }
    .snap-tag { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 99px; flex-shrink: 0; }
    .snap-tag.start { background: var(--green-dim); border: 1px solid #3ddc8440; color: var(--green); }
    .snap-tag.turn  { background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent); }
    .revert-btn {
      font-family: var(--mono); font-size: 11px; padding: 5px 12px;
      border-radius: 6px; cursor: pointer; transition: all .15s; flex-shrink: 0;
      background: transparent; border: 1px solid var(--border); color: var(--muted);
    }
    .revert-btn:hover { background: var(--red-dim); border-color: var(--red); color: var(--red); }
    .revert-btn.reverting { opacity: .5; cursor: not-allowed; }
    .revert-btn.done { background: var(--green-dim); border-color: var(--green); color: var(--green); }
    .snap-empty { padding: 24px 20px; text-align: center; font-family: var(--mono); font-size: 12px; color: var(--muted); }
    .snap-loading { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }

    /* ── Toast ── */
    #toast {
      position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(20px);
      background: var(--surface2); border: 1px solid var(--border);
      color: var(--text); font-family: var(--mono); font-size: 13px;
      padding: 10px 20px; border-radius: 99px;
      opacity: 0; transition: opacity .2s, transform .2s; z-index: 100;
      pointer-events: none; white-space: nowrap;
    }
    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #toast.success { border-color: var(--green); color: var(--green); }
    #toast.error   { border-color: var(--red);   color: var(--red);   }

    /* ── Steps ── */
    .steps { display: flex; flex-direction: column; gap: 1px; }
    .step {
      display: flex; align-items: center; gap: 14px;
      padding: 14px 20px; background: var(--surface); border: 1px solid var(--border);
    }
    .step:first-child { border-radius: 12px 12px 0 0; }
    .step:last-child  { border-radius: 0 0 12px 12px; }
    .step.done { background: #131316; }
    .step-num {
      width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 11px; font-weight: 700;
      background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent);
    }
    .step.done .step-num { background: var(--green-dim); border-color: var(--green); color: var(--green); }
    .step-text { font-size: 14px; flex: 1; }
    .step-text span { font-family: var(--mono); font-size: 12px; color: var(--muted); display: block; margin-top: 2px; }
    .step.done .step-text { color: var(--muted); text-decoration: line-through; }
    .step.done .step-text span { text-decoration: none; }

    /* ── Prompt ── */
    .prompt-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .prompt-header {
      padding: 14px 20px; background: var(--surface2); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .prompt-label { font-family: var(--mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .1em; }
    .copy-btn {
      display: flex; align-items: center; gap: 6px;
      background: var(--accent-dim); border: 1px solid var(--accent);
      color: var(--accent); font-family: var(--mono); font-size: 11px;
      padding: 5px 12px; border-radius: 6px; cursor: pointer; transition: all .15s;
    }
    .copy-btn:hover { background: var(--accent-glow); }
    .copy-btn.copied { background: var(--green-dim); border-color: var(--green); color: var(--green); }
    .prompt-text {
      padding: 20px; font-family: var(--mono); font-size: 13px;
      line-height: 1.8; color: #b0b0c8; white-space: pre-wrap; word-break: break-word;
      max-height: 260px; overflow-y: auto;
    }
    .prompt-text::-webkit-scrollbar { width: 4px; }
    .prompt-text::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .footer { text-align: center; font-size: 12px; color: var(--muted); font-family: var(--mono); padding-top: 8px; }

    .wrap > * { animation: fadein .4s ease both; }
    .wrap > *:nth-child(1){animation-delay:.00s} .wrap > *:nth-child(2){animation-delay:.08s}
    .wrap > *:nth-child(3){animation-delay:.16s} .wrap > *:nth-child(4){animation-delay:.24s}
    .wrap > *:nth-child(5){animation-delay:.32s} .wrap > *:nth-child(6){animation-delay:.40s}
    .wrap > *:nth-child(7){animation-delay:.48s}
    @keyframes fadein { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="logo-mark">✦</div>
      <span class="logo-text">claude-web</span>
    </div>
    <div class="status-pill">MCP active</div>
  </div>

  <!-- Project info -->
  <div class="card">
    <div class="card-header">Project</div>
    <div class="card-body">
      <div class="meta-grid">
        <div class="meta-item"><label>Name</label><div class="value accent">${projectName}</div></div>
        <div class="meta-item"><label>Type</label><div class="value">${projectType}</div></div>
        <div class="meta-item"><label>Files</label><div class="value green">${fileCount} detected</div></div>
        <div class="meta-item"><label>Config written</label><div class="value green">✓ done</div></div>
        <div class="meta-item full"><label>Project path</label><div class="value muted">${projectDir}</div></div>
        <div class="meta-item full"><label>Session data</label><div class="value muted">~/.claude-web/${projectSlug}/</div></div>
      </div>
    </div>
  </div>

  <!-- Snapshots -->
  ${shadowOk ? `
  <div class="card">
    <div class="card-header">
      Session Snapshots
      <span class="badge ${watcherOk ? "badge-green" : "badge-amber"}">
        ${watcherOk ? "● auto · collapses bursts" : "manual only"}
      </span>
    </div>
    <div id="snapshot-list"><div class="snap-loading">Loading snapshots…</div></div>
  </div>
  ` : `
  <div class="card">
    <div class="card-header">Session Snapshots <span class="badge badge-amber">unavailable</span></div>
    <div class="card-body">
      <div class="meta-item full"><label>Reason</label>
        <div class="value muted">${shadow?.reason ?? "unknown"}</div>
      </div>
    </div>
  </div>
  `}

  <!-- Steps -->
  <div class="steps">
    <div class="step done">
      <div class="step-num">✓</div>
      <div class="step-text">Config updated<span>${configPath}</span></div>
    </div>
    <div class="step done">
      <div class="step-num">✓</div>
      <div class="step-text">MCP servers injected<span>filesystem · terminal · restart</span></div>
    </div>
    ${shadowOk ? `<div class="step done">
      <div class="step-num">✓</div>
      <div class="step-text">Shadow git initialised
        <span>~/.claude-web/${projectSlug}/shadow.git${watcherOk ? " · commits after 15s silence" : ""}</span>
      </div>
    </div>` : ""}
    <div class="step">
      <div class="step-num">${shadowOk ? "4" : "3"}</div>
      <div class="step-text">Restart Claude Desktop
        <span>Quit fully and reopen to pick up the new config</span>
      </div>
    </div>
    <div class="step">
      <div class="step-num">${shadowOk ? "5" : "4"}</div>
      <div class="step-text">Paste the prompt below into Claude Desktop
        <span>Claude will read your project and get to work</span>
      </div>
    </div>
  </div>

  <!-- Prompt -->
  <div class="prompt-box">
    <div class="prompt-header">
      <span class="prompt-label">Suggested starting prompt</span>
      <button class="copy-btn" id="copy-prompt-btn">
        <span id="copy-icon">⎘</span><span id="copy-text">Copy</span>
      </button>
    </div>
    <div class="prompt-text">${prompt}</div>
  </div>

  <div class="footer">claude-web · localhost:${port} · ctrl+c to stop</div>
</div>

<div id="toast"></div>

<script>
const PROMPT    = ${JSON.stringify(prompt)};
const SHADOW_OK = ${shadowOk};

let toastTimer;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3000);
}

document.getElementById("copy-prompt-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(PROMPT).then(() => {
    const btn = document.getElementById("copy-prompt-btn");
    document.getElementById("copy-icon").textContent = "✓";
    document.getElementById("copy-text").textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      document.getElementById("copy-icon").textContent = "⎘";
      document.getElementById("copy-text").textContent = "Copy";
      btn.classList.remove("copied");
    }, 2000);
  });
});

if (SHADOW_OK) {
  let lastCount = 0;

  function relativeTime(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 60)    return "just now";
    if (diff < 3600)  return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " hr ago";
    return Math.floor(diff / 86400) + " d ago";
  }

  function tagFor(subject) {
    if (subject?.includes("session start")) return '<span class="snap-tag start">start</span>';
    if (subject?.includes("changes"))       return '<span class="snap-tag turn">changes</span>';
    if (subject?.includes("manual"))        return '<span class="snap-tag" style="background:#f4b94220;border-color:#f4b942;color:#f4b942">manual</span>';
    return "";
  }

  function renderSnapshots(snaps) {
    const container = document.getElementById("snapshot-list");
    if (!snaps.length) {
      container.innerHTML = '<div class="snap-empty">No snapshots yet — changes appear here after 15s of inactivity.</div>';
      return;
    }
    container.innerHTML = snaps.map(s => {
      const isStart = s.subject?.includes("session start");
      return \`<div class="snap-row \${isStart ? "is-start" : ""}">
        <div class="snap-hash">\${s.hash}</div>
        <div class="snap-info">
          <div class="snap-subject">\${s.subject || "—"}</div>
          <div class="snap-date">\${relativeTime(s.date)}</div>
        </div>
        \${tagFor(s.subject)}
        \${isStart
          ? '<span style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:0 4px">restore point</span>'
          : \`<button class="revert-btn" data-hash="\${s.hash}">↩ Revert</button>\`
        }
      </div>\`;
    }).join("");

    container.querySelectorAll(".revert-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const hash = btn.dataset.hash;
        if (!confirm(\`Revert to snapshot \${hash}?\\n\\n- Files will be restored to this point\\n- New files created since then will be deleted\\n- Later snapshots will be removed\\n\\nThis cannot be undone.\`)) return;

        btn.textContent = "Reverting…";
        btn.classList.add("reverting");
        btn.disabled = true;

        try {
          const res  = await fetch("/api/revert", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash }),
          });
          const data = await res.json();
          if (data.ok) {
            btn.textContent = "✓ Reverted";
            btn.classList.remove("reverting");
            btn.classList.add("done");
            const deletedMsg = data.deletedFiles ? " (" + data.deletedFiles + " new files deleted)" : "";
            showToast("✓ Reverted to " + hash + deletedMsg, "success");
            setTimeout(fetchSnapshots, 500);
          } else {
            btn.textContent = "↩ Revert";
            btn.classList.remove("reverting");
            btn.disabled = false;
            showToast("Revert failed: " + (data.error || "unknown"), "error");
          }
        } catch {
          btn.textContent = "↩ Revert";
          btn.classList.remove("reverting");
          btn.disabled = false;
          showToast("Request failed", "error");
        }
      });
    });
  }

  async function fetchSnapshots() {
    try {
      const snaps = await fetch("/api/snapshots").then(r => r.json());
      if (snaps.length !== lastCount) { lastCount = snaps.length; renderSnapshots(snaps); }
    } catch {}
  }

  fetchSnapshots();
  setInterval(fetchSnapshots, 5000);
}
</script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

export async function startServer(opts) {
  const { port, snapshotApi } = opts;
  const shell = buildPage(opts);

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/snapshots") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshotApi ? snapshotApi.listSnapshots() : []));
      return;
    }

    if (req.method === "POST" && req.url === "/api/snapshot") {
      const result = snapshotApi ? snapshotApi.createSnapshot("manual snapshot") : { committed: false, error: "no snapshot api" };
      res.writeHead(result.committed ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && req.url === "/api/revert") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        try {
          const { hash } = JSON.parse(body);
          if (!hash || !/^[a-f0-9]{4,40}$/.test(hash)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "invalid hash" }));
            return;
          }
          const result = snapshotApi ? snapshotApi.revertToSnapshot(hash) : { ok: false, error: "no snapshot api" };
          res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad request" }));
        }
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(shell);
  });

  server.listen(port);

  process.on("SIGINT", () => {
    console.log("\n  ✦ Stopped. Session data kept in ~/.claude-web/\n");
    process.exit(0);
  });
}
