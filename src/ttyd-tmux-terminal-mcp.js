#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const GLOBAL_DIR = path.join(os.homedir(), ".claude-desktop-code");
const SESSIONS_FILE = path.join(GLOBAL_DIR, "terminal-sessions.json");
const LOGS_FILE = path.join(GLOBAL_DIR, "terminal-logs.json");

// TTYD port range
const TTYD_PORT_MIN = 10000;
const TTYD_PORT_MAX = 10100;

// Session prefix to identify our tmux sessions
const SESSION_PREFIX = "claude-term-";

// ── Utility Functions ─────────────────────────────────────────────────────────

function generateSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getTmuxSessionName(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

function log(type, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    ...data,
  };

  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    let logs = [];
    if (fs.existsSync(LOGS_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOGS_FILE, "utf-8"));
    }
    logs.push(entry);
    // Keep last 500 entries
    if (logs.length > 500) logs = logs.slice(-500);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error(`[ttyd-mcp] Failed to write log: ${err.message}`);
  }
}

// ── Port Management ───────────────────────────────────────────────────────────

function getUsedPorts() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
      return new Set(Object.values(data).map(s => s.port));
    }
  } catch {}
  return new Set();
}

async function findFreePort(startPort = TTYD_PORT_MIN, endPort = TTYD_PORT_MAX) {
  const usedPorts = getUsedPorts();

  for (let port = startPort; port <= endPort; port++) {
    // Skip ports already allocated to existing sessions
    if (usedPorts.has(port)) {
      continue;
    }

    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.once('listening', () => {
          server.close();
          resolve();
        });
        server.listen(port);
      });
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("No free ports available in range");
}

// ── Tmux Session Management ───────────────────────────────────────────────────

class TmuxSessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { tmuxName, port, ttydPid, createdAt, cwd }
    this.loadSessions();
    this.recoverExistingSessions();
  }

  // Load sessions from disk
  loadSessions() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
        for (const [sessionId, sessionData] of Object.entries(data)) {
          this.sessions.set(sessionId, sessionData);
        }
        log("sessions_loaded", { count: this.sessions.size });
      }
    } catch (err) {
      log("sessions_load_error", { error: err.message });
    }
  }

  // Save sessions to disk
  saveSessions() {
    try {
      fs.mkdirSync(GLOBAL_DIR, { recursive: true });
      const data = Object.fromEntries(this.sessions);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log("sessions_save_error", { error: err.message });
    }
  }

  // Check if tmux is available
  isTmuxAvailable() {
    try {
      execSync("which tmux", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // Check if ttyd is available
  isTtydAvailable() {
    try {
      execSync("which ttyd", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // Check if a tmux session exists
  tmuxSessionExists(tmuxName) {
    try {
      execSync(`tmux has-session -t ${tmuxName}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // Recover existing tmux sessions that we created
  recoverExistingSessions() {
    try {
      const result = execSync("tmux ls -F '#{session_name}' 2>/dev/null || true", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });

      const existingSessions = result.trim().split("\n").filter(Boolean);
      const ourSessions = existingSessions.filter(name => name.startsWith(SESSION_PREFIX));

      for (const tmuxName of ourSessions) {
        const sessionId = tmuxName.slice(SESSION_PREFIX.length);

        // Check if we have this session in our records
        if (!this.sessions.has(sessionId)) {
          // Unknown session - kill it
          try {
            execSync(`tmux kill-session -t ${tmuxName}`, { stdio: "pipe" });
            log("orphan_session_killed", { tmuxName });
          } catch (err) {
            log("orphan_session_kill_error", { tmuxName, error: err.message });
          }
        }
      }

      // Check for sessions in our records that no longer exist
      for (const [sessionId, sessionData] of this.sessions) {
        if (!this.tmuxSessionExists(sessionData.tmuxName)) {
          // Tmux session is gone, clean up our record
          this.sessions.delete(sessionId);
          log("dead_session_cleaned", { sessionId });
        }
      }

      this.saveSessions();
    } catch (err) {
      log("session_recovery_error", { error: err.message });
    }
  }

  // Create a new terminal session
  async createSession(cwd = PROJECT_ROOT, name = null) {
    if (!this.isTmuxAvailable()) {
      throw new Error("tmux is not installed. Please install tmux first.");
    }
    if (!this.isTtydAvailable()) {
      throw new Error("ttyd is not installed. Please install ttyd first.");
    }

    const sessionId = generateSessionId();
    const tmuxName = getTmuxSessionName(sessionId);
    const resolvedCwd = path.resolve(PROJECT_ROOT, cwd);

    // Detect shell
    const shell = process.env.SHELL || "/bin/bash";

    // Create tmux session with interactive shell
    try {
      execSync(`tmux new-session -d -s ${tmuxName} -c "${resolvedCwd}" "${shell}"`, {
        stdio: "pipe"
      });
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err.message}`);
    }

    // Find free port for ttyd
    const port = await findFreePort();

    // Start ttyd process with logging
    log("ttyd_spawning", { port, tmuxName, sessionId });

    const ttydProcess = spawn("ttyd", [
      "-p", port.toString(),
      "-t", // Single client mode
      "-O", // Allow origin
      "-W", // Flow control
      "tmux", "attach", "-t", tmuxName
    ], {
      detached: false, // Keep attached to see errors
      stdio: ["ignore", "pipe", "pipe"] // Capture stdout/stderr
    });

    // Log ttyd output for debugging
    let ttydOutput = "";
    let ttydErrors = "";

    ttydProcess.stdout?.on("data", (data) => {
      ttydOutput += data.toString();
      log("ttyd_stdout", { sessionId, data: data.toString().trim() });
    });

    ttydProcess.stderr?.on("data", (data) => {
      ttydErrors += data.toString();
      log("ttyd_stderr", { sessionId, data: data.toString().trim() });
    });

    ttydProcess.on("error", (err) => {
      log("ttyd_error", { sessionId, error: err.message });
    });

    ttydProcess.on("exit", (code) => {
      log("ttyd_exit", { sessionId, code });
    });

    // Wait for ttyd to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify ttyd is running
    const isRunning = ttydProcess.pid && (() => {
      try {
        process.kill(ttydProcess.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    if (!isRunning) {
      log("ttyd_failed", { sessionId, output: ttydOutput, errors: ttydErrors });
      // Clean up tmux
      try {
        execSync(`tmux kill-session -t ${tmuxName}`, { stdio: "pipe" });
      } catch {}
      throw new Error(`TTYD failed to start: ${ttydErrors || ttydOutput || "unknown error"}`);
    }

    log("ttyd_started", { sessionId, pid: ttydProcess.pid, port });

    const sessionData = {
      sessionId,
      tmuxName,
      port,
      ttydPid: ttydProcess.pid,
      createdAt: new Date().toISOString(),
      cwd: resolvedCwd,
      displayName: name || `Terminal ${this.sessions.size + 1}`,
    };

    this.sessions.set(sessionId, sessionData);
    this.saveSessions();

    log("session_created", { sessionId, port, cwd: resolvedCwd });

    return {
      sessionId,
      url: `http://localhost:${port}`,
      ...sessionData
    };
  }

  // Send a command to a tmux session
  sendCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!this.tmuxSessionExists(session.tmuxName)) {
      // Session died unexpectedly
      this.sessions.delete(sessionId);
      this.saveSessions();
      throw new Error(`Tmux session no longer exists: ${sessionId}`);
    }

    try {
      // Send command to tmux session
      execSync(`tmux send-keys -t ${session.tmuxName} '${command.replace(/'/g, "'\"'\"'")}' C-m`, {
        stdio: "pipe"
      });

      log("command_sent", { sessionId, command: command.slice(0, 100) });

      return { success: true, sessionId };
    } catch (err) {
      throw new Error(`Failed to send command: ${err.message}`);
    }
  }

  // Get terminal output (capture pane content)
  getOutput(sessionId, lines = 50) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!this.tmuxSessionExists(session.tmuxName)) {
      this.sessions.delete(sessionId);
      this.saveSessions();
      throw new Error(`Tmux session no longer exists: ${sessionId}`);
    }

    try {
      const output = execSync(`tmux capture-pane -t ${session.tmuxName} -p -S -${lines}`, {
        encoding: "utf-8",
        stdio: "pipe"
      });

      return {
        success: true,
        sessionId,
        output: output.trim(),
      };
    } catch (err) {
      throw new Error(`Failed to capture output: ${err.message}`);
    }
  }

  // Kill a specific session
  killSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: "Session not found" };
    }

    // Kill ttyd process
    if (session.ttydPid) {
      try {
        process.kill(session.ttydPid, "SIGTERM");
      } catch (err) {
        log("ttyd_kill_error", { sessionId, pid: session.ttydPid, error: err.message });
      }
    }

    // Kill tmux session
    if (this.tmuxSessionExists(session.tmuxName)) {
      try {
        execSync(`tmux kill-session -t ${session.tmuxName}`, { stdio: "pipe" });
      } catch (err) {
        log("tmux_kill_error", { sessionId, tmuxName: session.tmuxName, error: err.message });
      }
    }

    this.sessions.delete(sessionId);
    this.saveSessions();

    log("session_killed", { sessionId });

    return { success: true, sessionId };
  }

  // List all sessions
  listSessions() {
    const sessions = [];
    for (const [sessionId, data] of this.sessions) {
      const isAlive = this.tmuxSessionExists(data.tmuxName);
      sessions.push({
        sessionId,
        displayName: data.displayName,
        url: `http://localhost:${data.port}`,
        createdAt: data.createdAt,
        cwd: data.cwd,
        isAlive,
      });
    }
    return sessions;
  }

  // Get session info
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      displayName: session.displayName,
      url: `http://localhost:${session.port}`,
      createdAt: session.createdAt,
      cwd: session.cwd,
      isAlive: this.tmuxSessionExists(session.tmuxName),
    };
  }

  // Kill all sessions (used for cleanup)
  killAllSessions() {
    const count = this.sessions.size;
    log("killing_all_sessions", { count });

    for (const [sessionId, data] of this.sessions) {
      // Kill ttyd
      if (data.ttydPid) {
        try {
          process.kill(data.ttydPid, "SIGTERM");
        } catch {}
      }

      // Kill tmux session
      try {
        if (this.tmuxSessionExists(data.tmuxName)) {
          execSync(`tmux kill-session -t ${data.tmuxName}`, { stdio: "pipe" });
        }
      } catch {}
    }

    this.sessions.clear();
    this.saveSessions();

    log("all_sessions_killed", { count });
    return { killed: count };
  }

  // Clean up all sessions created by this tool
  cleanAllSessions() {
    // First clean up our tracked sessions
    this.killAllSessions();

    // Then find and kill any orphaned tmux sessions with our prefix
    try {
      const result = execSync("tmux ls -F '#{session_name}' 2>/dev/null || true", {
        encoding: "utf-8"
      });

      const existingSessions = result.trim().split("\n").filter(Boolean);
      const ourSessions = existingSessions.filter(name => name.startsWith(SESSION_PREFIX));

      for (const tmuxName of ourSessions) {
        try {
          execSync(`tmux kill-session -t ${tmuxName}`, { stdio: "pipe" });
          log("orphan_cleaned", { tmuxName });
        } catch {}
      }

      // Remove sessions file
      if (fs.existsSync(SESSIONS_FILE)) {
        fs.unlinkSync(SESSIONS_FILE);
      }

      return { cleaned: ourSessions.length };
    } catch (err) {
      log("clean_error", { error: err.message });
      return { cleaned: 0, error: err.message };
    }
  }
}

