/**
 * Oh My Pi Permission Suite — Rule Engine (upgraded)
 *
 * Priority: deny > allow > session always rules > mode default behavior
 *
 * Upgrades:
 * - tree-sitter bash parsing (chained commands, $(...), subshells)
 * - bash wildcard matching (last-match-wins)
 * - cross-tool path surface (read/write/edit/bash are all subject to path rules)
 * - symlink resolution to prevent bypass
 * - JSON config file support
 * - hardcoded disaster-command safety net retained
 */

import type { ApprovalConfig } from "./config-loader.ts";
import { loadConfig } from "./config-loader.ts";
import { findMatch } from "./wildcard-matcher.ts";
import { parseBashCommand } from "./bash-parser.ts";
import {
  expandHome,
  normalizePath,
  canonicalizePath,
  getPathPolicyValues,
  getToolPath,
  READONLY_TOOLS,
} from "./path-utils.ts";

// ─── Types ─────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  tools: string[];
  patterns: RegExp[];
  message?: string;
}

type Policy = "deny" | "allow";

export type AlwaysRule =
  | { kind: "tool"; tool: string }
  | { kind: "bash_prefix"; prefix: string }
  | { kind: "write_path_prefix"; prefix: string };

interface EvaluateContext {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}

/**
 * Shell-command tools: the builtin bash tool plus extension shells
 * (e.g. hypa_shell) that pass the command as a string `command` input.
 */
export function isShellTool(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "bash" || typeof input.command === "string";
}

/**
 * Generic transparent wrappers: `<wrapper> cmd args...` just runs `cmd
 * args...`, so rules should match against the wrapped command.
 */
const COMMAND_WRAPPERS = new Set(["time", "nohup", "nice"]);

/**
 * Hypa (`@hypabolic/pi-hypa`) is an output-compression CLI: it runs another
 * command and returns compressed output, so permission rules must apply to the
 * *wrapped* command, not to `hypa`. Its current CLI (v0.1.x) exposes:
 *   hypa -c "<command>"                 buffer + compress
 *   hypa -t <command...>                run unmodified, stream to terminal
 *   hypa [--timeout-ms <n>] <form>      global option prefix
 *   hypa git|dotnet|kubectl|docker …    tool-specific output reducers
 *   hypa rewrite <command>              rewrite through the registry
 *   hypa <command...>                   legacy bare form
 * `raw` is the pre-0.1 raw-mode keyword, still accepted for older setups.
 * Management subcommands (doctor/update/config/session/code/md/…) are hypa's
 * own operations, not wrapped commands, and are left untouched.
 */
const HYPA_OWN_SUBCOMMANDS = new Set([
  "doctor", "update", "config", "version", "session", "artifacts",
  "filters", "trust", "parse-health", "code", "md",
]);

