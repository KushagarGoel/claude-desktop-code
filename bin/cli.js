#!/usr/bin/env node

import os from "os";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { startServer } from "../src/server.js";

const PROJECT_DIR  = process.cwd();
const PROJECT_NAME = path.basename(PROJECT_DIR);

// All claude-web data lives in ~/.claude-web/<project-slug>/
// Slug = project name + short hash of absolute path (handles same-name projects)
const PROJECT_SLUG   = `${PROJECT_NAME}-${createHash("sha1").update(PROJECT_DIR).digest("hex").slice(0, 6)}`;
const GLOBAL_DIR     = path.join(os.homedir(), ".claude-web");
const SESSION_DIR    = path.join(GLOBAL_DIR, PROJECT_SLUG);
const SHADOW_GIT_DIR = path.join(SESSION_DIR, "shadow.git");
const ACTIVE_SYMLINK = path.join(GLOBAL_DIR, "active-project");

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

function injectMcpServer(cfg) {
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers["filesystem"] = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ACTIVE_SYMLINK]
  };
  return cfg;
}

function removeMcpServer(cfg) {
  if (cfg.mcpServers && cfg.mcpServers["filesystem"]) {
    delete cfg.mcpServers["filesystem"];
  }
  return cfg;
}

// ── Symlink management ────────────────────────────────────────────────────────
// ~/.claude-web/active-project → current project directory

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
// Stored in ~/.claude-web/<project-slug>/shadow.git — never touches the project.
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

  shadowGit(["config", "user.email", "claude-web@local"]);
  shadowGit(["config", "user.name",  "claude-web"]);

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

  console.log("\n  ✦ claude-web · status\n  " + "─".repeat(50));
  console.log(`  Project    : ${PROJECT_NAME}`);
  console.log(`  Path       : ${PROJECT_DIR}`);
  console.log(`  Snapshots  : ~/.claude-web/${PROJECT_SLUG}/`);
  console.log(`  Active link: ~/.claude-web/active-project`);
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

// ── Clean ─────────────────────────────────────────────────────────────────────

function runClean() {
  console.log("\n  ✦ claude-web · clean\n  " + "─".repeat(50));

  // Remove MCP server config from Claude Desktop
  const configPath = getClaudeConfigPath();
  const cfg = readClaudeConfig(configPath);
  const hadMcp = cfg.mcpServers && cfg.mcpServers["filesystem"];
  removeMcpServer(cfg);
  writeClaudeConfig(configPath, cfg);
  if (hadMcp) {
    console.log(`  ✓ Removed MCP config from: ${configPath}`);
  } else {
    console.log(`  ℹ  No MCP config found in: ${configPath}`);
  }

  // Remove active symlink if it points to this project
  const symlinkResult = removeActiveSymlink();
  if (symlinkResult.ok) {
    if (symlinkResult.removed) {
      console.log(`  ✓ Removed active-project symlink${symlinkResult.wasCurrent ? " (was this project)" : ""}`);
    } else {
      console.log("  ℹ  No active-project symlink found");
    }
  } else {
    console.log(`  ⚠  Failed to remove symlink: ${symlinkResult.reason}`);
  }

  // Remove this project's session folder from ~/.claude-web/
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    console.log(`  ✓ Removed ~/.claude-web/${PROJECT_SLUG}/`);
  } else {
    console.log(`  ℹ  No session data found for this project (${PROJECT_SLUG}).`);
  }

  console.log("\n  → Restart Claude Desktop to apply config changes.\n  " + "─".repeat(50) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, command] = process.argv;

  if (command === "clean") { runClean(); return; }
  if (command === "status") { runStatus(); return; }

  const fileCount   = countFiles(PROJECT_DIR);
  const projectType = detectProjectType(PROJECT_DIR);
  const configPath  = getClaudeConfigPath();

  // Update the active symlink to point to current project
  const symlinkResult = updateActiveSymlink();

  // Inject MCP server config into Claude Desktop
  const cfg = readClaudeConfig(configPath);
  injectMcpServer(cfg);
  writeClaudeConfig(configPath, cfg);

  console.log(`\n  ✦ claude-web\n  ${"─".repeat(50)}`);
  console.log(`  Project  : ${PROJECT_NAME}`);
  console.log(`  Path     : ${PROJECT_DIR}`);
  console.log(`  Type     : ${projectType}`);
  console.log(`  Session  : ~/.claude-web/${PROJECT_SLUG}/`);
  console.log(`  ${"─".repeat(50)}`);

  if (!symlinkResult.ok) {
    console.log(`  ⚠  Failed to update symlink: ${symlinkResult.reason}`);
  } else if (symlinkResult.changed) {
    console.log(`  ✓ Active project updated: ~/.claude-web/active-project`);
    console.log(`    → Now points to: ${PROJECT_DIR}`);
  } else {
    console.log(`  ✓ Already active: ~/.claude-web/active-project → ${PROJECT_DIR}`);
  }

  console.log(`  ✓ MCP config injected: ${configPath}`);

  const shadow = initShadowGit();
  if (!shadow.ok) {
    console.log(`  ⚠  Shadow git skipped: ${shadow.reason}`);
  } else {
    console.log(`  ✓ Shadow git ready   (~/.claude-web/${PROJECT_SLUG}/shadow.git) [fresh]`);
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
  console.log("  → Restart Claude Desktop to apply config changes.\n");

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