// ── Global Session Manager ────────────────────────────────────────────────────

const sessionManager = new TmuxSessionManager();

// ── Graceful Shutdown Handling ─────────────────────────────────────────────────

function setupShutdownHandlers() {
  const shutdown = (signal) => {
    log("shutdown_signal", { signal });
    console.error(`\n[${signal}] Cleaning up terminal sessions...`);
    sessionManager.killAllSessions();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGQUIT", () => shutdown("SIGQUIT"));

  // Handle uncaught errors gracefully
  process.on("uncaughtException", (err) => {
    log("uncaught_exception", { error: err.message, stack: err.stack });
    console.error("Uncaught exception:", err.message);
    sessionManager.killAllSessions();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log("unhandled_rejection", { reason: String(reason) });
  });
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "terminal",
    version: "2.0.0",
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
        name: "create_terminal",
        description: `Create a new persistent terminal session backed by tmux + ttyd.

The terminal will:
- Persist even if you refresh the browser
- Run on a unique port accessible via HTTP
- Maintain state (running processes, scrollback history)
- Be accessible via a web browser or embedded iframe

Use this when:
- Starting a long-running process (server, build, watcher)
- You need a terminal that survives browser refreshes
- You want multiple independent terminal sessions
- You need to share a terminal URL for collaboration`,
        inputSchema: {
          type: "object",
          properties: {
            cwd: {
              type: "string",
              description: "Working directory for the terminal (relative to project root, default: project root)",
              default: "."
            },
            name: {
              type: "string",
              description: "Optional display name for the terminal (default: 'Terminal N')",
            }
          },
        },
      },
      {
        name: "list_terminals",
        description: `List all active terminal sessions with their URLs and status.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_terminal",
        description: `Get information about a specific terminal session including its URL.`,
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID returned by create_terminal",
            }
          },
          required: ["session_id"],
        },
      },
      {
        name: "send_command",
        description: `Send a command to a running terminal session.

The command will be executed in the terminal as if typed by the user.
Use this to interact with long-running processes or run commands
in a persistent terminal session.`,
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID returned by create_terminal",
            },
            command: {
              type: "string",
              description: "The command to send to the terminal",
            }
          },
          required: ["session_id", "command"],
        },
      },
      {
        name: "get_terminal_output",
        description: `Get the recent output from a terminal session.

Captures the last N lines from the terminal pane. Useful for checking
status of running processes or seeing command results without opening
the terminal in a browser.`,
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID returned by create_terminal",
            },
            lines: {
              type: "number",
              description: "Number of lines to capture (default: 50, max: 500)",
              default: 50
            }
          },
          required: ["session_id"],
        },
      },
      {
        name: "kill_terminal",
        description: `Kill a specific terminal session and clean up its resources.`,
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID returned by create_terminal",
            }
          },
          required: ["session_id"],
        },
      },
      {
        name: "kill_all_terminals",
        description: `Kill ALL terminal sessions created by this tool. Use with caution.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "clean_all_terminals",
        description: `Clean up ALL terminal sessions including any orphaned sessions.
This is used by the 'clean' command to fully reset the terminal state.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "check_terminal_prerequisites",
        description: `Check if tmux and ttyd are installed and available.`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "create_terminal") {
    const { cwd = ".", name: displayName } = args;

    log("create_terminal_start", { cwd, displayName });

    try {
      const session = await sessionManager.createSession(cwd, displayName);
      log("create_terminal_success", { sessionId: session.sessionId });
      return {
        content: [{
          type: "text",
          text: `Terminal session created successfully.

Session ID: ${session.sessionId}
Display Name: ${session.displayName}
URL: ${session.url}
Working Directory: ${session.cwd}

To view the terminal, open the URL in a browser or embed it in an iframe:
<iframe src="${session.url}" style="width:100%;height:400px;border:none;"></iframe>

This terminal will persist even if you refresh the browser.
Use 'send_command' to send commands to this terminal.
Use 'get_terminal_output' to see recent output without opening the browser.`,
        }],
        isError: false,
      };
    } catch (err) {
      log("create_terminal_error", { error: err.message, stack: err.stack });
      return {
        content: [{
          type: "text",
          text: `Failed to create terminal: ${err.message}`,
        }],
        isError: true,
      };
    }
  }

  if (name === "list_terminals") {
    const sessions = sessionManager.listSessions();

    if (sessions.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No active terminal sessions.\n\nUse 'create_terminal' to start a new terminal.",
        }],
        isError: false,
      };
    }

    const sessionList = sessions.map((s, i) =>
      `${i + 1}. ${s.displayName} (${s.isAlive ? "alive" : "dead"})
   Session ID: ${s.sessionId}
   URL: ${s.url}
   CWD: ${s.cwd}
   Created: ${s.createdAt}`
    ).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `Active Terminal Sessions (${sessions.length}):\n\n${sessionList}`,
      }],
      isError: false,
    };
  }

  if (name === "get_terminal") {
    const { session_id } = args;
    const session = sessionManager.getSession(session_id);

    if (!session) {
      return {
        content: [{
          type: "text",
          text: `Session not found: ${session_id}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Terminal Session:

Session ID: ${session.sessionId}
Display Name: ${session.displayName}
URL: ${session.url}
Working Directory: ${session.cwd}
Status: ${session.isAlive ? "alive" : "dead"}
Created: ${session.createdAt}`,
      }],
      isError: false,
    };
  }

  if (name === "send_command") {
    const { session_id, command } = args;

    // Check if session exists first
    if (!sessionManager.getSession(session_id)) {
      return {
        content: [{
          type: "text",
          text: `Terminal session not found: ${session_id}\n\nThe session may have been cleaned up when the server restarted. Please create a new terminal session using 'create_terminal'.`,
        }],
        isError: true,
      };
    }

    try {
      const result = sessionManager.sendCommand(session_id, command);
      return {
        content: [{
          type: "text",
          text: `Command sent successfully to terminal ${session_id}.\n\nUse 'get_terminal_output' to see the result.`,
        }],
        isError: false,
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to send command: ${err.message}\n\nThe terminal session may have died. Try creating a new session with 'create_terminal'.`,
        }],
        isError: true,
      };
    }
  }

  if (name === "get_terminal_output") {
    const { session_id, lines = 50 } = args;

    // Check if session exists first
    if (!sessionManager.getSession(session_id)) {
      return {
        content: [{
          type: "text",
          text: `Terminal session not found: ${session_id}\n\nThe session may have been cleaned up when the server restarted. Please create a new terminal session using 'create_terminal'.`,
        }],
        isError: true,
      };
    }

    try {
      const result = sessionManager.getOutput(session_id, Math.min(lines, 500));
      return {
        content: [{
          type: "text",
          text: `Terminal Output (${session_id}):\n\n${"─".repeat(60)}\n${result.output}\n${"─".repeat(60)}`,
        }],
        isError: false,
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Failed to get output: ${err.message}\n\nThe terminal session may have died. Try creating a new session with 'create_terminal'.`,
        }],
        isError: true,
      };
    }
  }

  if (name === "kill_terminal") {
    const { session_id } = args;
    const result = sessionManager.killSession(session_id);

    if (result.success) {
      return {
        content: [{
          type: "text",
          text: `Terminal session ${session_id} killed successfully.`,
        }],
        isError: false,
      };
    } else {
      return {
        content: [{
          type: "text",
          text: `Failed to kill terminal: ${result.error}`,
        }],
        isError: true,
      };
    }
  }

  if (name === "kill_all_terminals") {
    const result = sessionManager.killAllSessions();
    return {
      content: [{
        type: "text",
        text: `Killed ${result.killed} terminal session(s).`,
      }],
      isError: false,
    };
  }

  if (name === "clean_all_terminals") {
    const result = sessionManager.cleanAllSessions();
    return {
      content: [{
        type: "text",
        text: `Cleaned up ${result.cleaned} terminal session(s).`,
      }],
      isError: false,
    };
  }

  if (name === "check_terminal_prerequisites") {
    const tmuxAvailable = sessionManager.isTmuxAvailable();
    const ttydAvailable = sessionManager.isTtydAvailable();

    const installInstructions = [];

    if (!tmuxAvailable) {
      installInstructions.push(`tmux is not installed.
Install it with:
  macOS:   brew install tmux
  Ubuntu:  sudo apt-get install tmux
  CentOS:  sudo yum install tmux`);
    }

    if (!ttydAvailable) {
      installInstructions.push(`ttyd is not installed.
Install it with:
  macOS:   brew install ttyd
  Ubuntu:  sudo apt-get install ttyd
  Build from source: https://github.com/tsl0922/ttyd`);
    }

    if (tmuxAvailable && ttydAvailable) {
      return {
        content: [{
          type: "text",
          text: "All prerequisites are installed and available.\n\nYou can create terminal sessions now.",
        }],
        isError: false,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Missing prerequisites:\n\n${installInstructions.join("\n\n")}`,
      }],
      isError: true,
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
  // Set up graceful shutdown handlers
  setupShutdownHandlers();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("server_start", { projectRoot: PROJECT_ROOT });
  console.error(`[ttyd-mcp] Server running for project: ${PROJECT_ROOT}`);

  // Log availability status
  const tmuxOk = sessionManager.isTmuxAvailable();
  const ttydOk = sessionManager.isTtydAvailable();

  if (!tmuxOk || !ttydOk) {
    console.error(`[ttyd-mcp] WARNING: Missing prerequisites:`);
    if (!tmuxOk) console.error(`  - tmux is not installed`);
    if (!ttydOk) console.error(`  - ttyd is not installed`);
    console.error(`[ttyd-mcp] Run 'check_terminal_prerequisites' tool for install instructions.`);
  } else {
    console.error(`[ttyd-mcp] tmux and ttyd are available`);
    console.error(`[ttyd-mcp] Active sessions: ${sessionManager.sessions.size}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  sessionManager.killAllSessions();
  process.exit(1);
});

// Export for CLI integration
export { TmuxSessionManager, SESSIONS_FILE };
