import http from "http";
import path from "path";

// ── Suggested prompts based on project type ───────────────────────────────────

function getSuggestedPrompt(projectName, projectType, projectDir) {
  const base = `You have full access to my ${projectType} project "${projectName}" located at ${projectDir}.\n\nStart by:\n1. Listing the files to understand the project structure\n2. Reading the main entry file\n3. Give me a brief summary of what this project does\n\nThen ask me what I want to work on.`;
  return base;
}

// ── HTML page ─────────────────────────────────────────────────────────────────

function buildPage({ projectDir, projectName, projectType, fileCount, configPath }) {
  const prompt = getSuggestedPrompt(projectName, projectType, projectDir);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>claude-here · ${projectName}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Berkeley+Mono:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0c0c0e;
      --surface: #131316;
      --surface2: #1a1a1f;
      --border: #2a2a32;
      --accent: #7c6af7;
      --accent-dim: #7c6af720;
      --accent-glow: #7c6af740;
      --green: #3ddc84;
      --green-dim: #3ddc8420;
      --text: #e8e8f0;
      --muted: #6b6b80;
      --mono: 'Berkeley Mono', 'Fira Code', monospace;
      --sans: 'DM Sans', sans-serif;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 15px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 48px 20px 80px;
      line-height: 1.6;
    }

    /* subtle grid bg */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(var(--border) 1px, transparent 1px),
        linear-gradient(90deg, var(--border) 1px, transparent 1px);
      background-size: 40px 40px;
      opacity: 0.18;
      pointer-events: none;
      z-index: 0;
    }

    .wrap {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 680px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .logo-mark {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -1px;
    }

    .logo-text {
      font-family: var(--mono);
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      letter-spacing: 0.04em;
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--green-dim);
      border: 1px solid #3ddc8440;
      color: var(--green);
      font-family: var(--mono);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 99px;
    }

    .status-pill::before {
      content: '';
      width: 6px;
      height: 6px;
      background: var(--green);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Project card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .card-header {
      padding: 14px 20px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .card-body {
      padding: 20px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }

    .meta-item label {
      display: block;
      font-size: 11px;
      color: var(--muted);
      font-family: var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }

    .meta-item .value {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--text);
      word-break: break-all;
    }

    .meta-item .value.accent { color: var(--accent); }
    .meta-item .value.green  { color: var(--green);  }

    .meta-item.full { grid-column: 1 / -1; }

    /* ── Step list ── */
    .steps {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      transition: background 0.15s;
    }

    .step:first-child { border-radius: 12px 12px 0 0; }
    .step:last-child  { border-radius: 0 0 12px 12px; }
    .step:only-child  { border-radius: 12px; }

    .step.done { background: #131316; }

    .step-num {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
      background: var(--accent-dim);
      border: 1px solid var(--accent);
      color: var(--accent);
    }

    .step.done .step-num {
      background: var(--green-dim);
      border-color: var(--green);
      color: var(--green);
    }

    .step-text {
      font-size: 14px;
      color: var(--text);
      flex: 1;
    }

    .step-text span {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      display: block;
      margin-top: 2px;
    }

    .step.done .step-text { color: var(--muted); text-decoration: line-through; }
    .step.done .step-text span { text-decoration: none; }

    /* ── Prompt box ── */
    .prompt-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .prompt-header {
      padding: 14px 20px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .prompt-label {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .copy-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--accent-dim);
      border: 1px solid var(--accent);
      color: var(--accent);
      font-family: var(--mono);
      font-size: 11px;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.04em;
    }

    .copy-btn:hover {
      background: var(--accent-glow);
    }

    .copy-btn.copied {
      background: var(--green-dim);
      border-color: var(--green);
      color: var(--green);
    }

    .prompt-text {
      padding: 20px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.8;
      color: #b0b0c8;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 260px;
      overflow-y: auto;
    }

    .prompt-text::-webkit-scrollbar { width: 4px; }
    .prompt-text::-webkit-scrollbar-track { background: transparent; }
    .prompt-text::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    /* ── Footer ── */
    .footer {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      font-family: var(--mono);
      padding-top: 8px;
    }

    /* ── Fade in ── */
    .wrap > * {
      animation: fadein 0.4s ease both;
    }
    .wrap > *:nth-child(1) { animation-delay: 0.0s; }
    .wrap > *:nth-child(2) { animation-delay: 0.08s; }
    .wrap > *:nth-child(3) { animation-delay: 0.16s; }
    .wrap > *:nth-child(4) { animation-delay: 0.24s; }
    .wrap > *:nth-child(5) { animation-delay: 0.32s; }

    @keyframes fadein {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="wrap">

    <!-- Header -->
    <div class="header">
      <div class="logo">
        <div class="logo-mark">✦</div>
        <span class="logo-text">claude-here</span>
      </div>
      <div class="status-pill">MCP active</div>
    </div>

    <!-- Project info -->
    <div class="card">
      <div class="card-header">Project</div>
      <div class="card-body">
        <div class="meta-grid">
          <div class="meta-item">
            <label>Name</label>
            <div class="value accent">${projectName}</div>
          </div>
          <div class="meta-item">
            <label>Type</label>
            <div class="value">${projectType}</div>
          </div>
          <div class="meta-item">
            <label>Files</label>
            <div class="value green">${fileCount} detected</div>
          </div>
          <div class="meta-item">
            <label>Config written</label>
            <div class="value green">✓ done</div>
          </div>
          <div class="meta-item full">
            <label>Path</label>
            <div class="value" style="color:var(--muted)">${projectDir}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Steps -->
    <div class="steps">
      <div class="step done">
        <div class="step-num">✓</div>
        <div class="step-text">
          Config updated
          <span>${configPath}</span>
        </div>
      </div>
      <div class="step done">
        <div class="step-num">✓</div>
        <div class="step-text">
          MCP filesystem server injected
          <span>@modelcontextprotocol/server-filesystem → ${projectDir}</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          Restart Claude Desktop
          <span>Quit fully and reopen so it picks up the new config</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text">
          Paste the prompt below into Claude Desktop
          <span>Claude will read your project and get to work</span>
        </div>
      </div>
    </div>

    <!-- Prompt -->
    <div class="prompt-box">
      <div class="prompt-header">
        <span class="prompt-label">Suggested starting prompt</span>
        <button class="copy-btn" onclick="copyPrompt()">
          <span id="copy-icon">⎘</span>
          <span id="copy-text">Copy</span>
        </button>
      </div>
      <div class="prompt-text" id="prompt-text">${prompt}</div>
    </div>

    <div class="footer">server running at localhost:8000 · ctrl+c to stop</div>

  </div>

  <script>
    const promptContent = ${JSON.stringify(prompt)};

    function copyPrompt() {
      navigator.clipboard.writeText(promptContent).then(() => {
        const btn = document.querySelector('.copy-btn');
        document.getElementById('copy-icon').textContent = '✓';
        document.getElementById('copy-text').textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          document.getElementById('copy-icon').textContent = '⎘';
          document.getElementById('copy-text').textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

// ── Start HTTP server ─────────────────────────────────────────────────────────

export async function startServer(opts) {
  const { port } = opts;
  const html = buildPage(opts);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  server.listen(port, () => {
    // already logged in cli.js
  });

  // Keep process alive, handle ctrl+c gracefully
  process.on("SIGINT", () => {
    console.log("\n  ✦ Stopped. Claude Desktop config remains updated.\n");
    process.exit(0);
  });
}