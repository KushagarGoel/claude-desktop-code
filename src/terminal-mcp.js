#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const APPROVAL_CONFIG_PATH = path.join(os.homedir(), ".claude-web", "terminal-approval.json");

// ── Shell Detection ───────────────────────────────────────────────────────────

function detectShell() {
  const shells = [
    process.env.SHELL,
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/sh",
    "/usr/bin/sh",
  ];

  for (const shell of shells) {
    if (shell && fs.existsSync(shell)) {
      return shell;
    }
  }
  return "sh";
}

const SHELL_PATH = detectShell();
const SHELL_NAME = path.basename(SHELL_PATH);

// ── Session State Management ─────────────────────────────────────────────────

class SessionState {
  constructor(cwd = PROJECT_ROOT) {
    this.cwd = cwd;
    this.env = { ...process.env, TERM: "xterm-256color" };
    this.startTime = Date.now();
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  updateCwdFromCommand(command) {
    const cdMatch = command.match(/^\s*cd\s+["']?([^"';]+)["']?/);
    if (cdMatch) {
      const targetPath = cdMatch[1].trim();
      if (targetPath === "-") return null;
      const newPath = path.resolve(this.cwd, targetPath);
      if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
        this.cwd = newPath;
        return newPath;
      }
    }
    return null;
  }

  updateEnvFromCommand(command) {
    const exportMatch = command.match(/^\s*export\s+(\w+)=['"]?([^'"]*)['"]?/);
    if (exportMatch) {
      const [, varName, value] = exportMatch;
      this.env[varName] = value;
      return { [varName]: value };
    }
    return null;
  }

  getInfo() {
    return {
      cwd: this.cwd,
      uptime: Date.now() - this.startTime,
      sessionId: this.sessionId,
    };
  }
}

// ── Terminal Log Buffer ───────────────────────────────────────────────────────

const LOG_FILE_PATH = path.join(os.homedir(), ".claude-web", "terminal-logs.json");

class TerminalLogBuffer {
  constructor(maxEntries = 200) {
    this.entries = [];
    this.maxEntries = maxEntries;
    this.loadFromFile();
  }

  loadFromFile() {
    try {
      if (fs.existsSync(LOG_FILE_PATH)) {
        const data = fs.readFileSync(LOG_FILE_PATH, "utf-8");
        this.entries = JSON.parse(data);
      }
    } catch {
      this.entries = [];
    }
  }

  saveToFile() {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
      fs.writeFileSync(LOG_FILE_PATH, JSON.stringify(this.entries, null, 2));
    } catch (err) {
      console.error(`[terminal-mcp] Failed to save logs: ${err.message}`);
    }
  }

  log(type, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.saveToFile();
  }

  getEntries(options = {}) {
    const { type, limit = 50, since } = options;
    let entries = [...this.entries];
    if (type) entries = entries.filter(e => e.type === type);
    if (since) entries = entries.filter(e => new Date(e.timestamp) >= new Date(since));
    return entries.slice(-limit);
  }

  clear() {
    this.entries = [];
    this.saveToFile();
  }

  format(entries) {
    return entries.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString();
      switch (e.type) {
        case 'session_start':
          return `[${time}] [SESSION] Started (shell: ${e.shell}, session: ${e.sessionId})`;
        case 'session_kill':
          return `[${time}] [SESSION] Killed (${e.sessionId})`;
        case 'command':
          return `[${time}] [CMD] ${e.command}`;
        case 'output':
          const preview = e.stdout?.substring(0, 100)?.replace(/\n/g, '\\n') || '(no output)';
          return `[${time}] [OUT] Exit: ${e.exitCode} | ${preview}${e.stdout?.length > 100 ? '...' : ''}`;
        case 'error':
          return `[${time}] [ERR] ${e.message}`;
        case 'state_change':
          return `[${time}] [STATE] ${e.change}: ${e.value}`;
        default:
          return `[${time}] [${e.type.toUpperCase()}] ${JSON.stringify(e)}`;
      }
    }).join('\n');
  }
}

