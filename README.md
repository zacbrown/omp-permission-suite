<p align="right">
  <a href="README-zh.md">🇨🇳 中文</a>
</p>

# Oh My Pi Permission Suite

> Four approval modes + command-level security restrictions for the Oh My Pi coding agent.

An omp extension that provides **Act / Auto / Ask / Plan** permission modes, a rule engine for command and path protection, and a subagent-based auto-approver. Enhanced fork of [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system), ported from the Pi extension to the omp extension runtime.

## Install

```bash
omp plugin install omp-permission-suite
```

Or, for local development, load the extension file directly:

```bash
omp -e ./index.ts          # single session
omp plugin link .          # persistent link from this checkout
```

Once installed and omp restarted, you get:
- `/approval-mode` command to switch between four modes
- `set_approval_mode` tool (callable by the agent itself)
- `Alt+Shift+A` keyboard shortcut to cycle modes
- A rule engine that blocks dangerous commands across all modes
- Subagent auto-approval for complex tool calls

> Note: `Ctrl+Q` (the shortcut in the original Pi plugin) is reserved by omp for
> queueing a follow-up message, so this port cycles modes with `Alt+Shift+A`.

## Modes

| Mode | Icon | Description |
|------|------|-------------|
| Act | ⚡ | Full permissions (default) |
| Auto | 🤖 | Subagent approval for uncertain calls |
| Ask | ❓ | Read-only Q&A — write/exec tools disabled |
| Plan | 📋 | Read-only planning — write/exec tools disabled |

`Alt+Shift+A` cycles Act → Auto → Ask → Plan.

**Ask/Plan available tools:** the rule engine's read-only allow layer permits
omp's read/investigate tools — `read`, `grep`, `glob`, `web_search`, `ask`,
`task`, `todo`, `recall`, `reflect`, `set_approval_mode`, the `hypa_*` read
tools (`hypa_read`, `hypa_search`, `hypa_code`, `hypa_compress`,
`hypa_session`), any tool listed under `tools.allow` in config, and read-only
`bash` commands (see the allow table below). Everything else is blocked in
Ask/Plan.

## Commands

```bash
/approval-mode [ask|auto|act|plan]  # Switch mode
```

## Tool (agent-callable)

```typescript
// Agent can switch modes on its own
set_approval_mode({ mode: "plan" })  // Switch to read-only plan mode
set_approval_mode({ mode: "act" })   // Switch to full permission mode
```

## Rule Engine

### Evaluation Order

```
deny rules (hard block, overrides all modes)
  ↓ no match
allow rules (auto-approve, skips mode check)
  ↓ no match
session always rules (interactive temporary rules)
  ↓ no match
Mode-layer decision (ask/plan block writes, act passes, auto delegates to AI)
```

### Deny Rules (applied in all modes)

**bash commands:**
- tree-sitter parses chained commands (`&&`, `||`, `;`, `|`)
- Detects command substitution `$(...)` and subshells
- Wildcard matching: `"sudo *": "sudo blocked"`
- Hardcoded disaster command fallback: `rm -rf /`, fork bombs, `curl|bash`
- Applies to the built-in `bash` tool and extension shells like `hypa_shell`

**File paths (cross-tool):**
- `read`/`write`/`edit`/`grep`/`glob`/`bash` all subject to path rules
- Symlink resolution to prevent bypass
- Wildcard matching: `"*.env": "env files blocked"`

### Allow Rules

| Category | Commands |
|----------|----------|
| File viewing | `cat`, `head`, `tail`, `less`, `more`, `wc`, `file`, `stat` |
| Directory/search | `ls`, `tree`, `find`, `grep`, `rg` |
| Git | `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `describe`, `blame`, `reflog` |
| System status | `ps`, `top`, `df`, `du`, `free`, `uptime`, `uname`, `id`, `whoami` |
| Package mgmt | `npm list/info/view`, `pip list/show`, `cargo tree`, `go list` |
| Docker | `docker ps/images/logs/inspect/version` |
| Archives | `zcat`, `zgrep`, `unzip -l`, `tar -t` |
| Text processing | `awk`, `sed`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff` |
| Network | `curl`, `wget`, `ping`, `dig`, `traceroute`, `whois`, `netstat` |

## Configuration

Default rules ship in `config.default.json`.

User config lives at `~/.omp/agent/extensions/omp-permission-suite/config.json`. Created automatically on first load from the default.

```jsonc
{
  // bash command rules
  "bash": {
    "deny": {
      "rm -rf /": "prevent root deletion",
      "sudo *": "block sudo",
      "curl * | bash": "block remote code execution"
    },
    "allow": {
      "bun test": true,
      "bun run *": true,
      "git status": true,
      "git diff": true,
      "cat *": true
    }
  },
  // cross-tool file path rules
  "path": {
    "deny": {
      "*.env": "block env file access",
      "~/.ssh/*": "block SSH key access"
    },
    "allow": {
      "*.env.example": true
    }
  },
  // whole-tool rules keyed by tool name (wildcards supported)
  "tools": {
    "deny": {},
    "allow": {
      "hypa_read": true,
      "hypa_search": true
    }
  }
}
```

### Config Semantics

- `deny` entries → hard block, no mode can override (including `act`)
- `allow` entries → auto-approve, skip the mode layer
- Neither matches → delegate to mode layer

## Auto Mode

In `auto` mode, tool calls that don't match an allow/deny rule are delegated to
a subagent approver. The approver runs a headless `omp` subprocess and reads its
config from an agent file at `~/.omp/agent/agents/approver.md`
(frontmatter `model:` + a system prompt body). Low-confidence decisions escalate
to an interactive prompt. If the agent file is missing, every uncertain call
escalates to you.

## Project Structure

```
omp-permission-suite/
├── index.ts              # Main extension entry (ExtensionAPI)
├── types.ts              # Shared types
├── rules.ts              # Rule engine
├── approver.ts           # Auto-approver
├── subprocess-runner.ts  # Headless omp subprocess runner
├── bash-parser.ts        # tree-sitter bash parser
├── wildcard-matcher.ts   # Glob matching
├── path-utils.ts         # Path utilities
├── config-loader.ts      # Config loader
├── config.default.json   # Default rules
├── README.md             # This file (English)
└── README-zh.md          # Chinese translation
```

## Development

```bash
bun install
bun test
```

## License

MIT — based on [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) (MIT).
