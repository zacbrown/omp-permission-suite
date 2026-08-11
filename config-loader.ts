/**
 * Config loader for omp-permission-suite
 *
 * Reads config from ~/.omp/agent/extensions/omp-permission-suite/config.json.
 * If the file doesn't exist, creates it with the default content.
 * No hardcoded TypeScript defaults — config.json is the single source of truth.
 *
 * Config structure:
 * {
 *   "bash": {
 *     "deny": { "pattern": "reason", ... },
 *     "allow": { "pattern": true, ... }
 *   },
 *   "path": {
 *     "deny": { "pattern": "reason", ... },
 *     "allow": { "pattern": true, ... }
 *   },
 *   "external_directory": "mode" | "deny" | "allow"
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApprovalConfig {
  bash: {
    deny: Record<string, string>;
    allow: Record<string, boolean>;
  };
  path: {
    deny: Record<string, string>;
    allow: Record<string, boolean>;
  };
  /** Whole-tool rules keyed by tool name (wildcards supported), e.g. {"memory": true} */
  tools?: {
    deny: Record<string, string>;
    allow: Record<string, boolean>;
  };
}

/** Path to the user's config file */
export function getConfigPath(): string {
  return homedir() + "/.omp/agent/extensions/omp-permission-suite/config.json";
}

/** Path to the shipped default config (alongside this source file) */
function builtinConfigPath(): string {
  // fileURLToPath, not url.pathname: pathname yields "/D:/..." on Windows, which breaks path joins
  return join(fileURLToPath(new URL(".", import.meta.url)), "config.default.json");
}

export function loadConfig(path: string = getConfigPath()): ApprovalConfig {
  // File exists → read it
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as ApprovalConfig;
      return parsed;
    } catch {
      // Corrupted file → fall through to write fresh
    }
  }

  // File missing or corrupted → create dir, write the builtin default, then read
  mkdirSync(dirname(path), { recursive: true });
  const builtin = builtinConfigPath();
  if (existsSync(builtin)) {
    try {
      const content = readFileSync(builtin, "utf-8");
      writeFileSync(path, content, "utf-8");
      return JSON.parse(content) as ApprovalConfig;
    } catch {
      // Builtin default config is corrupted — fall through to the minimal default
    }
  }

  // Last resort: minimal safe default (shouldn't happen if package is intact)
  const minimal: ApprovalConfig = {
    bash: { deny: {}, allow: {} },
    path: { deny: {}, allow: {} },
    tools: { deny: {}, allow: {} },
    external_directory: "mode",
  };
  writeFileSync(path, JSON.stringify(minimal, null, 2), "utf-8");
  return minimal;
}
