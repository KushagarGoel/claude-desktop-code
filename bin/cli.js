#!/usr/bin/env node

import os from "os";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { spawnSync, spawn } from "child_process";
import { startServer } from "../src/server.js";
import readline from "readline";

const PROJECT_DIR  = process.cwd();
const PROJECT_NAME = path.basename(PROJECT_DIR);

// All claude-desktop-code data lives in ~/.claude-desktop-code/<project-slug>/
// Slug = project name + short hash of absolute path (handles same-name projects)
const PROJECT_SLUG   = `${PROJECT_NAME}-${createHash("sha1").update(PROJECT_DIR).digest("hex").slice(0, 6)}`;
const GLOBAL_DIR     = path.join(os.homedir(), ".claude-desktop-code");
const SESSION_DIR    = path.join(GLOBAL_DIR, PROJECT_SLUG);
const SHADOW_GIT_DIR = path.join(SESSION_DIR, "shadow.git");
const ACTIVE_SYMLINK = path.join(GLOBAL_DIR, "active-project");

// Legacy cleanup: remove old claude-web directory if exists
const LEGACY_DIR = path.join(os.homedir(), ".claude-web");

const PORT        = 11337;
const DEBOUNCE_MS = 25_000; // commit after 25s of inactivity = end of a change burst

// Dirs ignored by the watcher and shadow git
const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".DS_Store"]);

// ── Project helpers ───────────────────────────────────────────────────────────

function countFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !IGNORE.has(e.name)).length; }
  catch { return 0; }
}

function detectProjectType(dir) {
  const checks = [
    ["package.json", "Node.js"], ["requirements.txt", "Python"], ["Cargo.toml", "Rust"],
    ["go.mod", "Go"], ["pom.xml", "Java/Maven"], ["composer.json", "PHP"],
    ["Gemfile", "Ruby"], ["pubspec.yaml", "Flutter/Dart"],
  ];
  for (const [file, label] of checks) if (fs.existsSync(path.join(dir, file))) return label;
  return "Unknown";
}

// ── Terminal MCP script management ────────────────────────────────────────────
// Create a mini npm package at ~/.claude-desktop-code/terminal-mcp/ with dependencies

const TERMINAL_MCP_DIR = path.join(GLOBAL_DIR, "terminal-mcp");
const TERMINAL_MCP_SCRIPT = path.join(TERMINAL_MCP_DIR, "terminal-mcp.js");
const TERMINAL_MCP_PKG = path.join(TERMINAL_MCP_DIR, "package.json");
const SESSIONS_FILE = path.join(GLOBAL_DIR, "terminal-sessions.json");

function getTerminalMcpSourcePath() {
  try {
    const cliDir = path.dirname(new URL(import.meta.url).pathname);
    // Use the new ttyd-tmux based terminal MCP
    const srcPath = path.join(cliDir, "..", "src", "ttyd-tmux-terminal-mcp.js");
    if (fs.existsSync(srcPath)) return srcPath;
    // Fallback to old terminal-mcp if new one doesn't exist
    const fallbackPath = path.join(cliDir, "..", "src", "terminal-mcp.js");
    if (fs.existsSync(fallbackPath)) return fallbackPath;
  } catch {}
  return null;
}

function getClaudeWebPkgPath() {
  try {
    const cliDir = path.dirname(new URL(import.meta.url).pathname);
    const pkgPath = path.join(cliDir, "..", "package.json");
    if (fs.existsSync(pkgPath)) return pkgPath;
  } catch {}
  return null;
}

