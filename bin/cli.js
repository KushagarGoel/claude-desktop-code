#!/usr/bin/env node

import os from "os";
import path from "path";
import fs from "fs";
import { startServer } from "../src/server.js";

const PROJECT_DIR = process.cwd();
const PROJECT_NAME = path.basename(PROJECT_DIR);

// Keys injected by this script — used for clean-up too
const MANAGED_MCP_KEYS = ["filesystem", "restart"];

// ── Find Claude Desktop config path based on OS ──────────────────────────────

function getClaudeConfigPath() {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  } else {
    // Linux fallback
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

// ── Read existing config or create empty one ─────────────────────────────────

function readConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("⚠️  Could not read existing config, creating fresh one.");
  }
  return {};
}

// ── Inject filesystem + restart MCP servers into config ───────────────────────

function injectMcpServers(config, projectDir) {
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers["filesystem"] = {
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      projectDir
    ]
  };

  config.mcpServers["restart"] = {
    command: "uvx",
    args: ["mcp-server-restart"]
  };

  return config;
}

// ── Remove only the MCP servers managed by this script ───────────────────────

function removeManagedMcpServers(config) {
  if (!config.mcpServers) return config;
  for (const key of MANAGED_MCP_KEYS) {
    delete config.mcpServers[key];
  }
  return config;
}

// ── Write config back to disk ─────────────────────────────────────────────────

function writeConfig(configPath, config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ── Count files in project (top level, ignore node_modules/.git) ─────────────

function countFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter(e => !["node_modules", ".git", ".next", "dist", "build"].includes(e.name));
    return filtered.length;
  } catch {
    return 0;
  }
}

// ── Detect project type ───────────────────────────────────────────────────────

function detectProjectType(dir) {
  const checks = [
    { file: "package.json",     label: "Node.js"      },
    { file: "requirements.txt", label: "Python"       },
    { file: "Cargo.toml",       label: "Rust"         },
    { file: "go.mod",           label: "Go"           },
    { file: "pom.xml",          label: "Java/Maven"   },
    { file: "composer.json",    label: "PHP"          },
    { file: "Gemfile",          label: "Ruby"         },
    { file: "pubspec.yaml",     label: "Flutter/Dart" },
  ];
  for (const { file, label } of checks) {
    if (fs.existsSync(path.join(dir, file))) return label;
  }
  return "Unknown";
}

// ── clean command ─────────────────────────────────────────────────────────────

function runClean() {
  const configPath = getClaudeConfigPath();

  console.log("");
  console.log("  ✦ claude-here · clean");
  console.log("  ─────────────────────────────────────────");

  if (!fs.existsSync(configPath)) {
    console.log("  ℹ  No Claude Desktop config found — nothing to clean.");
    console.log("");
    return;
  }

  const config = readConfig(configPath);
  const before = Object.keys(config.mcpServers || {});
  removeManagedMcpServers(config);
  const after = Object.keys(config.mcpServers || {});
  const removed = before.filter(k => !after.includes(k));

  writeConfig(configPath, config);

  if (removed.length === 0) {
    console.log("  ℹ  No managed MCP servers found — config already clean.");
  } else {
    for (const key of removed) {
      console.log(`  ✓ Removed mcpServers["${key}"]`);
    }
    console.log("");
    console.log("  → Restart Claude Desktop to apply changes.");
  }
  console.log("  ─────────────────────────────────────────");
  console.log("");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, command] = process.argv;

  if (command === "clean") {
    runClean();
    return;
  }

  const configPath = getClaudeConfigPath();
  const config = readConfig(configPath);
  const updatedConfig = injectMcpServers(config, PROJECT_DIR);
  writeConfig(configPath, updatedConfig);

  const fileCount = countFiles(PROJECT_DIR);
  const projectType = detectProjectType(PROJECT_DIR);

  console.log("");
  console.log("  ✦ claude-here");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Project  : ${PROJECT_NAME}`);
  console.log(`  Path     : ${PROJECT_DIR}`);
  console.log(`  Type     : ${projectType}`);
  console.log(`  Config   : ${configPath}`);
  console.log("  ─────────────────────────────────────────");
  console.log("  ✓ Claude Desktop config updated");
  console.log("  ✓ MCP servers injected: filesystem, restart");
  console.log("  ✓ Starting UI at http://localhost:8000");
  console.log("");
  console.log("  → Restart Claude Desktop, then open:");
  console.log("    http://localhost:8000");
  console.log("");

  await startServer({
    projectDir: PROJECT_DIR,
    projectName: PROJECT_NAME,
    projectType,
    fileCount,
    configPath,
    port: 8000
  });
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
