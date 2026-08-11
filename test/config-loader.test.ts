/**
 * Config loader — builtin default resolution tests
 *
 * The key regression: builtinConfigPath used url.pathname, which yields
 * "/D:/..." on Windows, so the shipped defaults were never found and users
 * silently got the minimal empty config.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config-loader.ts";

function withTempConfig(fn: (configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pps-config-"));
  try {
    fn(join(dir, "config.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig: missing file is populated from the shipped defaults, not the empty fallback", () => {
  withTempConfig((configPath) => {
    const config = loadConfig(configPath);

    // Fails on any platform where builtinConfigPath doesn't resolve
    expect(Object.keys(config.bash.allow).length).toBeGreaterThan(50);
    expect(config.bash.allow["git status *"]).toBe(true);
    expect(Object.keys(config.bash.deny).length).toBeGreaterThan(5);

    // And the file was written for next time
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(onDisk.bash.allow["git status *"]).toBe(true);
  });
});

test("loadConfig: corrupted file is replaced with the shipped defaults", () => {
  withTempConfig((configPath) => {
    writeFileSync(configPath, "{ not json !!!", "utf-8");
    const config = loadConfig(configPath);
    expect(Object.keys(config.bash.allow).length).toBeGreaterThan(50);
  });
});

test("loadConfig: existing valid config is returned as-is, not overwritten", () => {
  withTempConfig((configPath) => {
    const custom = {
      bash: { deny: { "custom *": "no" }, allow: { "mycmd *": true } },
      path: { deny: {}, allow: {} },
    };
    writeFileSync(configPath, JSON.stringify(custom), "utf-8");

    const config = loadConfig(configPath);
    expect(config.bash.allow["mycmd *"]).toBe(true);
    expect(config.bash.allow["git status *"]).toBeUndefined();
  });
});