/** Strip one layer of matching surrounding quotes (a `hypa -c` argument). */
function unquote(s: string): string {
  const t = s.trim();
  const last = t.length - 1;
  if (t.length >= 2 && ((t[0] === '"' && t[last] === '"') || (t[0] === "'" && t[last] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Unwrap one `hypa …` invocation to the command it runs, or null for hypa's own ops. */
function unwrapHypa(afterHypa: string): string | null {
  let r = afterHypa.trim();
  // Drop leading global options that carry a value (e.g. --timeout-ms 5000).
  for (;;) {
    const m = r.match(/^--timeout-ms(?:=|\s+)\S+\s*/);
    if (!m) break;
    r = r.slice(m[0].length).trim();
  }
  if (!r || r === "-c" || r === "-t") return null;
  if (r.startsWith("-c")) return unquote(r.slice(2));  // hypa -c "<cmd>"
  if (r.startsWith("-t")) return r.slice(2).trim();     // hypa -t <cmd...>
  if (/^raw\s/.test(r)) return r.slice(4).trim();       // legacy raw mode
  const first = r.split(/\s+/, 1)[0];
  if (HYPA_OWN_SUBCOMMANDS.has(first)) return null;
  if (first.startsWith("-")) return null;               // unknown flag form: don't guess
  return r;                                             // hypa git … / hypa rewrite … / bare
}

export function stripCommandWrappers(command: string): string {
  let cmd = command.trim();
  for (;;) {
    const first = cmd.split(/\s+/, 1)[0];
    if (first === "hypa") {
      const inner = unwrapHypa(cmd.slice(4));
      if (inner === null || inner === cmd) break;
      cmd = inner;
      continue;
    }
    if (!COMMAND_WRAPPERS.has(first)) break;
    const rest = cmd.slice(first.length).trim();
    if (!rest || rest.startsWith("-")) break; // wrapper flags: too ambiguous to strip
    cmd = rest;
  }
  return cmd;
}

/**
 * Every string a shell command should be matched against: the raw command, its
 * wrapper-stripped form, and the chain pieces of both — so a command hidden
 * inside `hypa -c "a && b"` is split back out and each part matched on its own.
 */
function matchTargets(command: string): string[] {
  const out = new Set<string>([command.trim()]);
  for (const piece of simpleChainSplit(command)) {
    out.add(piece.trim());
    const stripped = stripCommandWrappers(piece);
    out.add(stripped);
    if (stripped !== piece.trim()) {
      for (const inner of simpleChainSplit(stripped)) out.add(inner.trim());
    }
  }
  out.delete("");
  return [...out];
}

// ─── Hardcoded deny rules (safety net) ─────────────────────────────────

const HARD_DENY: Rule[] = [
  { name: "rm-root", tools: ["bash"], patterns: [/\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*(\/\s*$|~\/?\s*$|\*\s*$|\$HOME)/], message: "🚨 Deleting root/home directory" },
  { name: "sudo-destructive", tools: ["bash"], patterns: [/\bsudo\s+(dd|mkfs|fdisk|kill\s+-9\s+1)\b/], message: "🚨 Dangerous sudo operation" },
  { name: "fork-bomb", tools: ["bash"], patterns: [/:\(\)\s*\{\s*:\|:\&\s*\}\s*;/, /\bcat\s+\/dev\/(zero|urandom)\s*>/], message: "🚨 Fork bomb / disk filling" },
  { name: "remote-exec", tools: ["bash"], patterns: [/\b(curl|wget)\b.*\|\s*(bash|sh)\b/], message: "🚨 Remote code execution" },
  { name: "chmod-root", tools: ["bash"], patterns: [/\b(chmod|chown)\b.*\s+\/\s*$/], message: "🚨 Changing root directory permissions" },
  { name: "env-leak", tools: ["bash"], patterns: [/\becho\b.*\$(API_KEY|SECRET|TOKEN)/], message: "🚨 Leaking sensitive variables" },
];

// ─── Hardcoded allow rules (read-only baseline) ────────────────────────

const HARD_ALLOW: Rule[] = [
  { name: "read-tools", tools: ["read", "grep", "glob", "web_search", "ask", "task", "todo", "recall", "reflect"], patterns: [/.*/] },
  { name: "bash-readonly", tools: ["bash"], patterns: [
    /^\s*(cat|head|tail|less|more|wc|file|stat|ls|tree|find|grep|rg|which|date|pwd)\b/,
    /^\s*git\s+(status|log|diff|show|branch|tag|remote|describe|blame|reflog|stash\s+list)\b/,
    /^\s*(ps|top|htop|df|du|free|uptime|uname|id|whoami|w|last|lsof)\b/,
    /^\s*(npm|yarn|pnpm)\s+(list|info|view|outdated|audit)\b/,
    /^\s*(pip|pip3)\s+(list|show|freeze)\b/,
    /^\s*(cargo)\s+(tree|list|metadata)\b/,
    /^\s*(go)\s+(list|env|version)\b/,
    /^\s*docker\s+(ps|images|logs|inspect|version|info|stats|top)\b/,
    /^\s*(zcat|zgrep|zless|zmore|zdiff)\b/,
    /^\s*(unzip|zipinfo)\s+.*-l/,
    /^\s*tar\s+.*-[tZ]/,
    /^\s*(awk|sed|jq|sort|uniq|cut|tr|tee|diff|comm|paste|join|column|fmt|fold|pr)\b/,
    /^\s*(curl|wget)\s+/,
    /^\s*(ping|dig|nslookup|host|traceroute|whois|netstat|ss|ip\s+addr)\b/,
    /^\s*[#$\s]*$/,
  ]},
];

// ─── RuleEngine ────────────────────────────────────────────────────────

export class RuleEngine {
  private config: ApprovalConfig;
  private alwaysRules: AlwaysRule[] = [];
  private cwd: string = process.cwd();

  constructor(config?: ApprovalConfig) {
    this.config = config ?? loadConfig();
  }

  private checkToolDeny(toolName: string): string | undefined {
    return findMatch(this.config.tools?.deny ?? {}, toolName)?.value;
  }

  private checkToolAllow(toolName: string): boolean {
    return findMatch(this.config.tools?.allow ?? {}, toolName) !== null;
  }

  /** Update the working directory (called on session start) */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Add a session-scoped always rule */
  addAlwaysRule(rule: AlwaysRule): void {
    this.alwaysRules.push(rule);
  }

  /** Clear all session-scoped always rules */
  clearAlwaysRules(): void {
    this.alwaysRules = [];
  }

  /**
   * Main evaluation entry point (synchronous).
   * Returns: "deny" | "allow" | undefined (undefined = no match, fall to mode layer)
   */
  evaluate(toolName: string, input: Record<string, unknown>): Policy | undefined {
    const ctx: EvaluateContext = { toolName, input, cwd: this.cwd };

    // 1. Deny rules (highest priority — any mode can't override)
    if (this.checkDeny(ctx)) return "deny";

    // 2. Allow rules
    if (this.checkAllow(ctx)) return "allow";

    // 3. Session always rules
    if (this.checkAlways(ctx)) return "allow";

    // 4. No match → fall to mode layer
    return undefined;
  }

  /**
   * Async evaluation with tree-sitter bash parsing.
   * Uses tree-sitter to properly split chain commands and extract path tokens.
   * Falls back to sync evaluate() if tree-sitter is unavailable.
   */
  async evaluateAsync(toolName: string, input: Record<string, unknown>): Promise<Policy | undefined> {
    // For non-shell tools, use sync path
    if (!isShellTool(toolName, input)) return this.evaluate(toolName, input);

    const command = String(input.command ?? "");
    if (!command.trim()) return this.evaluate(toolName, input);

    // 1. Deny — whole-tool deny, then tree-sitter bash deny
    if (this.checkToolDeny(toolName) !== undefined) return "deny";
    const bashDeny = await this.checkBashDenyAsync(command);
    if (bashDeny) return "deny";

    // 2. Allow — tree-sitter bash allow, then whole-tool allow
    const bashAllow = await this.checkBashAllowAsync(command);
    if (bashAllow) return "allow";
    if (this.checkToolAllow(toolName)) return "allow";

    // 3. Session always rules
    if (this.checkAlways({ toolName, input, cwd: this.cwd })) return "allow";

    // 4. No match → fall to mode layer
    return undefined;
  }

  /**
   * Get the deny reason message for a tool call.
   */
  getDenyMessage(toolName: string, input: Record<string, unknown>): string | undefined {
    const ctx: EvaluateContext = { toolName, input, cwd: this.cwd };

    // Check whole-tool deny
    const toolDeny = this.checkToolDeny(toolName);
    if (toolDeny !== undefined) return toolDeny;

    // Check config bash deny
    if (isShellTool(toolName, input)) {
      const cmd = String(input.command ?? "");
      for (const c of matchTargets(cmd)) {
        const match = findMatch(this.config.bash.deny, c);
        if (match) return match.value;
      }
    }

    // Check config path deny
    const path = getToolPath(toolName, input);
    if (path) {
      const match = this.checkPathDeny(path);
      if (match) return match;
    }

    // Check hardcoded deny
    const extracted = this.extract(toolName, input);
    const hardDeny = HARD_DENY.find(
      (r) => r.tools.includes(toolName) && r.patterns.some((p) => p.test(extracted))
    );
    if (hardDeny) return hardDeny.message;

    return undefined;
  }

  /**
   * Get rule names for status display.
   */
  getRuleNames(): { deny: string[]; allow: string[] } {
    const configDenyNames = [
      ...Object.keys(this.config.bash.deny),
      ...Object.keys(this.config.path.deny),
      ...Object.keys(this.config.tools?.deny ?? {}),
    ];
    const configAllowNames = [
      ...Object.keys(this.config.bash.allow),
      ...Object.keys(this.config.path.allow),
      ...Object.keys(this.config.tools?.allow ?? {}),
    ];
    return {
      deny: [...HARD_DENY.map((r) => r.name), ...configDenyNames],
      allow: [...HARD_ALLOW.map((r) => r.name), ...configAllowNames],
    };
  }

  // ─── Deny checking ─────────────────────────────────────────────────

  private checkDeny(ctx: EvaluateContext): boolean {
    // Whole-tool deny
    if (this.checkToolDeny(ctx.toolName) !== undefined) return true;

    // Bash deny: config patterns + hardcoded safety net
    if (isShellTool(ctx.toolName, ctx.input)) {
      return this.checkBashDeny(String(ctx.input.command ?? ""));
    }

    // Path deny: cross-tool path surface
    const path = getToolPath(ctx.toolName, ctx.input);
    if (path && this.checkPathDeny(path)) return true;

    // Hardcoded deny for non-bash tools
    const extracted = this.extract(ctx.toolName, ctx.input);
    return HARD_DENY.some(
      (r) => r.tools.includes(ctx.toolName) && r.patterns.some((p) => p.test(extracted))
    );
  }

  private checkBashDeny(command: string): boolean {
    // Config patterns: raw command, wrapper-stripped form, and every chain piece
    const targets = matchTargets(command);
    for (const c of targets) {
      if (findMatch(this.config.bash.deny, c)) return true;
    }

    // Hardcoded safety net
    return HARD_DENY.some(
      (r) => r.tools.includes("bash") && targets.some((c) => r.patterns.some((p) => p.test(c)))
    );
  }

  private checkPathDeny(path: string): string | undefined {
    const expandedPath = expandHome(path);
    const normalized = normalizePath(expandedPath, this.cwd);
    const canonical = canonicalizePath(normalized);

    // Collect all values to check (lexical + canonical)
    const valuesToCheck = [expandedPath, normalized, canonical].filter(Boolean);
    const policyValues = getPathPolicyValues(path, this.cwd);
    const allValues = [...new Set([...valuesToCheck, ...policyValues])];

    // Check allow patterns first — more-specific allow overrides deny
    // (e.g. *.env.example overrides *.env.*)
    for (const val of allValues) {
      const allowMatch = findMatch(this.config.path.allow, val);
      if (allowMatch) return undefined; // explicitly allowed, skip deny
    }

    // Check deny patterns
    for (const val of allValues) {
      const match = findMatch(this.config.path.deny, val);
      if (match) return match.value;
    }

    return undefined;
  }

  // ─── Allow checking ────────────────────────────────────────────────

  private checkAllow(ctx: EvaluateContext): boolean {
    // Bash allow: config patterns + hardcoded; whole-tool allow as fallback
    if (isShellTool(ctx.toolName, ctx.input)) {
      if (this.checkBashAllow(String(ctx.input.command ?? ""))) return true;
      return this.checkToolAllow(ctx.toolName);
    }

    // Path allow: cross-tool path surface
    const path = getToolPath(ctx.toolName, ctx.input);
    if (path) {
      const pathDenyResult = this.checkPathDeny(path);
      if (pathDenyResult) return false; // deny overrides allow
    }

    // Read-only tools and whole-tool config allow
    if (READONLY_TOOLS[ctx.toolName]) return true;
    if (this.checkToolAllow(ctx.toolName)) return true;

    // Hardcoded allow
    const extracted = this.extract(ctx.toolName, ctx.input);
    return HARD_ALLOW.some(
      (r) => r.tools.includes(ctx.toolName) && r.patterns.some((p) => p.test(extracted))
    );
  }

  private checkBashAllow(command: string): boolean {
    // Config bash allow patterns: raw, wrapper-stripped, and every chain piece
    const targets = matchTargets(command);
    for (const c of targets) {
      if (findMatch(this.config.bash.allow, c)) return true;
    }

    // Hardcoded allow
    return HARD_ALLOW.some(
      (r) => r.tools.includes("bash") && targets.some((c) => r.patterns.some((p) => p.test(c)))
    );
  }

  // ─── Async bash evaluation (tree-sitter) ────────────────────────────

  private async checkBashDenyAsync(command: string): Promise<boolean> {
    // Quick check on the raw command, its wrapper-stripped form, and chain pieces
    for (const c of matchTargets(command)) {
      if (findMatch(this.config.bash.deny, c)) return true;
    }

    // Use tree-sitter to split and check sub-commands
    try {
      const parsed = await parseBashCommand(command);
      for (const sub of parsed.commands) {
        for (const c of matchTargets(sub.text)) {
          if (findMatch(this.config.bash.deny, c)) return true;
        }
      }
      // Also check extracted path tokens against path deny
      for (const token of parsed.pathTokens) {
        if (this.checkPathDeny(token)) return true;
      }
    } catch {
      // tree-sitter failed, fall back to sync
      return this.checkBashDeny(command);
    }

    // Hardcoded safety net
    return HARD_DENY.some(
      (r) => r.tools.includes("bash") && matchTargets(command).some((c) => r.patterns.some((p) => p.test(c)))
    );
  }

  private async checkBashAllowAsync(command: string): Promise<boolean> {
    // Quick check on the raw command, its wrapper-stripped form, and chain pieces
    for (const c of matchTargets(command)) {
      if (findMatch(this.config.bash.allow, c)) return true;
    }

    // Use tree-sitter to split and check sub-commands
    try {
      const parsed = await parseBashCommand(command);
      for (const sub of parsed.commands) {
        for (const c of matchTargets(sub.text)) {
          if (findMatch(this.config.bash.allow, c)) return true;
        }
      }
    } catch {
      // tree-sitter failed, fall back to sync
      return this.checkBashAllow(command);
    }

    // Hardcoded allow
    return HARD_ALLOW.some(
      (r) => r.tools.includes("bash") && matchTargets(command).some((c) => r.patterns.some((p) => p.test(c)))
    );
  }

  // ─── Session always rules ──────────────────────────────────────────

  private checkAlways(ctx: EvaluateContext): boolean {
    return this.alwaysRules.some((rule) => {
      switch (rule.kind) {
        case "tool":
          return rule.tool === ctx.toolName;
        case "bash_prefix":
          if (!isShellTool(ctx.toolName, ctx.input)) return false;
          return String(ctx.input.command ?? "").startsWith(rule.prefix);
        case "write_path_prefix":
          if (ctx.toolName !== "write" && ctx.toolName !== "edit") return false;
          return String(ctx.input.path ?? "").startsWith(rule.prefix);
        default:
          return false;
      }
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private extract(toolName: string, input: Record<string, unknown>): string {
    if (isShellTool(toolName, input)) return String(input.command ?? "");
    if (["read", "edit", "write"].includes(toolName)) return String(input.path ?? "");
    return "";
  }
}

// ─── Simple chain splitter (synchronous, no tree-sitter) ──────────────

function simpleChainSplit(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\") { current += ch; escaped = true; continue; }
    if (ch === "'" && !inDouble) { current += ch; inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { current += ch; inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    const isChainOp = (ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|");
    const isSeparator = ch === ";" || ch === "|" || ch === "&";
    if (isChainOp || isSeparator) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [cmd];
}