async function updateTerminalMcpScript() {
  try {
    fs.mkdirSync(TERMINAL_MCP_DIR, { recursive: true });

    const sourcePath = getTerminalMcpSourcePath();
    if (!sourcePath) {
      return { ok: false, reason: "Could not find terminal-mcp.js source" };
    }

    // Read dependencies from claude-desktop-code package.json
    const claudeWebPkgPath = getClaudeWebPkgPath();
    const deps = {};
    if (claudeWebPkgPath) {
      const pkg = JSON.parse(fs.readFileSync(claudeWebPkgPath, "utf-8"));
      // Copy relevant dependencies (MCP SDK and any others needed)
      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          deps[name] = version;
        }
      }
    }

    // Create package.json for the terminal-mcp mini-package
    const pkgContent = {
      name: "terminal-mcp",
      version: "1.0.0",
      type: "module",
      dependencies: deps
    };

    // Write package.json
    fs.writeFileSync(TERMINAL_MCP_PKG, JSON.stringify(pkgContent, null, 2), "utf-8");

    // Copy the script
    fs.copyFileSync(sourcePath, TERMINAL_MCP_SCRIPT);

    // Run npm install
    console.log("  → Installing terminal-mcp dependencies…");
    const npmResult = spawnSync("npm", ["install"], {
      cwd: TERMINAL_MCP_DIR,
      stdio: "pipe",
      encoding: "utf-8"
    });

    if (npmResult.status !== 0) {
      return { ok: false, reason: `npm install failed: ${npmResult.stderr || npmResult.stdout}` };
    }

    return { ok: true, path: TERMINAL_MCP_SCRIPT };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Claude Desktop config ─────────────────────────────────────────────────────

function getClaudeConfigPath() {
  const p = os.platform();
  if (p === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (p === "win32")  return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function readClaudeConfig(p) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { console.warn("⚠  Could not read Claude config, starting fresh."); }
  return {};
}

function writeClaudeConfig(p, cfg) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
}

async function injectMcpServer(cfg) {
  if (!cfg.mcpServers) cfg.mcpServers = {};

  // Filesystem MCP server
  cfg.mcpServers["filesystem"] = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ACTIVE_SYMLINK]
  };

  // Terminal MCP server (secure, project-scoped)
  // Set up mini npm package at ~/.claude-desktop-code/terminal-mcp/ with dependencies
  const terminalMcpResult = await updateTerminalMcpScript();
  if (!terminalMcpResult.ok) {
    console.warn(`  ⚠  Failed to set up terminal-mcp: ${terminalMcpResult.reason}`);
    console.warn(`     Terminal MCP server will not be available.`);
  } else {
    cfg.mcpServers["terminal"] = {
      command: "node",
      args: [TERMINAL_MCP_SCRIPT],
      env: {
        PROJECT_ROOT: PROJECT_DIR
      }
    };
  }

  return cfg;
}

function removeMcpServer(cfg) {
  if (cfg.mcpServers) {
    delete cfg.mcpServers["filesystem"];
    delete cfg.mcpServers["terminal"];
  }
  return cfg;
}

// ── Symlink management ────────────────────────────────────────────────────────
// ~/.claude-desktop-code/active-project → current project directory

