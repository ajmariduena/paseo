import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";

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

export interface HandoffItem {
  role: "user" | "assistant";
  kind: AgentTimelineItem["type"] | "context_artifact";
  text: string;
  provenance: HandoffProvenance;
  origin: string;
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
