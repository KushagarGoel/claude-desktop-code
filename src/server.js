import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync } from "child_process";

// Stub terminal logs functions (legacy - now using ttyd-tmux)
function getTerminalLogs(opts = {}) {
  if (opts.clear) return { entries: [], count: 0 };
  return { entries: [], count: 0 };
}
function clearTerminalLogs() {}

// Clear terminal logs on server restart (legacy)
clearTerminalLogs();

// ── Terminal Session Management ────────────────────────────────────────────────

const SESSIONS_FILE = path.join(os.homedir(), ".claude-desktop-code", "terminal-sessions.json");
const SESSION_PREFIX = "claude-term-";
const TTYD_PORT_MIN = 10000;
const TTYD_PORT_MAX = 10100;

// Load sessions from disk
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

// Save sessions to disk
function saveSessions(sessions) {
  try {
    const dir = path.dirname(SESSIONS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch {}
}

// Check if tmux is available
function isTmuxAvailable() {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Check if ttyd is available
function isTtydAvailable() {
  try {
    execSync("which ttyd", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Check if tmux session exists
function tmuxSessionExists(tmuxName) {
  try {
    execSync(`tmux has-session -t ${tmuxName}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Get list of active terminal sessions with their status
function getTerminalSessions() {
  const sessions = loadSessions();
  const result = [];

  for (const [sessionId, data] of Object.entries(sessions)) {
    const tmuxName = `${SESSION_PREFIX}${sessionId}`;
    const isAlive = tmuxSessionExists(tmuxName);

    result.push({
      sessionId,
      displayName: data.displayName || `Terminal ${result.length + 1}`,
      url: `http://localhost:${data.port}`,
      port: data.port,
      createdAt: data.createdAt,
      cwd: data.cwd,
      isAlive,
    });
  }

  return result;
}

// Get ports already in use by existing sessions
function getUsedPorts() {
  const sessions = loadSessions();
  return new Set(Object.values(sessions).map(s => s.port));
}

// Detect OS platform
function getOS() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

// Get install instructions based on OS
function getInstallInstructions(os) {
  const instructions = {
    macos: {
      tmux: 'brew install tmux',
      ttyd: 'brew install ttyd'
    },
    linux: {
      tmux: 'sudo apt-get install tmux  (Debian/Ubuntu)\nsudo yum install tmux      (CentOS/RHEL)\nsudo pacman -S tmux        (Arch)',
      ttyd: 'sudo apt-get install ttyd  (Debian/Ubuntu)\nsudo yum install ttyd      (CentOS/RHEL)\nsudo pacman -S ttyd        (Arch)\n\nOr build from source:\ngit clone https://github.com/tsl0922/ttyd.git\ncd ttyd && mkdir build && cd build\ncmake .. && make && sudo make install'
    },
    windows: {
      tmux: 'tmux is not natively supported on Windows.\nOptions:\n1. Use WSL (Windows Subsystem for Linux)\n2. Use Git Bash\n3. Use a Linux VM',
      ttyd: 'ttyd is not natively supported on Windows.\nOptions:\n1. Use WSL (Windows Subsystem for Linux)\n2. Build from source with Cygwin/MSYS2\n3. Use a Linux VM'
    }
  };
  return instructions[os] || instructions.linux;
}

// Check prerequisites and print instructions
function checkPrerequisites() {
  const tmuxOk = isTmuxAvailable();
  const ttydOk = isTtydAvailable();

  if (tmuxOk && ttydOk) {
    console.log('  ✓ tmux and ttyd are installed');
    return true;
  }

  const os = getOS();
  const instructions = getInstallInstructions(os);

  console.log('\n  ⚠  MISSING PREREQUISITES\n');
  console.log('  ' + '─'.repeat(60));

  if (!tmuxOk) {
    console.log('\n  ❌ tmux is not installed\n');
    console.log('  Install with:\n');
    instructions.tmux.split('\n').forEach(line => {
      console.log('    ' + line);
    });
  }

  if (!ttydOk) {
    console.log('\n  ❌ ttyd is not installed\n');
    console.log('  Install with:\n');
    instructions.ttyd.split('\n').forEach(line => {
      console.log('    ' + line);
    });
  }

  console.log('\n  ' + '─'.repeat(60));
  console.log('\n  Terminal features will be unavailable until you install these.\n');

  return false;
}

// Clean up orphaned tmux/ttyd sessions on startup
function cleanupOrphanedSessions() {
  try {
    // Get list of tmux sessions
    const result = execSync("tmux ls -F '#{session_name}' 2>/dev/null || echo ''", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });

    const existingSessions = result.trim().split("\n").filter(Boolean);
    const ourSessions = existingSessions.filter(name => name.startsWith(SESSION_PREFIX));

    // Get sessions we know about
    const knownSessions = loadSessions();
    const knownTmuxNames = new Set(
      Object.keys(knownSessions).map(id => `${SESSION_PREFIX}${id}`)
    );

    // Kill orphaned sessions (tmux sessions we didn't create)
    let killedCount = 0;
    for (const tmuxName of ourSessions) {
      if (!knownTmuxNames.has(tmuxName)) {
        try {
          execSync(`tmux kill-session -t ${tmuxName}`, { stdio: "pipe" });
          killedCount++;
          console.log(`  ✓ Killed orphaned tmux session: ${tmuxName}`);
        } catch {}
      }
    }

    // Kill any orphaned ttyd processes
    try {
      execSync("pkill -f 'ttyd.*claude-term-'", { stdio: "pipe" });
    } catch {}

    // Clean up sessions file - remove entries for dead tmux sessions
    let cleanedCount = 0;
    for (const sessionId of Object.keys(knownSessions)) {
      const tmuxName = `${SESSION_PREFIX}${sessionId}`;
      if (!tmuxSessionExists(tmuxName)) {
        delete knownSessions[sessionId];
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      saveSessions(knownSessions);
      console.log(`  ✓ Cleaned up ${cleanedCount} dead session(s) from file`);
    }

    if (killedCount > 0 || cleanedCount > 0) {
      console.log(`  ✓ Session cleanup complete (killed: ${killedCount}, cleaned: ${cleanedCount})`);
    }
  } catch (err) {
    console.error(`  ⚠ Session cleanup error: ${err.message}`);
  }
}

// Create a new terminal session
async function createTerminalSession(cwd = process.cwd(), name = null) {
  if (!isTmuxAvailable()) {
    throw new Error("tmux is not installed");
  }
  if (!isTtydAvailable()) {
    throw new Error("ttyd is not installed");
  }

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const tmuxName = `${SESSION_PREFIX}${sessionId}`;
  const resolvedCwd = path.resolve(cwd);

  // Find free port, excluding ports already allocated
  const usedPorts = getUsedPorts();
  let port;
  const net = await import("net");
  for (port = TTYD_PORT_MIN; port <= TTYD_PORT_MAX; port++) {
    // Skip ports already allocated to existing sessions
    if (usedPorts.has(port)) {
      continue;
    }
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.once("listening", () => {
          server.close();
          resolve();
        });
        server.listen(port);
      });
      break;
    } catch {
      continue;
    }
  }

  if (port > TTYD_PORT_MAX) {
    throw new Error("No free ports available");
  }

  // Detect shell
  const shell = process.env.SHELL || "/bin/bash";

  // Create tmux session with interactive shell
  execSync(`tmux new-session -d -s ${tmuxName} -c "${resolvedCwd}" "${shell}"`, { stdio: "pipe" });

  // Start ttyd with iframe support
  const ttydProcess = spawn("ttyd", [
    "-p", port.toString(),
    "-t", // Single client mode
    "-O", // Allow any origin for iframe
    "-W", // Enable flow control (needed for typing to work)
    "tmux", "attach", "-t", tmuxName
  ], {
    detached: true,
    stdio: "ignore"
  });
  ttydProcess.unref();

  // Wait for ttyd to start
  await new Promise(resolve => setTimeout(resolve, 500));

  // Save session
  const sessions = loadSessions();
  const displayName = name || `Terminal ${Object.keys(sessions).length + 1}`;
  sessions[sessionId] = {
    tmuxName,
    port,
    ttydPid: ttydProcess.pid,
    createdAt: new Date().toISOString(),
    cwd: resolvedCwd,
    displayName,
  };
  saveSessions(sessions);

  return {
    sessionId,
    displayName,
    url: `http://localhost:${port}`,
    port,
    createdAt: sessions[sessionId].createdAt,
    cwd: resolvedCwd,
  };
}

// Kill a terminal session
function killTerminalSession(sessionId) {
  const sessions = loadSessions();
  const data = sessions[sessionId];

  if (!data) {
    return { success: false, error: "Session not found" };
  }

  // Kill ttyd
  if (data.ttydPid) {
    try {
      process.kill(data.ttydPid, "SIGTERM");
    } catch {}
  }

  // Kill tmux session
  const tmuxName = `${SESSION_PREFIX}${sessionId}`;
  if (tmuxSessionExists(tmuxName)) {
    try {
      execSync(`tmux kill-session -t ${tmuxName}`, { stdio: "pipe" });
    } catch {}
  }

  // Remove from sessions
  delete sessions[sessionId];
  saveSessions(sessions);

  return { success: true, sessionId };
}

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
  const tmuxOk = isTmuxAvailable();
  const ttydOk = isTtydAvailable();
  const prerequisitesOk = tmuxOk && ttydOk;

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
      position: relative; z-index: 1; width: 100%; max-width: 1200px;
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
    .badge-red { background: var(--red-dim); border: 1px solid #ff5f5740; color: var(--red); }

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

    /* ── Terminals ── */
    .terminals-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(600px, 1fr));
      gap: 20px;
    }
    .terminal-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .terminal-header {
      padding: 10px 16px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: var(--mono);
      font-size: 12px;
    }
    .terminal-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .terminal-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .terminal-status.alive { background: var(--green); }
    .terminal-status.dead { background: var(--red); }
    .terminal-actions {
      display: flex;
      gap: 8px;
    }
    .terminal-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      font-family: var(--mono);
      font-size: 10px;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      transition: all .15s;
      text-decoration: none;
    }
    .terminal-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .terminal-btn.danger:hover {
      border-color: var(--red);
      color: var(--red);
    }
    .terminal-iframe-container {
      position: relative;
      height: 400px;
      background: #0a0a0c;
      overflow: hidden;
    }
    .terminal-iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
    .terminal-info {
      padding: 8px 16px;
      background: var(--surface2);
      border-top: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      display: flex;
      gap: 16px;
    }
    .create-terminal-btn {
      background: var(--accent-dim);
      border: 1px solid var(--accent);
      color: var(--accent);
      font-family: var(--mono);
      font-size: 12px;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      transition: all .15s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .create-terminal-btn:hover {
      background: var(--accent-glow);
    }
    .create-terminal-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .terminals-empty {
      text-align: center;
      padding: 40px;
      color: var(--muted);
      font-family: var(--mono);
    }
    .prerequisites-error {
      background: var(--red-dim);
      border: 1px solid var(--red);
      color: var(--red);
      padding: 16px;
      border-radius: 8px;
      font-family: var(--mono);
      font-size: 12px;
      margin-bottom: 16px;
    }

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
        <div class="meta-item full"><label>Session data</label><div class="value muted">~/.claude-desktop-code/${projectSlug}/</div></div>
      </div>
    </div>
  </div>

  <!-- Live Terminals -->
  <div class="card">
    <div class="card-header">
      <span>Live Terminals</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="badge ${prerequisitesOk ? 'badge-green' : 'badge-amber'}" id="terminal-prereq-badge">
          ${prerequisitesOk ? '● Ready' : '● Prerequisites missing'}
        </span>
        <button class="create-terminal-btn" id="create-terminal-btn" ${!prerequisitesOk ? 'disabled' : ''}>
          <span>+</span> New Terminal
        </button>
      </div>
    </div>
    <div class="card-body" style="padding:20px;">
      ${!prerequisitesOk ? `
      <div class="prerequisites-error">
        <strong>Missing prerequisites:</strong><br>
        ${!tmuxOk ? '• tmux is not installed (brew install tmux)<br>' : ''}
        ${!ttydOk ? '• ttyd is not installed (brew install ttyd)<br>' : ''}
      </div>
      ` : ''}
      <div id="terminals-container">
        <div class="terminals-empty">No active terminals. Click "New Terminal" to create one.</div>
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
        <span>~/.claude-desktop-code/${projectSlug}/shadow.git${watcherOk ? " · commits after 15s silence" : ""}</span>
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
const PREREQS_OK = ${prerequisitesOk};

let toastTimer;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3000);
}