function updateActiveSymlink() {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });

  // Remove existing symlink if it exists
  try {
    const existing = fs.readlinkSync(ACTIVE_SYMLINK);
    if (existing === PROJECT_DIR) {
      return { ok: true, changed: false, path: ACTIVE_SYMLINK };
    }
    fs.unlinkSync(ACTIVE_SYMLINK);
  } catch (err) {
    // Symlink didn't exist or wasn't a symlink - that's fine
    if (err.code !== "ENOENT") {
      return { ok: false, reason: err.message };
    }
  }

  // Create new symlink
  try {
    fs.symlinkSync(PROJECT_DIR, ACTIVE_SYMLINK);
    return { ok: true, changed: true, path: ACTIVE_SYMLINK, previous: null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function getActiveProjectInfo() {
  try {
    const target = fs.readlinkSync(ACTIVE_SYMLINK);
    const isCurrent = target === PROJECT_DIR;
    return { exists: true, target, isCurrent };
  } catch {
    return { exists: false, target: null, isCurrent: false };
  }
}

function removeActiveSymlink() {
  try {
    const info = getActiveProjectInfo();
    if (!info.exists) return { ok: true, removed: false };

    const wasCurrent = info.isCurrent;
    fs.unlinkSync(ACTIVE_SYMLINK);
    return { ok: true, removed: true, wasCurrent };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Shadow git ────────────────────────────────────────────────────────────────
// Stored in ~/.claude-desktop-code/<project-slug>/shadow.git — never touches the project.
// Each project gets its own shadow git based on absolute path (via PROJECT_SLUG).

function shadowGit(args) {
  return spawnSync("git", [`--git-dir=${SHADOW_GIT_DIR}`, `--work-tree=${PROJECT_DIR}`, ...args], {
    cwd: PROJECT_DIR, encoding: "utf-8", stdio: "pipe"
  });
}

function resetShadowGit() {
  // Remove existing shadow git to start fresh
  if (fs.existsSync(SHADOW_GIT_DIR)) {
    fs.rmSync(SHADOW_GIT_DIR, { recursive: true, force: true });
  }
}

function initShadowGit() {
  if (spawnSync("git", ["--version"], { stdio: "pipe" }).status !== 0)
    return { ok: false, reason: "git not found in PATH" };

  fs.mkdirSync(SESSION_DIR, { recursive: true });

  // Always reset on startup - fresh snapshot history
  resetShadowGit();

  const init = spawnSync("git", ["init", "--bare", SHADOW_GIT_DIR], { stdio: "pipe", encoding: "utf-8" });
  if (init.status !== 0) return { ok: false, reason: init.stderr?.trim() || "git init --bare failed" };

  shadowGit(["config", "user.email", "claude-desktop-code@local"]);
  shadowGit(["config", "user.name",  "claude-desktop-code"]);

  // Exclude rules act as .gitignore for the shadow repo
  const excludePath = path.join(SHADOW_GIT_DIR, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.writeFileSync(excludePath, [...IGNORE].map(d => `/${d}`).join("\n") + "\n");

  shadowGit(["add", "-A"]);
  const ts  = nowStamp();
  const res = shadowGit(["commit", "-m", `session start (${ts})`, "--allow-empty"]);
  if (res.status !== 0 && !res.stderr?.includes("nothing to commit"))
    return { ok: false, reason: res.stderr?.trim() };

  const hash = shadowGit(["rev-parse", "--short", "HEAD"]).stdout?.trim();
  return { ok: true, hash, startedAt: ts, sessionDir: SESSION_DIR, fresh: true };
}

function shadowCommit(label = "after turn") {
  shadowGit(["add", "-A"]);
  const ts  = nowStamp();
  const res = shadowGit(["commit", "-m", `${label} (${ts})`]);
  const committed = res.status === 0;
  const hash = committed ? shadowGit(["rev-parse", "--short", "HEAD"]).stdout?.trim() : null;
  return { committed, hash, ts };
}

function listSnapshots(n = 50) {
  const res = shadowGit(["log", "HEAD", `--pretty=format:%h|||%s|||%ci`, `-${n}`]);
  if (res.status !== 0 || !res.stdout?.trim()) return [];
  return res.stdout.trim().split("\n").map(line => {
    const [hash, subject, date] = line.split("|||");
    return { hash: hash?.trim(), subject: subject?.trim(), date: date?.trim() };
  });
}

function revertToSnapshot(hash) {
  // Step 1: Get parent commit (state BEFORE the target snapshot)
  const parentRes = shadowGit(["rev-parse", `${hash}^`]);
  let parentHash = parentRes.stdout?.trim();
  if (parentRes.status !== 0 || !parentHash) {
    // If no parent (first commit), just use target hash
    parentHash = hash;
  }

  // Step 2: Get list of files at parent state
  const parentFiles = shadowGit(["ls-tree", "-r", "--name-only", parentHash]);
  if (parentFiles.status !== 0) {
    return { ok: false, error: parentFiles.stderr?.trim() || "failed to list files" };
  }
  const filesAtParent = new Set(parentFiles.stdout?.trim().split("\n").filter(Boolean) || []);

  // Step 3: Get list of files currently tracked
  const currentFiles = shadowGit(["ls-files"]);
  const filesNow = currentFiles.stdout?.trim().split("\n").filter(Boolean) || [];

  // Step 4: Find files that exist now but didn't exist at parent (new files to delete)
  const filesToDelete = filesNow.filter(f => !filesAtParent.has(f));
  for (const file of filesToDelete) {
    const filePath = path.join(PROJECT_DIR, file);
    try { fs.unlinkSync(filePath); } catch {}
  }

  // Step 5: Checkout the parent state (before the target snapshot was created)
  const checkout = shadowGit(["checkout", parentHash, "--", "."]);
  if (checkout.status !== 0) {
    return { ok: false, error: checkout.stderr?.trim() };
  }

  // Step 6: Reset git to parent, removing target and all later commits
  shadowGit(["reset", "--soft", parentHash]);

  return { ok: true, deletedFiles: filesToDelete.length, revertedTo: parentHash.slice(0, 7) };
}

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Claude Desktop restart prompt ─────────────────────────────────────────────

function askRestartClaude() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question("  → Restart Claude Desktop now? [Y/n] ", (answer) => {
      rl.close();
      const ans = answer.trim().toLowerCase();
      resolve(ans === "" || ans === "y" || ans === "yes");
    });
  });
}

function isClaudeRunning() {
  const result = spawnSync("pgrep", ["-x", "Claude"], { stdio: "pipe" });
  return result.status === 0;
}

async function restartClaudeDesktop() {
  console.log("  → Killing Claude Desktop…");
  spawnSync("killall", ["Claude"], { stdio: "pipe" });

  console.log("  → Waiting for Claude to close…");
  await new Promise(r => setTimeout(r, 10000));

  // Check if Claude is still running, wait until it's fully closed
  let waitCount = 0;
  while (isClaudeRunning()) {
    waitCount++;
    process.stdout.write(`  → Still running, retrying kill… (${waitCount}s)\n`);
    spawnSync("killall", ["-9", "Claude"], { stdio: "pipe" });
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("  → Starting Claude Desktop…");
  const child = spawn("open", ["-a", "Claude"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  console.log("  ✓ Claude Desktop restarted\n");
}

// ── File watcher ──────────────────────────────────────────────────────────────
// Deferred commit: stage files immediately, commit after debounce.
// This collapses rapid bursts of changes into one snapshot.

function startFileWatcher(onSnapshot) {
  let timer = null;
  let hasStagedChanges = false;

  function shouldIgnore(fp) {
    return path.relative(PROJECT_DIR, fp).split(path.sep).some(p => IGNORE.has(p));
  }

  function stageChanges() {
    shadowGit(["add", "-A"]);
    hasStagedChanges = true;
  }

  function commitChanges() {
    if (!hasStagedChanges) return;
    const ts = nowStamp();
    const res = shadowGit(["commit", "-m", `changes (${ts})`]);
    const committed = res.status === 0;
    hasStagedChanges = false;
    if (committed) {
      const hash = shadowGit(["rev-parse", "--short", "HEAD"]).stdout?.trim();
      onSnapshot({ committed, hash, ts });
    }
  }

  try {
    const watcher = fs.watch(PROJECT_DIR, { recursive: true }, (_, filename) => {
      if (!filename || shouldIgnore(path.join(PROJECT_DIR, filename))) return;

      // Stage immediately on any change
      stageChanges();

      // Clear existing timer and set new one
      clearTimeout(timer);
      timer = setTimeout(commitChanges, DEBOUNCE_MS);
    });
    watcher.on("error", () => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

function runStatus() {
  const symlinkInfo = getActiveProjectInfo();
  const activeDisplay = symlinkInfo.exists
    ? symlinkInfo.isCurrent ? "✓ This project (ACTIVE)" : `→ ${symlinkInfo.target}`
    : "✗ None";

  console.log("\n  ✦ claude-desktop-code · status\n  " + "─".repeat(50));
  console.log(`  Project    : ${PROJECT_NAME}`);
  console.log(`  Path       : ${PROJECT_DIR}`);
  console.log(`  Snapshots  : ~/.claude-desktop-code/${PROJECT_SLUG}/`);
  console.log(`  Active link: ~/.claude-desktop-code/active-project`);
  console.log(`  Points to  : ${activeDisplay}`);

  const shadowExists = fs.existsSync(SHADOW_GIT_DIR);
  if (shadowExists) {
    const snapshots = listSnapshots(5);
    console.log(`\n  Recent snapshots (${snapshots.length} total):`);
    snapshots.slice(0, 5).forEach(s => {
      console.log(`    ${s.hash}  ${s.subject}`);
    });
  }

  console.log("\n  " + "─".repeat(50) + "\n");
}

// ── Terminal Session Cleanup ──────────────────────────────────────────────────

function cleanTerminalSessions() {
  console.log("  → Cleaning up terminal sessions...");

  // Kill all ttyd processes started by us
  try {
    spawnSync("pkill", ["-f", "ttyd.*claude-term-"], { stdio: "pipe" });
  } catch {}

  // Kill all tmux sessions with our prefix
  try {
    const result = spawnSync("tmux", ["ls", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (result.status === 0 && result.stdout) {
      const sessions = result.stdout.trim().split("\n").filter(Boolean);
      const ourSessions = sessions.filter(name => name.startsWith("claude-term-"));

      for (const tmuxName of ourSessions) {
        try {
          spawnSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "pipe" });
        } catch {}
      }

      if (ourSessions.length > 0) {
        console.log(`  ✓ Killed ${ourSessions.length} tmux session(s)`);
      }
    }
  } catch {}

  // Remove sessions file
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.unlinkSync(SESSIONS_FILE);
      console.log("  ✓ Removed terminal sessions file");
    } catch {}
  }
}

// ── Clean ─────────────────────────────────────────────────────────────────────

function runClean() {
  console.log("\n  ✦ claude-desktop-code · clean\n  " + "─".repeat(50));

  // Kill running terminal-mcp processes
  console.log("  → Stopping terminal-mcp processes...");
  try {
    spawnSync("pkill", ["-f", "ttyd-tmux-terminal-mcp.js"], { stdio: "pipe" });
    spawnSync("pkill", ["-f", "terminal-mcp.js"], { stdio: "pipe" });
    console.log("  ✓ Stopped terminal-mcp processes");
  } catch {
    // Ignore errors if no processes found
  }

  // Clean up terminal sessions (tmux + ttyd)
  cleanTerminalSessions();

  // Remove MCP server config from Claude Desktop
  const configPath = getClaudeConfigPath();
  const cfg = readClaudeConfig(configPath);
  const hadMcp = cfg.mcpServers && (cfg.mcpServers["filesystem"] || cfg.mcpServers["terminal"]);
  removeMcpServer(cfg);
  writeClaudeConfig(configPath, cfg);
  if (hadMcp) {
    console.log(`  ✓ Removed MCP config from: ${configPath}`);
  } else {
    console.log(`  ℹ  No MCP config found in: ${configPath}`);
  }

  // Remove entire ~/.claude-desktop-code/ directory
  if (fs.existsSync(GLOBAL_DIR)) {
    fs.rmSync(GLOBAL_DIR, { recursive: true, force: true });
    console.log(`  ✓ Removed ~/.claude-desktop-code/`);
  } else {
    console.log(`  ℹ  No ~/.claude-desktop-code/ directory found`);
  }

  console.log("\n  → Restart Claude Desktop to apply config changes.\n  " + "─".repeat(50) + "\n");

  // Exit cleanly
  process.exit(0);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function displayHelp() {
  console.log(`
  ✦ claude-desktop-code · CLI Help
  ${"─".repeat(50)}

  Usage: claude-desktop-code [command] [options]

  Commands:
    (none)         Start claude-desktop-code with full MCP setup
    status         Show project status and recent snapshots
    clean          Remove MCP config and session data
    help           Show this help message

  Options:
    -h, --help     Show this help message
    --version      Show version number

  Examples:
    claude-desktop-code           Start the server
    claude-desktop-code status    Check project status
    claude-desktop-code clean     Clean up configuration

  ${"─".repeat(50)}
`);
}

function displayVersion() {
  const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    console.log(`claude-desktop-code v${pkg.version}`);
  } catch {
    console.log("claude-desktop-code (version unknown)");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, command, ...args] = process.argv;

  // Handle help flags
  if (command === "help" || command === "--help" || command === "-h" || (!command && args.includes("--help"))) {
    displayHelp();
    return;
  }

  // Handle version flag
  if (command === "--version" || command === "-v") {
    displayVersion();
    return;
  }

  // Handle known commands
  if (command === "clean") { runClean(); return; }
  if (command === "status") { runStatus(); return; }

  // Handle unknown commands
  if (command && command.startsWith("-")) {
    console.error(`\n  ✦ claude-desktop-code · Error\n  ${"─".repeat(50)}`);
    console.error(`  Unknown option: ${command}`);
    console.error(`  Run 'claude-desktop-code --help' for usage information.\n`);
    process.exit(1);
  }

  if (command) {
    console.error(`\n  ✦ claude-desktop-code · Error\n  ${"─".repeat(50)}`);
    console.error(`  Unknown command: ${command}`);
    console.error(`  Run 'claude-desktop-code --help' for usage information.\n`);
    process.exit(1);
  }

  const fileCount   = countFiles(PROJECT_DIR);
  const projectType = detectProjectType(PROJECT_DIR);
  const configPath  = getClaudeConfigPath();

  // Update the active symlink to point to current project
  const symlinkResult = updateActiveSymlink();

  // Inject MCP server config into Claude Desktop
  const cfg = readClaudeConfig(configPath);
  await injectMcpServer(cfg);
  writeClaudeConfig(configPath, cfg);

  console.log(`\n  ✦ claude-desktop-code\n  ${"─".repeat(50)}`);
  console.log(`  Project  : ${PROJECT_NAME}`);
  console.log(`  Path     : ${PROJECT_DIR}`);
  console.log(`  Type     : ${projectType}`);
  console.log(`  Session  : ~/.claude-desktop-code/${PROJECT_SLUG}/`);
  console.log(`  ${"─".repeat(50)}`);

  if (!symlinkResult.ok) {
    console.log(`  ⚠  Failed to update symlink: ${symlinkResult.reason}`);
  } else if (symlinkResult.changed) {
    console.log(`  ✓ Active project updated: ~/.claude-desktop-code/active-project`);
    console.log(`    → Now points to: ${PROJECT_DIR}`);
  } else {
    console.log(`  ✓ Already active: ~/.claude-desktop-code/active-project → ${PROJECT_DIR}`);
  }

  console.log(`  ✓ MCP config injected: ${configPath}`);

  const shadow = initShadowGit();
  if (!shadow.ok) {
    console.log(`  ⚠  Shadow git skipped: ${shadow.reason}`);
  } else {
    console.log(`  ✓ Shadow git ready   (~/.claude-desktop-code/${PROJECT_SLUG}/shadow.git) [fresh]`);
    console.log(`  ✓ Initial snapshot   ${shadow.hash}  ${shadow.startedAt}`);
  }

  const watcher = shadow.ok
    ? startFileWatcher(({ hash, ts }) => console.log(`  📸 snapshot ${hash}  ${ts}`))
    : { ok: false };

  if (shadow.ok) {
    console.log(watcher.ok
      ? `  ✓ File watcher active — commits after 15s of inactivity`
      : `  ⚠  File watcher unavailable: ${watcher.reason}`);
  }

  console.log(`  ✓ Starting UI at http://localhost:${PORT}\n`);

  // Prompt to restart Claude Desktop
  const shouldRestart = await askRestartClaude();
  if (shouldRestart) {
    await restartClaudeDesktop();
  } else {
    console.log("  ℹ  Skipped automatic restart. You must manually restart Claude Desktop to apply the new config.\n");
  }

  await startServer({
    projectDir: PROJECT_DIR,
    projectName: PROJECT_NAME,
    projectSlug: PROJECT_SLUG,
    projectType,
    fileCount,
    activeSymlink: ACTIVE_SYMLINK,
    shadow,
    watcherOk: watcher.ok,
    port: PORT,
    snapshotApi: { listSnapshots, revertToSnapshot, createSnapshot: shadowCommit },
  });
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
