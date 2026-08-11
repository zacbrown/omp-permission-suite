/**
 * Oh My Pi Permission Suite Extension
 *
 * Modes: Act / Auto / Ask / Plan
 * Shortcut: Ctrl+Y (cycles modes)
 * Command: /approval-mode
 * Tool: set_approval_mode (callable by the agent)
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalMode, ApprovalState } from "./types.ts";
import { RuleEngine } from "./rules.ts";
import { autoApprove } from "./approver.ts";

// ─── Mode configuration ────────────────────────────────────────────

// Enforcement of Ask/Plan read-only access is driven entirely by the rule
// engine's allow layer (path-utils READONLY_TOOLS + rules HARD_ALLOW), not by
// this table — MODE only carries the label and icon shown in the status line.
const MODE: Record<ApprovalMode, { desc: string; icon: string }> = {
  ask:  { desc: "Read-only Q&A", icon: "❓" },
  auto: { desc: "Subagent approval", icon: "🤖" },
  act:  { desc: "Full permissions", icon: "⚡" },
  plan: { desc: "Read-only planning", icon: "📋" },
};

const ORDER: ApprovalMode[] = ["act", "auto", "ask", "plan"];

// ─── Shared state ──────────────────────────────────────────────────

interface SuiteState {
  mode: ApprovalMode;
  stats: { approved: number; denied: number; escalated: number };
  rules: RuleEngine;
}

function createState(): SuiteState {
  return { mode: "act", stats: { approved: 0, denied: 0, escalated: 0 }, rules: new RuleEngine() };
}

function cfg(m: ApprovalMode) { return MODE[m]; }

function apply(state: SuiteState, m: ApprovalMode, pi: ExtensionAPI) {
  state.mode = m;
  pi.appendEntry("omp-permission-suite.state", { mode: m, ...state.stats } satisfies ApprovalState);
}

function updateStatus(state: SuiteState, ctx: ExtensionContext) {
  ctx.ui.setStatus("omp-permission-suite", ctx.ui.theme.fg("accent", `${cfg(state.mode).icon} ${state.mode.toUpperCase()}`));
}

// ─── Command registration ──────────────────────────────────────────

function registerApprovalModeCommand(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerCommand("approval-mode", {
    description: "Switch approval mode (ask/auto/act/plan)",
    getArgumentCompletions: (p) => {
      const out: Array<{ value: string; label: string }> = [];
      for (const m of ORDER) {
        if (m.startsWith(p)) out.push({ value: m, label: `${cfg(m).icon} ${m}` });
      }
      return out;
    },
    handler: async (args, ctx) => {
      const t = args?.trim().toLowerCase() as ApprovalMode | undefined;
      if (t && MODE[t]) apply(state, t, pi);
      else {
        const ch = await ctx.ui.select("Mode:", ORDER.map((m) => ({ label: `${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, value: m })));
        if (ch) apply(state, ch, pi); else return;
      }
      updateStatus(state, ctx);
    },
  });
}

// ─── Tool registration ─────────────────────────────────────────────

function registerApprovalModeTool(pi: ExtensionAPI, state: SuiteState): void {
  const z = pi.zod;
  pi.registerTool({
    name: "set_approval_mode",
    label: "Set Approval Mode",
    description: `Switch the approval mode.

Available modes:
• act - full permissions (default)
• auto - subagent approval
• ask - read-only Q&A
• plan - read-only planning`,
    parameters: z.object({
      mode: z.enum(["act", "auto", "ask", "plan"]).describe("Target mode to switch to"),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const m = params.mode as ApprovalMode;
      const prev = state.mode;
      apply(state, m, pi);
      updateStatus(state, ctx);
      return {
        content: [{ type: "text" as const, text: `Switched from ${prev} to ${m} mode. ${cfg(m).desc}` }],
      };
    },
  });
}

// ─── Shortcut registration ─────────────────────────────────────────

function registerApprovalShortcut(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerShortcut("ctrl+y", {
    description: "Cycle through approval modes",
    handler: (ctx) => {
      const next = ORDER[(ORDER.indexOf(state.mode) + 1) % ORDER.length];
      apply(state, next, pi);
      updateStatus(state, ctx);
    },
  });
}

// ─── tool_call handling ────────────────────────────────────────────

async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: SuiteState,
): Promise<{ block: true; reason: string } | undefined> {
  const toolName = event.toolName;
  const inp = event.input as Record<string, unknown>;

  // 1. Deny rules (all modes) — shell tools use async tree-sitter parsing,
  // everything else takes the sync path inside evaluateAsync
  const result = await state.rules.evaluateAsync(toolName, inp);

  if (result === "deny") {
    const msg = state.rules.getDenyMessage(toolName, inp) ?? "Blocked by security rules";
    state.stats.denied++;
    ctx.ui.notify(msg, "error");
    return { block: true, reason: msg };
  }

  // 2. Act: allow everything
  if (state.mode === "act") { state.stats.approved++; return undefined; }

  // 3. Ask/Plan: read-only (reuse ALLOW rules; read-only bash commands also pass)
  if (state.mode === "ask" || state.mode === "plan") {
    if (result === "allow") {
      state.stats.approved++;
      return undefined;
    }
    state.stats.denied++;
    return { block: true, reason: `${cfg(state.mode).icon} ${state.mode.toUpperCase()}: ${toolName} is disabled` };
  }

  // 4. Auto: allow rules pass, everything else goes through the subagent
  if (state.mode === "auto") {
    if (result === "allow") { state.stats.approved++; return undefined; }

    ctx.ui.setStatus("omp-permission-suite", ctx.ui.theme.fg("warning", "🤖 Approving..."));
    const decision = await autoApprove(ctx, toolName, inp);

    if (decision.approved) {
      state.stats.approved++;
      if (decision.source === "human") state.stats.escalated++;
    } else {
      state.stats.denied++;
    }
    updateStatus(state, ctx);

    return decision.approved
      ? undefined
      : { block: true, reason: `Auto denied (${decision.source}): ${decision.reason}` };
  }

  return undefined;
}

// ─── before_agent_start handling ───────────────────────────────────

function handleBeforeAgentStart(state: SuiteState) {
  return {
    message: {
      customType: "omp-permission-suite.context",
      content: `[Approval: ${cfg(state.mode).icon} ${state.mode.toUpperCase()}] ${cfg(state.mode).desc}`,
      display: false,
    },
  };
}

// ─── session_start handling ────────────────────────────────────────

function handleSessionStart(
  ctx: ExtensionContext,
  state: SuiteState,
): void {
  let latest: ApprovalState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      typeof entry === "object" && entry !== null &&
      (entry as { type?: unknown }).type === "custom" &&
      (entry as { customType?: unknown }).customType === "omp-permission-suite.state"
    ) {
      latest = (entry as { data?: ApprovalState }).data;
    }
  }
  const e = latest ? { data: latest } : undefined;

  if (e?.data) {
    state.mode = e.data.mode ?? "act";
    state.stats.approved = e.data.approved ?? 0;
    state.stats.denied = e.data.denied ?? 0;
    state.stats.escalated = e.data.escalated ?? 0;
  }

  state.rules.setCwd(ctx.cwd);
  updateStatus(state, ctx);
}

// ─── Extension entry point ─────────────────────────────────────────

export default function(pi: ExtensionAPI): void {
  const state = createState();

  registerApprovalModeCommand(pi, state);
  registerApprovalModeTool(pi, state);
  registerApprovalShortcut(pi, state);

  pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx, state));
  pi.on("before_agent_start", () => handleBeforeAgentStart(state));
  pi.on("session_start", (_event, ctx) => handleSessionStart(ctx, state));
}
