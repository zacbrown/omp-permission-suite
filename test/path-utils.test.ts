/**
 * Path utilities — cross-platform tests
 *
 * Written to pass on both POSIX and Windows: expectations are built with
 * node:path so each platform asserts against its own native form.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expandHome, normalizePath, canonicalizePath, isPathWithinDirectory } from "../path-utils.ts";
import { RuleEngine } from "../rules.ts";

const isWin = process.platform === "win32";

// ─── expandHome ────────────────────────────────────────────────────────

test("expandHome: bare forms", () => {
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("$HOME")).toBe(homedir());
  expect(expandHome("no-tilde/path")).toBe("no-tilde/path");
});

test("expandHome: slash and backslash separators", () => {
  expect(expandHome("~/x/y")).toBe(join(homedir(), "x/y"));
  expect(expandHome("~\\x\\y")).toBe(join(homedir(), "x\\y"));
  expect(expandHome("$HOME/x")).toBe(join(homedir(), "x"));
  expect(expandHome("$HOME\\x")).toBe(join(homedir(), "x"));
});

// ─── normalizePath ─────────────────────────────────────────────────────

test("normalizePath: resolves against cwd in native form", () => {
  const cwd = process.cwd();
  expect(normalizePath("a/b.ts", cwd)).toBe(resolve(cwd, "a/b.ts"));
  expect(normalizePath("  'a/b.ts'  ", cwd)).toBe(resolve(cwd, "a/b.ts"));
  expect(normalizePath("", cwd)).toBe("");
  // Absolute input stays absolute
  const abs = resolve(cwd, "x");
  expect(normalizePath(abs, cwd)).toBe(abs);
});

test("normalizePath: forward slashes normalize to native separators", () => {
  const cwd = process.cwd();
  const out = normalizePath("dir/sub/file.txt", cwd);
  expect(out).toBe(resolve(cwd, "dir", "sub", "file.txt"));
  if (isWin) expect(out).toContain(sep);
});

// ─── canonicalizePath ──────────────────────────────────────────────────

test("canonicalizePath: existing path resolves, nonexistent tail is preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "pps-canon-"));
  try {
    const real = canonicalizePath(dir);
    expect(real.endsWith(sep + "nope")).toBe(false);

    // Nonexistent tail under an existing dir: tail re-joined onto the real prefix
    const ghost = join(dir, "missing", "leaf.txt");
    const canon = canonicalizePath(ghost);
    expect(canon).toBe(join(real, "missing", "leaf.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalizePath: never produces doubled-drive garbage on Windows-style paths", () => {
  // Regression: the old implementation split on "/" only, so a Windows path
  // like D:\proj\file degenerated to realpath("/") + join → "C:\D:\proj\file"
  const ghost = join(process.cwd(), "definitely-missing-dir", "file.txt");
  const canon = canonicalizePath(ghost);
  expect(canon).not.toMatch(/[A-Za-z]:[\\/].*[A-Za-z]:[\\/]/);
  expect(canon.endsWith(join("definitely-missing-dir", "file.txt"))).toBe(true);
});

test("canonicalizePath: empty input passthrough", () => {
  expect(canonicalizePath("")).toBe("");
});

// ─── isPathWithinDirectory ─────────────────────────────────────────────

test("isPathWithinDirectory: native forms", () => {
  const base = resolve(process.cwd(), "proj");
  expect(isPathWithinDirectory(join(base, "src", "a.ts"), base)).toBe(true);
  expect(isPathWithinDirectory(base, base)).toBe(true);
  expect(isPathWithinDirectory(resolve(process.cwd(), "other"), base)).toBe(false);
});

// ─── Engine-level path rules with platform-shaped inputs ──────────────

test("RuleEngine: ~/.ssh deny matches native absolute path", () => {
  const rules = new RuleEngine();
  expect(rules.evaluate("read", { path: "~/.ssh/id_rsa" })).toBe("deny");
  expect(rules.evaluate("read", { path: join(homedir(), ".ssh", "id_rsa") })).toBe("deny");
});

test.if(isWin)("RuleEngine: Windows-style paths hit deny rules", () => {
  const rules = new RuleEngine();
  expect(rules.evaluate("read", { path: "~\\.ssh\\id_rsa" })).toBe("deny");
  expect(rules.evaluate("read", { path: homedir() + "\\.ssh\\id_rsa" })).toBe("deny");
  // Forward-slash spelling of the same file
  expect(rules.evaluate("read", { path: homedir().replaceAll("\\", "/") + "/.ssh/id_rsa" })).toBe("deny");
});

test("RuleEngine: .env deny matches relative and absolute native forms", () => {
  const rules = new RuleEngine();
  expect(rules.evaluate("read", { path: ".env" })).toBe("deny");
  expect(rules.evaluate("read", { path: join(process.cwd(), ".env") })).toBe("deny");
});
