import type { AgentTimelineRow } from "../agent-timeline-store-types.js";

export class HandoffInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid handoff input: ${field}`);
    this.name = "HandoffInputError";
  }
}

export interface RowIdentity {
  segmentId: string;
  rowIndex: number;
}

export interface HandoffSourceRow {
  identity: RowIdentity;
  row: AgentTimelineRow;
  scope: "parent" | "child";
  interrupted?: boolean;
}

export interface ContextArtifact {
  id: string;
  text: string;
  origin: string;
}

export type HandoffProvenance =
  | { type: "row"; identity: RowIdentity }
  | { type: "artifact"; id: string; origin: string };

export type HandoffOrigin =
  | { kind: "user" | "assistant" }
  | { kind: "agent"; agentId: string }
  | { kind: "tool"; name: string; callId: string }
  | { kind: "artifact"; source: string };

export interface HandoffItem {
  role: "user" | "assistant";
  kind: "user_message" | "assistant_message" | "tool_call" | "error" | "context_artifact";
  text: string;
  provenance: HandoffProvenance;
  origin: HandoffOrigin;
  status: "completed" | "running" | "failed" | "canceled" | "interrupted";
}

export interface EnvelopeMetadata {
  id: string;
  from: string;
  to: string;
}

export interface CoverageRange {
  segmentId: string;
  fromRowIndex: number;
  toRowIndex: number;
}

export interface MissingCoverage {
  reason: "dropped" | "unavailable";
  range: CoverageRange;
}