// Export function to get logs for web UI
export function getTerminalLogs(options = {}) {
  const { type, limit = 50, since, clear = false } = options;
  const buffer = new TerminalLogBuffer();
  const entries = buffer.getEntries({ type, limit, since });
  if (clear) buffer.clear();
  return { entries, formatted: buffer.format(entries), count: entries.length };
}

// Clear terminal logs on server restart
export function clearTerminalLogs() {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      fs.writeFileSync(LOG_FILE_PATH, "[]", "utf-8");
    }
  } catch (err) {
    console.error(`[terminal-mcp] Failed to clear logs: ${err.message}`);
  }
}

// ── Terminal Session (spawn-based only) ───────────────────────────────────────

class TerminalSession {
  constructor(cwd = PROJECT_ROOT) {
    this.state = new SessionState(cwd);
    this.logger = new TerminalLogBuffer(100);
    this.isRunning = false;
  }

  start() {
    this.isRunning = true;
    this.logger.log('session_start', {
      mode: 'spawn',
      shell: SHELL_PATH,
      cwd: this.state.cwd,
      sessionId: this.state.sessionId
    });
    return Promise.resolve();
  }

  kill() {
    this.logger.log('session_kill', {
      sessionId: this.state.sessionId,
      wasRunning: this.isRunning
    });
    this.isRunning = false;
  }

  async execute(command, timeoutMs = 30000) {
    // Log the command
    this.logger.log('command', {
      command,
      sessionId: this.state.sessionId,
      cwd: this.state.cwd
    });

    // Track state changes from the command
    const newCwd = this.state.updateCwdFromCommand(command);
    if (newCwd) {
      this.logger.log('state_change', { change: 'cwd', value: newCwd });
    }
    const newEnv = this.state.updateEnvFromCommand(command);
    if (newEnv) {
      this.logger.log('state_change', { change: 'env', value: JSON.stringify(newEnv) });
    }

    return this._executeSpawn(command, timeoutMs);
  }

  _executeSpawn(command, timeoutMs) {
    return new Promise((resolve) => {
      // Build state injection script
      const stateScript = this._buildStateScript();

      // Create a wrapper that:
      // 1. Sources current state
      // 2. Runs the command
      // 3. Captures new state (cwd and env vars)
      const wrappedCommand = `
${stateScript}
__run_command() {
  ${command}
  __EXIT_CODE=$?
  echo ""
  echo "__STATE_MARKER_START__"
  echo "PWD: $(pwd)"
  env | grep -E '^(MY_|USER_|APP_|NODE_|VITE_|REACT_|NEXT_)' 2>/dev/null || true
  echo "__STATE_MARKER_END__"
  exit $__EXIT_CODE
}
__run_command
`;

      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd: this.state.cwd,
        env: { ...process.env, ...this.state.env },
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.length > 100000) {
          stdout = stdout.slice(0, 100000) + "\n... (output truncated)";
        }
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
        if (stderr.length > 100000) {
          stderr = stderr.slice(0, 100000) + "\n... (stderr truncated)";
        }
      });

