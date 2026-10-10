import type { AgentPromptInput } from "../agent-sdk-types.js";
import { handoffBudget, type BudgetInput, type HandoffBudget } from "./budget.js";
import { renderEnvelope } from "./envelope.js";
import { historyCost, renderHistoricalItem, renderHistory, selectHistory } from "./history.js";
import { mapHandoffItems } from "./mapping.js";
import type {
  ContextArtifact,
  CoverageRange,
  EnvelopeMetadata,
  HandoffProvenance,
  HandoffItem,
  HandoffSourceRow,
  MissingCoverage,
  RowIdentity,
} from "./types.js";

export interface ContextHandoffInput extends BudgetInput, EnvelopeMetadata {
  rows: readonly HandoffSourceRow[];
  excludeNativeRows: ReadonlySet<string>;
  artifacts: readonly ContextArtifact[];
  missingCoverage: readonly MissingCoverage[];
  receivesPaseoTools: boolean;
  // Included and charged here; the caller must not also prepend the restart note to this wire prompt.
  restartNote?: string;
}

export interface RenderedHandoffItem extends HandoffItem {
  rendered: string;
}

export interface HandoffCoverage {
  text: string;
  ranges: CoverageRange[];
  missing: readonly MissingCoverage[];
  collapsed: boolean;
}

export interface ContextHandoff {
  canonicalPrompt: AgentPromptInput;
  wirePrompt: AgentPromptInput;
  items: RenderedHandoffItem[];
  omittedItems: HandoffProvenance[];
  coverage: HandoffCoverage;
  budget: HandoffBudget;
  cost: number;
}

function rangeScope(identity: { segmentId: string; incarnationId?: string }): string {
  return `${identity.segmentId}\u0000${identity.incarnationId ?? ""}`;
}

function sourceRanges(sourceRows: readonly RowIdentity[]): CoverageRange[] {
  const sorted = [...sourceRows].sort((left, right) => {
    const leftScope = rangeScope(left);
    const rightScope = rangeScope(right);
    if (leftScope < rightScope) return -1;
    if (leftScope > rightScope) return 1;
    return left.rowIndex - right.rowIndex;
  });
  const ranges: CoverageRange[] = [];
  for (const identity of sorted) {
    const { segmentId, incarnationId, rowIndex } = identity;
    const last = ranges.at(-1);
    const continuesRange =
      last && rangeScope(last) === rangeScope(identity) && last.toRowIndex + 1 === rowIndex;
    if (continuesRange) {
      last.toRowIndex = rowIndex;
    } else {
      ranges.push({
        segmentId,
        ...(incarnationId ? { incarnationId } : {}),
        fromRowIndex: rowIndex,
        toRowIndex: rowIndex,
      });
    }
  }
  return ranges;
}

function renderRange(range: CoverageRange): string {
  const scope = range.incarnationId
    ? `${encodeURIComponent(range.segmentId)}/${encodeURIComponent(range.incarnationId)}`
    : encodeURIComponent(range.segmentId);
  return `${scope}:${range.fromRowIndex}-${range.toRowIndex}`;
}

export function buildContextHandoff(input: ContextHandoffInput): ContextHandoff {
  const {
    id,
    from,
    to,
    prompt,
    occupancy,
    contextWindow,
    cap,
    rows,
    excludeNativeRows,
    artifacts,
  } = input;
  const envelope: EnvelopeMetadata = { id, from, to };
  const budget = handoffBudget({ prompt, occupancy, contextWindow, cap });
  const mapped = mapHandoffItems({ rows, excludeNativeRows, artifacts });
  const ranges = sourceRanges(mapped.sourceRows);
  const recovery = input.receivesPaseoTools
    ? "Recover retained history using get_agent_activity; use its returned paging cursors. Dropped or unavailable history may not be recoverable."
    : "Dropped or unavailable history may not be recoverable.";
  const sourceCount = mapped.items.length + mapped.omittedItems.length;
  const missingCount = input.missingCoverage.length;
  const summary = `Provider context handoff. ${sourceCount} source items; ${missingCount} dropped/unavailable ranges.`;
  const sourceReferences = ranges.map(renderRange).join(", ") || "none";
  const missingReferences =
    input.missingCoverage
      .map((entry) => `${entry.reason}:${renderRange(entry.range)}`)
      .join(", ") || "none";
  const details = `Source ranges: ${sourceReferences}. Missing ranges: ${missingReferences}.`;
  let coverage = `${summary}\n${details}\n${recovery}`;
  const coverageCost = historyCost({ messages: [], context: coverage, envelope });
  // Coverage collapse adapted from T3 Code ContextHandoffDelivery.ts; see LICENSE.t3code.
  const collapsed = coverageCost > Math.min(4_000, budget.available / 2);
  if (collapsed) coverage = `${summary} Detailed coverage references omitted.\n${recovery}`;
  let selectionCoverage = coverage;
  if (input.restartNote) selectionCoverage += `\n\n${input.restartNote}`;
  const selected = selectHistory({
    messages: mapped.items,
    omittedItems: mapped.omittedItems,
    coverage: selectionCoverage,
    budget: budget.available,
    envelope,
  });
  const history = renderHistory(selected.messages, selected.context);
  const prefix = renderEnvelope({ ...envelope, history });
  let wirePrompt: AgentPromptInput;
  if (typeof input.prompt === "string") {
    wirePrompt = `${prefix}${input.prompt}`;
  } else {
    wirePrompt = [{ type: "text", text: prefix }, ...input.prompt];
  }
  const items = selected.messages.map((item) => ({
    ...item,
    rendered: renderHistoricalItem(item),
  }));
  return {
    canonicalPrompt: input.prompt,
    wirePrompt,
    items,
    omittedItems: selected.omittedItems,
    coverage: { text: coverage, ranges, missing: input.missingCoverage, collapsed },
    budget,
    cost: selected.cost,
  };
}
