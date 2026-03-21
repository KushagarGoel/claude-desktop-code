# claude-web

Connect Claude Desktop to any project instantly — one command, full filesystem and terminal access via MCP.

## Features

- **One-command setup** — Run `claude-web` in any project directory
- **Filesystem access** — Claude can read and write files in your project
- **Terminal access** — Execute commands, run scripts, search code
- **Session snapshots** — Automatic git-based snapshots of your work
- **Web dashboard** — View project info and snapshots at `http://localhost:11337`

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed
- Node.js 18+ and npm
- Git

## Installation

```bash
npm install -g claude-web
```

Or use npx (no install):

```bash
npx claude-web
```

## Usage

### Start claude-web

```bash
cd your-project
claude-web
```

This will:
1. Configure Claude Desktop with MCP servers for your project
2. Start a file watcher for automatic snapshots
3. Launch the web dashboard at `http://localhost:11337`
4. Prompt to restart Claude Desktop

### Available Commands

| Command | Description |
|---------|-------------|
| `claude-web` | Start claude-web for current project |
| `claude-web status` | Show current project status and recent snapshots |
| `claude-web clean` | Remove MCP config and session data |

### Using with Claude Desktop

After running `claude-web`:

1. Restart Claude Desktop when prompted
2. Claude will have access to your project files
3. Use the terminal tool to run commands like:
   - `ls -la`
   - `npm test`
   - `git status`
   - `grep -r "pattern" src/`

## How It Works

claude-web sets up two MCP servers in Claude Desktop:

1. **filesystem** — Provides read/write access to your project directory
2. **terminal** — Secure shell command execution within your project

Your project path is symlinked to `~/.claude-web/active-project`, so Claude always accesses the correct directory.

### Session Snapshots

Changes are automatically committed to a shadow git repository at `~/.claude-web/<project>/shadow.git`. This lets you:
- Track history without polluting your project's git
- Revert to previous states via the web dashboard

## Configuration

Session data is stored in `~/.claude-web/`:

```
~/.claude-web/
├── active-project        → symlink to current project
├── terminal-mcp/         # MCP server with dependencies
│   ├── terminal-mcp.js
│   ├── package.json
│   └── node_modules/
└── <project-slug>/       # Per-project data
    ├── shadow.git/       # Snapshot repository
    └── ...
```

## Requirements

- macOS, Linux, or Windows (WSL)
- Node.js >= 18
- Git

## License

MIT
