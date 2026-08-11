/**
 * Oh My Pi Permission Suite — Shared Types
 */

/** Approval mode */
export type ApprovalMode = "act" | "auto" | "ask" | "plan";

/** Approval decision */
export interface ApprovalDecision {
  approved: boolean;
  source: "subagent" | "human";
  reason?: string;
}

/** Persisted state */
export interface ApprovalState {
  mode: ApprovalMode;
  approved: number;
  denied: number;
  escalated: number;
}
