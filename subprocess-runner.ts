/**
 * Minimal Subprocess Runner for omp-permission-suite
 *
 * Self-contained omp subprocess invocation with no dependency on external subagent extensions.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubprocessResult {
  success: boolean;
  output: string;
  error?: string;
}

interface AgentConfig {
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

export interface CliInvocation {
  command: string;
  prefixArgs: string[];
}

/** Overrides for testing platform-dependent resolution from any host OS. */
export interface CliResolutionEnv {
  platform?: NodeJS.Platform;
  pathValue?: string;
  execPath?: string;
}

let cachedCliInvocation: CliInvocation | undefined;

/**
 * Resolve how to invoke the omp CLI.
 *
 * On Windows the global "omp" is an npm .cmd shim, which child_process.spawn
 * cannot execute without a shell — and shell quoting would corrupt multi-line
 * arguments like the system prompt. Instead, locate the real dist/cli.js next
 * to the shim on PATH and run it with the current runtime.
 *
 * Env-less calls are memoized; calls with an explicit env compute fresh.
 */
export function resolveCliInvocation(env?: CliResolutionEnv): CliInvocation {
  if (!env) {
    cachedCliInvocation ??= computeCliInvocation({});
    return cachedCliInvocation;
  }
  return computeCliInvocation(env);
}

function computeCliInvocation(env: CliResolutionEnv): CliInvocation {
  const platform = env.platform ?? process.platform;
  if (platform !== "win32") return { command: "omp", prefixArgs: [] };

  const pathValue = env.pathValue ?? process.env.PATH ?? "";
  const execPath = env.execPath ?? process.execPath;

  // ";" is the PATH delimiter on win32, the only platform this branch handles
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    const exe = join(dir, "omp.exe");
    if (existsSync(exe)) return { command: exe, prefixArgs: [] };
    if (existsSync(join(dir, "omp.cmd"))) {
      const cliJs = join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
      if (existsSync(cliJs)) return { command: execPath, prefixArgs: [cliJs] };
    }
  }

  return { command: "omp", prefixArgs: [] };
}

export function loadAgent(name: string, agentsDir: string = join(homedir(), ".omp", "agent", "agents")): AgentConfig | null {
  const filePath = join(agentsDir, `${name}.md`);

  if (!existsSync(filePath)) return null;

  try {
    // Normalize BOM and CRLF so frontmatter parsing works on Windows-authored files
    const content = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const get = (key: string) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) return undefined;
      return match[1].match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim();
    };

    return {
      model: get("model"),
      tools: get("tools")?.split(",").map((t) => t.trim()).filter(Boolean),
      systemPrompt: match[2].trim(),
    };
  } catch {
    return null;
  }
}

export async function runSubprocess(
  prompt: string,
  options: {
    model?: string;
    systemPrompt?: string;
    timeout?: number;
  } = {},
): Promise<SubprocessResult> {
  const { model, systemPrompt, timeout = 15000 } = options;

  // --no-extensions/--no-tools keep the approver subprocess lean: it needs no
  // tools, and loading the full extension stack (including this one) is slow
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-tools"];
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  args.push(prompt);

  return new Promise((resolve) => {
    const cli = resolveCliInvocation();
    const proc = spawn(cli.command, [...cli.prefixArgs, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, output: "", error: `Timeout (${timeout}ms)` });
    }, timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: extractOutput(stdout) });
      } else {
        resolve({ success: false, output: stderr || stdout, error: `Exit ${code}` });
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ success: false, output: "", error: err.message });
    });
  });
}

/** Extract the final assistant message text from omp's --mode json output stream. */
export function extractOutput(raw: string): string {
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const parts: string[] = [];
        for (const c of e.message.content ?? []) {
          if (c.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
          }
        }
        return parts.join("");
      }
    } catch {
      // JSON.parse failed — continue to the next line
    }
  }
  return "";
}