document.getElementById("copy-prompt-btn")?.addEventListener("click", () => {
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

// ── Terminal Management ──────────────────────────────────────────────────────

let terminals = [];
let terminalCards = {}; // Keep track of rendered cards by sessionId

function createTerminalCard(t) {
  const div = document.createElement('div');
  div.className = 'terminal-card';
  div.dataset.sessionId = t.sessionId;
  div.innerHTML = \`
    <div class="terminal-header">
      <div class="terminal-title">
        <span class="terminal-status \${t.isAlive ? 'alive' : 'dead'}"></span>
        <span class="terminal-name">\${t.displayName}</span>
      </div>
      <div class="terminal-actions">
        <a href="\${t.url}" target="_blank" class="terminal-btn">Open ↗</a>
        <button class="terminal-btn danger kill-btn" data-session-id="\${t.sessionId}">Kill</button>
      </div>
    </div>
    <div class="terminal-iframe-container">
      <iframe class="terminal-iframe" src="\${t.url}" allow="fullscreen"></iframe>
    </div>
    <div class="terminal-info">
      <span class="terminal-port">Port: \${t.port}</span>
      <span class="terminal-cwd">CWD: \${t.cwd}</span>
      <span class="terminal-created">Created: \${new Date(t.createdAt).toLocaleTimeString()}</span>
    </div>
  \`;

  // Add kill handler
  div.querySelector('.kill-btn').addEventListener('click', (e) => {
    e.preventDefault();
    killTerminal(t.sessionId);
  });

  return div;
}

function updateTerminalCard(card, t) {
  // Only update status indicator, don't touch iframe
  const status = card.querySelector('.terminal-status');
  if (status) {
    status.className = 'terminal-status ' + (t.isAlive ? 'alive' : 'dead');
  }
}

function renderTerminals() {
  const container = document.getElementById("terminals-container");

  if (terminals.length === 0) {
    container.innerHTML = '<div class="terminals-empty">No active terminals. Click "New Terminal" to create one.</div>';
    terminalCards = {};
    return;
  }

  // Check if we need to create the grid container
  let grid = container.querySelector('.terminals-grid');
  if (!grid) {
    container.innerHTML = '<div class="terminals-grid"></div>';
    grid = container.querySelector('.terminals-grid');
    terminalCards = {};
  }

  // Get current session IDs
  const currentIds = new Set(terminals.map(t => t.sessionId));

  // Remove cards for dead/removed sessions
  for (const id of Object.keys(terminalCards)) {
    if (!currentIds.has(id)) {
      terminalCards[id].remove();
      delete terminalCards[id];
    }
  }

  // Add or update cards
  for (const t of terminals) {
    if (terminalCards[t.sessionId]) {
      // Update existing card (only status, don't touch iframe)
      updateTerminalCard(terminalCards[t.sessionId], t);
    } else {
      // Create new card
      const card = createTerminalCard(t);
      grid.appendChild(card);
      terminalCards[t.sessionId] = card;
    }
  }
}

async function fetchTerminals() {
  try {
    const response = await fetch("/api/terminals");
    const data = await response.json();
    // Only update if list changed
    const newTerminals = data.terminals || [];
    const currentIds = terminals.map(t => t.sessionId).sort().join(',');
    const newIds = newTerminals.map(t => t.sessionId).sort().join(',');

    if (currentIds !== newIds || JSON.stringify(terminals) !== JSON.stringify(newTerminals)) {
      terminals = newTerminals;
      renderTerminals();
    }
  } catch (err) {
    console.error("Failed to fetch terminals:", err);
  }
}

async function createTerminal() {
  if (!PREREQS_OK) {
    showToast("Prerequisites not met", "error");
    return;
  }

  const btn = document.getElementById("create-terminal-btn");
  btn.disabled = true;
  btn.innerHTML = "<span>...</span> Creating...";

  try {
    const response = await fetch("/api/terminals", { method: "POST" });
    const data = await response.json();

    if (data.success) {
      showToast("Terminal created", "success");
      await fetchTerminals();
    } else {
      showToast("Failed: " + data.error, "error");
    }
  } catch (err) {
    showToast("Failed to create terminal", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "<span>+</span> New Terminal";
  }
}

async function killTerminal(sessionId) {
  if (!confirm("Kill this terminal?")) return;

  try {
    const response = await fetch(\`/api/terminals/\${sessionId}\`, { method: "DELETE" });
    const data = await response.json();

    if (data.success) {
      showToast("Terminal killed", "success");
      await fetchTerminals();
    } else {
      showToast("Failed: " + data.error, "error");
    }
  } catch (err) {
    showToast("Failed to kill terminal", "error");
  }
}

document.getElementById("create-terminal-btn")?.addEventListener("click", createTerminal);

// Initial fetch and periodic refresh
fetchTerminals();
setInterval(fetchTerminals, 5000);

// ── Snapshots ────────────────────────────────────────────────────────────────

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

  // Check prerequisites first
  console.log("  → Checking prerequisites...");
  checkPrerequisites();

  // Clean up orphaned sessions on startup
  console.log("  → Cleaning up orphaned sessions...");
  cleanupOrphanedSessions();

  const shell = buildPage(opts);

  const server = http.createServer((req, res) => {
    // Terminal sessions API
    if (req.method === "GET" && req.url === "/api/terminals") {
      const terminals = getTerminalSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ terminals }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/terminals") {
      createTerminalSession(process.cwd(), null)
        .then(session => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, session }));
        })
        .catch(err => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/terminals/")) {
      const sessionId = req.url.slice("/api/terminals/".length);
      const result = killTerminalSession(sessionId);
      res.writeHead(result.success ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Snapshots API
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

    // Terminal logs API (legacy)
    if (req.method === "GET" && req.url === "/api/terminal-logs") {
      const logs = getTerminalLogs({ limit: 100 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(logs));
      return;
    }

    if (req.method === "POST" && req.url === "/api/terminal-logs/clear") {
      getTerminalLogs({ clear: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    // Main page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(shell);
  });

  server.listen(port);

  process.on("SIGINT", async () => {
    console.log("\n  ✦ Stopped. Session data kept in ~/.claude-desktop-code/\n");
    // Clean up terminal sessions on exit
    try {
      // Kill ttyd processes
      spawn("pkill", ["-f", "ttyd.*claude-term-"], { stdio: "pipe" });
      // Kill tmux sessions
      const result = spawn("tmux", ["ls", "-F", "#{session_name}"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (result.status === 0 && result.stdout) {
        const sessions = result.stdout.trim().split("\n").filter(Boolean);
        const ourSessions = sessions.filter(name => name.startsWith("claude-term-"));
        for (const tmuxName of ourSessions) {
          try {
            spawn("tmux", ["kill-session", "-t", tmuxName], { stdio: "pipe" });
          } catch {}
        }
        if (ourSessions.length > 0) {
          console.log(`  ✓ Cleaned up ${ourSessions.length} terminal session(s)`);
        }
      }
    } catch {}
    process.exit(0);
  });
}
