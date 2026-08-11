/**
 * Subprocess Runner — loadAgent tests
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "../subprocess-runner.ts";

function withAgentFile(content: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pps-agents-"));
  try {
    writeFileSync(join(dir, "approver.md"), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BODY = "You are a security approver.";

test("loadAgent: parses LF frontmatter", () => {
  withAgentFile(`---\nmodel: github-copilot/claude-haiku-4.5\n---\n${BODY}`, (dir) => {
    const agent = loadAgent("approver", dir);
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("github-copilot/claude-haiku-4.5");
    expect(agent!.systemPrompt).toBe(BODY);
  });
});

test("loadAgent: parses CRLF frontmatter (Windows-authored files)", () => {
  withAgentFile(`---\r\nmodel: github-copilot/claude-haiku-4.5\r\n---\r\n${BODY}\r\n`, (dir) => {
    const agent = loadAgent("approver", dir);
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("github-copilot/claude-haiku-4.5");
    expect(agent!.systemPrompt).toBe(BODY);
  });
});

test("loadAgent: strips UTF-8 BOM", () => {
  withAgentFile("\uFEFF" + `---\r\nmodel: m\r\n---\r\n${BODY}`, (dir) => {
    const agent = loadAgent("approver", dir);
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("m");
  });
});

test("loadAgent: returns null for missing file", () => {
  withAgentFile(`---\nmodel: m\n---\n${BODY}`, (dir) => {
    expect(loadAgent("nonexistent", dir)).toBeNull();
  });
});

// ─── resolveCliInvocation ──────────────────────────────────────────────

import { mkdirSync } from "node:fs";
import { resolveCliInvocation } from "../subprocess-runner.ts";

function withFakePathDirs(setup: (dirs: string[]) => void, fn: (pathValue: string, dirs: string[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pps-path-"));
  try {
    const dirs = [join(root, "a"), join(root, "b")];
    for (const d of dirs) mkdirSync(d, { recursive: true });
    setup(dirs);
    fn(dirs.join(";"), dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveCliInvocation: POSIX platforms pass 'omp' through untouched", () => {
  const r = resolveCliInvocation({ platform: "linux", pathValue: "/usr/bin", execPath: "/usr/bin/node" });
  expect(r).toEqual({ command: "omp", prefixArgs: [] });
});

test("resolveCliInvocation: win32 prefers omp.exe when present", () => {
  withFakePathDirs(
    (dirs) => writeFileSync(join(dirs[0], "omp.exe"), ""),
    (pathValue, dirs) => {
      const r = resolveCliInvocation({ platform: "win32", pathValue, execPath: "X:\node.exe" });
      expect(r).toEqual({ command: join(dirs[0], "omp.exe"), prefixArgs: [] });
    },
  );
});

test("resolveCliInvocation: win32 resolves omp.cmd shim to runtime + cli.js", () => {
  withFakePathDirs(
    (dirs) => {
      writeFileSync(join(dirs[1], "omp.cmd"), "");
      const cliDir = join(dirs[1], "node_modules", "@oh-my-pi", "pi-coding-agent", "dist");
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, "cli.js"), "");
    },
    (pathValue, dirs) => {
      const r = resolveCliInvocation({ platform: "win32", pathValue, execPath: "X:\node.exe" });
      expect(r.command).toBe("X:\node.exe");
      expect(r.prefixArgs).toEqual([join(dirs[1], "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js")]);
    },
  );
});

test("resolveCliInvocation: win32 skips an omp.cmd shim whose cli.js is missing", () => {
  withFakePathDirs(
    (dirs) => {
      writeFileSync(join(dirs[0], "omp.cmd"), ""); // shim without cli.js — unusable
      writeFileSync(join(dirs[1], "omp.exe"), "");
    },
    (pathValue, dirs) => {
      const r = resolveCliInvocation({ platform: "win32", pathValue, execPath: "X:\node.exe" });
      expect(r).toEqual({ command: join(dirs[1], "omp.exe"), prefixArgs: [] });
    },
  );
});

test("resolveCliInvocation: win32 with nothing on PATH falls back to bare 'omp'", () => {
  withFakePathDirs(
    () => {},
    (pathValue) => {
      const r = resolveCliInvocation({ platform: "win32", pathValue, execPath: "X:\node.exe" });
      expect(r).toEqual({ command: "omp", prefixArgs: [] });
    },
  );
});

// ─── extractOutput ─────────────────────────────────────────────────────

import { extractOutput } from "../subprocess-runner.ts";

const verdict = '{"approved": true, "reason": "ok", "confidence": 0.9}';

function messageEnd(text: string): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

test("extractOutput: extracts final assistant message from LF stream", () => {
  const raw = ['{"type":"noise"}', "not json at all", messageEnd(verdict)].join("\n");
  expect(extractOutput(raw)).toBe(verdict);
});

test("extractOutput: tolerates CRLF-terminated stream lines", () => {
  const raw = ['{"type":"noise"}', messageEnd(verdict)].join("\r\n") + "\r\n";
  expect(extractOutput(raw)).toBe(verdict);
});

test("extractOutput: joins multiple text parts", () => {
  const raw = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "part1 " }, { type: "thinking", thinking: "skip" }, { type: "text", text: "part2" }] },
  });
  expect(extractOutput(raw)).toBe("part1 part2");
});

test("extractOutput: last assistant message wins", () => {
  const raw = [messageEnd("first"), messageEnd("second")].join("\n");
  expect(extractOutput(raw)).toBe("second");
});

test("extractOutput: empty when no assistant message present", () => {
  expect(extractOutput("")).toBe("");
  expect(extractOutput('{"type":"other"}\ngarbage')).toBe("");
});