      child.on("close", (code) => {
        clearTimeout(timeout);

        // Parse state markers from output
        const stateResult = this._parseStateFromOutput(stdout);
        if (stateResult.newCwd) {
          this.state.cwd = stateResult.newCwd;
        }
        if (stateResult.newEnv) {
          Object.assign(this.state.env, stateResult.newEnv);
        }

        // Remove state markers from output
        const cleanStdout = this._cleanStateMarkers(stdout);

        this.logger.log('output', {
          command,
          stdout: cleanStdout.substring(0, 1000),
          stderr: stderr.trim().substring(0, 500),
          exitCode: code,
          timedOut: killed,
          sessionId: this.state.sessionId,
        });

        resolve({
          success: code === 0 && !killed,
          stdout: cleanStdout,
          stderr: stderr.trim(),
          exitCode: code,
          timedOut: killed,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout: "",
          stderr: `Failed to execute: ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }

  _buildStateScript() {
    const exports = Object.entries(this.state.env)
      .filter(([k]) => !k.match(/^(PATH|PWD|HOME|USER|TERM|SHELL)$/))
      .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`);

    if (exports.length > 0) {
      return exports.join("\n") + "\n";
    }
    return "# No custom env vars\n";
  }

  _parseStateFromOutput(output) {
    const result = { newCwd: null, newEnv: {} };
    const startMarker = "__STATE_MARKER_START__";
    const endMarker = "__STATE_MARKER_END__";
    const startIdx = output.indexOf(startMarker);
    const endIdx = output.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return result;
    }

    const stateSection = output.substring(startIdx + startMarker.length, endIdx).trim();
    const lines = stateSection.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("PWD: ")) {
        result.newCwd = trimmed.substring(5).trim();
      } else if (trimmed.includes("=")) {
        const eqIdx = trimmed.indexOf("=");
        const key = trimmed.substring(0, eqIdx);
        const value = trimmed.substring(eqIdx + 1);
        if (key && !key.match(/^(PATH|PWD|HOME|USER|TERM|SHELL)$/)) {
          result.newEnv[key] = value;
        }
      }
    }

    return result;
  }

  _cleanStateMarkers(output) {
    const startMarker = "__STATE_MARKER_START__";
    const endMarker = "__STATE_MARKER_END__";
    let result = output;
    const startIdx = result.indexOf(startMarker);
    const endIdx = result.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      result = result.substring(0, startIdx) + result.substring(endIdx + endMarker.length);
    }

    return result.replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  }

  getInfo() {
    const stateInfo = this.state.getInfo();
    return {
      cwd: stateInfo.cwd,
      uptime: stateInfo.uptime,
      isRunning: this.isRunning,
      mode: "spawn",
      sessionId: this.state.sessionId,
    };
  }
}

// Global session manager
let activeSession = null;

function getOrCreateSession() {
  if (!activeSession) {
    activeSession = new TerminalSession();
  }
  return activeSession;
}

function startNewSession() {
  if (activeSession) {
    activeSession.kill();
  }
  activeSession = new TerminalSession();
  return activeSession;
}

function getSessionInfo() {
  return activeSession?.getInfo() || { isRunning: false };
}

// ── Security & Commands ──────────────────────────────────────────────────────

const READONLY_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more",
  "ls", "ll", "la", "find", "tree",
  "grep", "rg", "ack", "ag",
  "pwd", "echo", "which", "whereis",
  "wc", "sort", "uniq", "cut", "awk", "sed",
  "ps", "top", "htop", "df", "du", "free", "uptime",
  "git", "git status", "git log", "git diff", "git show", "git branch",
  "npm", "npm list", "npm view", "npm outdated",
  "node", "node --version", "node -e",
  "python", "python3", "pip", "pip3",
  "cargo", "cargo --version", "cargo check",
  "go", "go version", "go mod",
  "rustc", "rustup",
  "docker", "docker ps", "docker images",
  "kubectl", "kubectl get",
]);

const MODIFICATION_COMMANDS = new Set([
  "rm", "rmdir", "mv", "cp", "scp",
  "chmod", "chown", "sudo",
  "kill", "pkill", "killall",
  "npm install", "npm uninstall", "npm publish",
  "pip install", "pip uninstall",
  "docker run", "docker exec", "docker build",
  "kubectl apply", "kubectl delete", "kubectl edit",
  "git push", "git pull", "git fetch", "git merge", "git rebase",
  "git checkout", "git reset", "git clean", "git stash", "git cherry-pick",
]);

const BLOCKED_COMMANDS = new Set([
  "sudo su", "sudo -i", "sudo bash",
  "> /dev", "mkfs", "dd", "fdisk",
  "wget", "curl", "> ~/.ssh", "> ~/.bashrc", "> ~/.zshrc",
]);

