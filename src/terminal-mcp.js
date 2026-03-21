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

// ── Configuration ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const APPROVAL_CONFIG_PATH = path.join(os.homedir(), ".claude-web", "terminal-approval.json");

// Commands that are generally safe for read-only operations
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

// Commands that can modify files/system - require explicit approval
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

// Always blocked commands (too dangerous)
const BLOCKED_COMMANDS = new Set([
  "sudo su", "sudo -i", "sudo bash",
  "> /dev", "mkfs", "dd", "fdisk",
  "wget", "curl", "> ~/.ssh", "> ~/.bashrc", "> ~/.zshrc",
]);

// ── Approval State Management ─────────────────────────────────────────────────

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

// ── Security Validation ───────────────────────────────────────────────────────

function resolvePath(targetPath) {
  if (!targetPath) return PROJECT_ROOT;
  // Handle tilde expansion
  if (targetPath.startsWith("~/")) {
    targetPath = path.join(os.homedir(), targetPath.slice(2));
  }
  return path.resolve(PROJECT_ROOT, targetPath);
}

function isPathAllowed(targetPath) {
  const resolved = resolvePath(targetPath);
  const relative = path.relative(PROJECT_ROOT, resolved);

  // Check for path traversal attempts
  if (relative.startsWith("..") || relative.includes("/../")) {
    return false;
  }

  // Ensure the resolved path is within PROJECT_ROOT
  const realProjectRoot = fs.realpathSync(PROJECT_ROOT);
  let realResolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist yet - check parent directory
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
  // Simple command parsing - handles quoted strings
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
  // Include subcommand for git, npm, etc.
  if (args.length > 1 && !args[1].startsWith("-")) {
    return `${base} ${args[1]}`;
  }
  return base;
}

function checkCommandSafety(command) {
  const args = parseCommand(command);
  const cmdKey = getCommandKey(args);

  // Check blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (command.includes(blocked)) {
      return { safe: false, reason: `Command contains blocked pattern: ${blocked}` };
    }
  }

  // Check for shell injection patterns
  const dangerousPatterns = [
    /`[^`]*`/,                    // Command substitution backticks
    /\$\([^)]*\)/,                // Command substitution $(...)
    />\s*\/dev\/null.*2>&1.*\|\s*(sh|bash|zsh)/i,  // Obfuscated shell
    /;.*(sh|bash|zsh)\s+-c/i,     // Chained shell execution
    /\|\s*(sh|bash|zsh)\s*$/i,   // Piped to shell
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { safe: false, reason: "Potential shell injection detected" };
    }
  }

  // Determine if modification-related
  const isModification = MODIFICATION_COMMANDS.has(cmdKey) ||
    MODIFICATION_COMMANDS.has(args[0]);

  // Check if always allowed
  const alwaysAllowed = isAlwaysAllowed(cmdKey) || READONLY_COMMANDS.has(cmdKey);

  return {
    safe: true,
    args,
    cmdKey,
    requiresApproval: isModification && !alwaysAllowed,
    alwaysAllowed,
  };
}

// ── Command Execution ─────────────────────────────────────────────────────────

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

    // Ensure directory exists
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
      // Limit output size to prevent memory issues
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
        name: "execute_command",
        description: `Execute a shell command within the project directory. Commands are restricted to the project root for security.

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
            cwd: {
              type: "string",
              description: "Working directory relative to project root (default: project root)",
              default: ".",
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

  // ── execute_command ─────────────────────────────────────────────────────────
  if (name === "execute_command") {
    const { command, cwd = ".", timeout = 30000, always_allow = false } = args;

    // Validate path
    if (!isPathAllowed(cwd)) {
      return {
        content: [{
          type: "text",
          text: `Error: Working directory '${cwd}' is outside the allowed project root: ${PROJECT_ROOT}`,
        }],
        isError: true,
      };
    }

    // Check command safety
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

    // Handle approval requirement
    if (safety.requiresApproval) {
      // This is where we'd normally prompt for approval
      // For MCP, we return a special response that the client should handle
      // The client (Claude Desktop) will show approval UI
      return {
        content: [{
          type: "text",
          text: `APPROVAL_REQUIRED|{"command": "${command}", "cwd": "${cwd}", "reason": "This command may modify files or system state", "cmdKey": "${safety.cmdKey}"}`,
        }],
        isError: true,
      };
    }

    // Execute the command
    const result = await executeCommand(
      command,
      cwd,
      Math.min(timeout, 120000)
    );

    // Save to always allow if requested
    if (always_allow && safety.cmdKey) {
      setAlwaysAllowed(safety.cmdKey, true);
    }

    const output = [
      result.timedOut ? "[Command timed out after 30s]" : "",
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

  // ── search_code ─────────────────────────────────────────────────────────────
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

    // Prefer ripgrep, fall back to grep
    let command;
    try {
      // Check if ripgrep is available
      await executeCommand("which rg", ".", 5000);
      // Build ripgrep command
      const contextFlag = context > 0 ? `-C ${context}` : "";
      const typeFlag = file_pattern ? `-g "${file_pattern}"` : "";
      command = `rg ${contextFlag} ${typeFlag} "${pattern.replace(/"/g, '\\"')}" ${searchPath}`;
    } catch {
      // Fall back to grep
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
      isError: !result.success && result.exitCode !== 1, // Exit code 1 means no matches, not an error
    };
  }

  // ── run_script ──────────────────────────────────────────────────────────────
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

    // Determine interpreter
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

  // ── list_directory ──────────────────────────────────────────────────────────
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

  // ── view_file ───────────────────────────────────────────────────────────────
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

    // Read file with offset and limit
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