function loadApprovalConfig() {
  try {
    if (fs.existsSync(APPROVAL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(APPROVAL_CONFIG_PATH, "utf-8"));
    }
  } catch {
    console.error("[terminal-mcp] Failed to load approval config");
  }
  return { alwaysAllow: {}, sessionApprovals: {} };
}

function saveApprovalConfig(config) {
  try {
    fs.mkdirSync(path.dirname(APPROVAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(APPROVAL_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {
    console.error("[terminal-mcp] Failed to save approval config");
  }
}

function isAlwaysAllowed(commandKey) {
  const config = loadApprovalConfig();
  return config.alwaysAllow[commandKey] === true;
}

function setAlwaysAllowed(commandKey, allowed) {
  const config = loadApprovalConfig();
  if (allowed) {
    config.alwaysAllow[commandKey] = true;
  } else {
    delete config.alwaysAllow[commandKey];
  }
  saveApprovalConfig(config);
}

function resolvePath(targetPath) {
  if (!targetPath) return PROJECT_ROOT;
  if (targetPath.startsWith("~/")) {
    targetPath = path.join(os.homedir(), targetPath.slice(2));
  }
  return path.resolve(PROJECT_ROOT, targetPath);
}

function isPathAllowed(targetPath) {
  const resolved = resolvePath(targetPath);
  const relative = path.relative(PROJECT_ROOT, resolved);

  if (relative.startsWith("..") || relative.includes("/../")) {
    return false;
  }

  const realProjectRoot = fs.realpathSync(PROJECT_ROOT);
  let realResolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      return realParent.startsWith(realProjectRoot) || realParent === realProjectRoot;
    } catch {
      return false;
    }
  }

  return realResolved.startsWith(realProjectRoot) || realResolved === realProjectRoot;
}

function parseCommand(command) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = null;

  for (const char of command) {
    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true;
      quoteChar = char;
    } else if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = null;
    } else if (!inQuote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);

  return args;
}

function getCommandKey(args) {
  if (args.length === 0) return "";
  const base = args[0];
  if (args.length > 1 && !args[1].startsWith("-")) {
    return `${base} ${args[1]}`;
  }
  return base;
}

function checkCommandSafety(command) {
  const args = parseCommand(command);
  const cmdKey = getCommandKey(args);

  for (const blocked of BLOCKED_COMMANDS) {
    if (command.includes(blocked)) {
      return { safe: false, reason: `Command contains blocked pattern: ${blocked}` };
    }
  }

  const dangerousPatterns = [
    /`[^`]*`/,
    /\$\([^)]*\)/,
    />\s*\/dev\/null.*2>&1.*\|\s*(sh|bash|zsh)/i,
    /;.*(sh|bash|zsh)\s+-c/i,
    /\|\s*(sh|bash|zsh)\s*$/i,
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { safe: false, reason: "Potential shell injection detected" };
    }
  }

  const isModification = MODIFICATION_COMMANDS.has(cmdKey) ||
    MODIFICATION_COMMANDS.has(args[0]);

  const alwaysAllowed = isAlwaysAllowed(cmdKey) || READONLY_COMMANDS.has(cmdKey);

  return {
    safe: true,
    args,
    cmdKey,
    requiresApproval: isModification && !alwaysAllowed,
    alwaysAllowed,
  };
}

function executeCommand(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const resolvedCwd = resolvePath(cwd);

    if (!isPathAllowed(resolvedCwd)) {
      resolve({
        success: false,
        stdout: "",
        stderr: `Error: Working directory '${cwd}' is outside the allowed project root`,
        exitCode: 1,
      });
      return;
    }

    if (!fs.existsSync(resolvedCwd)) {
      resolve({
        success: false,
        stdout: "",
        stderr: `Error: Working directory '${cwd}' does not exist`,
        exitCode: 1,
      });
      return;
    }

    const child = spawn("sh", ["-c", command], {
      cwd: resolvedCwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > 100000) {
        stdout = stdout.slice(0, 100000) + "\n... (output truncated)";
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 100000) {
        stderr = stderr.slice(0, 100000) + "\n... (stderr truncated)";
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        success: code === 0 && !killed,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
        timedOut: killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        stdout: "",
        stderr: `Failed to execute: ${err.message}`,
        exitCode: 1,
      });
    });
  });
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "terminal",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "start_new_terminal",
        description: `Start a fresh new terminal session. This will kill any existing terminal session and create a new one.

Use this when:
- You want to clear environment variables and state from previous commands
- The current terminal session has become unstable or unresponsive
- You need a clean slate for a new set of operations
- Previous commands have left the terminal in an unexpected state

Note: This is the ONLY way to start a new terminal. Commands automatically reuse the existing session.`,
        inputSchema: {
          type: "object",
          properties: {
            cwd: {
              type: "string",
              description: "Working directory to start the terminal in (relative to project root, default: project root)",
              default: ".",
            },
          },
        },
      },
      {
        name: "get_terminal_status",
        description: `Get information about the current terminal session.

Returns:
- Whether a terminal session is active
- Current working directory
- Session uptime
- Session ID

Use this to check if you need to start a new terminal session.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "execute_command",
        description: `Execute a shell command in the persistent terminal session. Commands share the same session state (environment variables, current directory, etc.).

SESSION BEHAVIOR:
- All commands run in the SAME terminal session by default
- Environment variables persist between commands
- Directory changes (cd) affect subsequent commands
- Only 'start_new_terminal' creates a fresh session

SECURITY NOTES:
- Commands only run within the project directory and its subdirectories
- Potentially dangerous commands require user approval
- Use 'always_allow' to skip approval for trusted commands
- Commands have a 30-second timeout by default

COMMON PATTERNS:
- Search code: "grep -r 'pattern' src/"
- List files: "ls -la" or "find . -name '*.js'"
- Run scripts: "npm test", "node script.js", "python script.py"
- Git operations: "git status", "git log --oneline -10"
- Check files: "cat package.json", "head -20 src/index.js"`,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (default: 30000, max: 120000)",
              default: 30000,
            },
            always_allow: {
              type: "boolean",
              description: "If true, remembers this command pattern as always allowed (skip future approvals)",
              default: false,
            },
          },
          required: ["command"],
        },
      },
      {
        name: "search_code",
        description: "Search for patterns in code files using grep or ripgrep. Optimized for finding code patterns.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Search pattern (regex supported with ripgrep)",
            },
            path: {
              type: "string",
              description: "Directory or file to search in (relative to project root)",
              default: ".",
            },
            file_pattern: {
              type: "string",
              description: "Only search files matching this pattern (e.g., '*.js', '*.py')",
            },
            context: {
              type: "number",
              description: "Lines of context to show (default: 2)",
              default: 2,
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "run_script",
        description: "Run a Python, Node.js, or shell script file within the project.",
        inputSchema: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description: "Path to the script file (relative to project root)",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments to pass to the script",
              default: [],
            },
            interpreter: {
              type: "string",
              description: "Override interpreter (auto-detected from file extension if not specified)",
              enum: ["node", "python", "python3", "bash", "sh"],
            },
          },
          required: ["file"],
        },
      },
      {
        name: "list_directory",
        description: "List files and directories. Enhanced version of 'ls' with better formatting.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path (relative to project root)",
              default: ".",
            },
            recursive: {
              type: "boolean",
              description: "List recursively",
              default: false,
            },
            show_hidden: {
              type: "boolean",
              description: "Show hidden files",
              default: false,
            },
          },
        },
      },
      {
        name: "view_file",
        description: "View file contents with optional line range. Safer alternative to 'cat' with size limits.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path (relative to project root)",
            },
            offset: {
              type: "number",
              description: "Line number to start from (1-indexed)",
              default: 1,
            },
            limit: {
              type: "number",
              description: "Maximum number of lines to read (default: 100, max: 500)",
              default: 100,
            },
          },
          required: ["path"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "start_new_terminal") {
    const { cwd = "." } = args;

    if (!isPathAllowed(cwd)) {
      return {
        content: [{
          type: "text",
          text: `Error: Working directory '${cwd}' is outside the allowed project root: ${PROJECT_ROOT}`,
        }],
        isError: true,
      };
    }

    const resolvedCwd = resolvePath(cwd);
    if (!fs.existsSync(resolvedCwd)) {
      return {
        content: [{
          type: "text",
          text: `Error: Working directory '${cwd}' does not exist`,
        }],
        isError: true,
      };
    }

    const hadPrevious = !!activeSession;
    startNewSession();
    activeSession.state.cwd = resolvedCwd;
    await activeSession.start();

    const info = activeSession.getInfo();
    return {
      content: [{
        type: "text",
        text: `Terminal session ${hadPrevious ? "restarted" : "started"} successfully.

Session Info:
- Session ID: ${info.sessionId}
- Shell: ${SHELL_PATH}
- Working directory: ${cwd}
- Session uptime: ${Math.round(info.uptime / 1000)}s`,
      }],
      isError: false,
    };
  }

  if (name === "get_terminal_status") {
    const info = getSessionInfo();

    if (!info.isRunning) {
      return {
        content: [{
          type: "text",
          text: `No active terminal session.

Use 'start_new_terminal' to create a new terminal session.`,
        }],
        isError: false,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Terminal Session Status:
- Active: ${info.isRunning ? "Yes" : "No"}
- Session ID: ${info.sessionId || "N/A"}
- Working directory: ${info.cwd || PROJECT_ROOT}
- Session uptime: ${Math.round((info.uptime || 0) / 1000)}s`,
      }],
      isError: false,
    };
  }

  if (name === "execute_command") {
    const { command, timeout = 30000, always_allow = false } = args;

    const safety = checkCommandSafety(command);
    if (!safety.safe) {
      return {
        content: [{
          type: "text",
          text: `Security Error: ${safety.reason}\n\nCommand: ${command}`,
        }],
        isError: true,
      };
    }

    if (safety.requiresApproval) {
      return {
        content: [{
          type: "text",
          text: `APPROVAL_REQUIRED|{"command": "${command}", "reason": "This command may modify files or system state", "cmdKey": "${safety.cmdKey}"}`,
        }],
        isError: true,
      };
    }

    let session;
    try {
      session = getOrCreateSession();
      if (!session.isRunning) {
        await session.start();
      }
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to start terminal session: ${err.message}`,
        }],
        isError: true,
      };
    }

    let result;
    try {
      result = await session.execute(
        command,
        Math.min(timeout, 120000)
      );
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Command execution failed: ${err.message}`,
        }],
        isError: true,
      };
    }

    if (always_allow && safety.cmdKey) {
      setAlwaysAllowed(safety.cmdKey, true);
    }

    const output = [
      result.timedOut ? `[Command timed out after ${Math.round(timeout/1000)}s]` : "",
      result.stdout,
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
      result.exitCode !== 0 && !result.timedOut ? `[Exit code: ${result.exitCode}]` : "",
    ].filter(Boolean).join("\n");

    return {
      content: [{
        type: "text",
        text: output || "(no output)",
      }],
      isError: !result.success,
    };
  }

  if (name === "search_code") {
    const { pattern, path: searchPath = ".", file_pattern, context = 2 } = args;

    if (!isPathAllowed(searchPath)) {
      return {
        content: [{
          type: "text",
          text: `Error: Path '${searchPath}' is outside the allowed project root`,
        }],
        isError: true,
      };
    }

    let command;
    try {
      await executeCommand("which rg", ".", 5000);
      const contextFlag = context > 0 ? `-C ${context}` : "";
      const typeFlag = file_pattern ? `-g "${file_pattern}"` : "";
      command = `rg ${contextFlag} ${typeFlag} "${pattern.replace(/"/g, '\\"')}" ${searchPath}`;
    } catch {
      const includeFlag = file_pattern ? `--include="${file_pattern}"` : "";
      const contextFlag = context > 0 ? `-C ${context}` : "";
      command = `grep -r ${contextFlag} ${includeFlag} "${pattern.replace(/"/g, '\\"')}" ${searchPath}`;
    }

    const result = await executeCommand(command, ".", 30000);

    return {
      content: [{
        type: "text",
        text: result.stdout || result.stderr || "(no matches found)",
      }],
      isError: !result.success && result.exitCode !== 1,
    };
  }

  if (name === "run_script") {
    const { file, args: scriptArgs = [], interpreter } = args;

    if (!isPathAllowed(file)) {
      return {
        content: [{
          type: "text",
          text: `Error: Script '${file}' is outside the allowed project root`,
        }],
        isError: true,
      };
    }

    const resolvedPath = resolvePath(file);
    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{
          type: "text",
          text: `Error: Script file not found: ${file}`,
        }],
        isError: true,
      };
    }

    let cmd;
    if (interpreter) {
      cmd = `${interpreter} "${file}" ${scriptArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
    } else {
      const ext = path.extname(file).toLowerCase();
      const interpreters = {
        ".js": "node",
        ".mjs": "node",
        ".py": "python3",
        ".sh": "bash",
      };
      const interp = interpreters[ext];
      if (!interp) {
        return {
          content: [{
            type: "text",
            text: `Error: Cannot determine interpreter for file: ${file}. Please specify 'interpreter'.`,
          }],
          isError: true,
        };
      }
      cmd = `${interp} "${file}" ${scriptArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
    }

    const result = await executeCommand(cmd, path.dirname(file), 60000);

    const output = [
      result.stdout,
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
      result.exitCode !== 0 ? `[Exit code: ${result.exitCode}]` : "",
    ].filter(Boolean).join("\n");

    return {
      content: [{
        type: "text",
        text: output || "(no output)",
      }],
      isError: !result.success,
    };
  }

  if (name === "list_directory") {
    const { path: listPath = ".", recursive = false, show_hidden = false } = args;

    if (!isPathAllowed(listPath)) {
      return {
        content: [{
          type: "text",
          text: `Error: Path '${listPath}' is outside the allowed project root`,
        }],
        isError: true,
      };
    }

    const resolvedPath = resolvePath(listPath);
    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{
          type: "text",
          text: `Error: Directory not found: ${listPath}`,
        }],
        isError: true,
      };
    }

    let command;
    if (recursive) {
      command = `tree -L 3 ${show_hidden ? "-a" : "-I '.*'"} "${listPath}"`;
    } else {
      command = `ls -la ${show_hidden ? "" : "--ignore='.*'"} "${listPath}"`;
    }

    const result = await executeCommand(command, ".", 10000);

    return {
      content: [{
        type: "text",
        text: result.stdout || result.stderr || "(empty directory)",
      }],
      isError: !result.success,
    };
  }

  if (name === "view_file") {
    const { path: filePath, offset = 1, limit = 100 } = args;

    if (!isPathAllowed(filePath)) {
      return {
        content: [{
          type: "text",
          text: `Error: Path '${filePath}' is outside the allowed project root`,
        }],
        isError: true,
      };
    }

    const resolvedPath = resolvePath(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{
          type: "text",
          text: `Error: File not found: ${filePath}`,
        }],
        isError: true,
      };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      return {
        content: [{
          type: "text",
          text: `Error: '${filePath}' is a directory, not a file`,
        }],
        isError: true,
      };
    }

    const maxLimit = Math.min(limit, 500);
    const command = `sed -n '${offset},$((offset + maxLimit - 1))p' "${filePath}" | head -n ${maxLimit}`;
    const result = await executeCommand(command, ".", 10000);

    const header = offset > 1 ? `(showing lines ${offset}-${offset + maxLimit - 1})\n` : "";

    return {
      content: [{
        type: "text",
        text: header + (result.stdout || "(empty file)"),
      }],
      isError: !result.success,
    };
  }

  return {
    content: [{
      type: "text",
      text: `Unknown tool: ${name}`,
    }],
    isError: true,
  };
});

// ── Start Server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[terminal-mcp] Server running for project: ${PROJECT_ROOT}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
