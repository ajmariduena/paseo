import type { AgentPromptInput } from "../agent-sdk-types.js";
import { handoffBudget, type BudgetInput } from "./budget.js";
import { renderEnvelope } from "./envelope.js";
import { historyCost, renderHistoricalItem, renderHistory, selectHistory } from "./history.js";
import { mapHandoffItems } from "./mapping.js";
import type {
  ContextArtifact,
  CoverageRange,
  EnvelopeMetadata,
  HandoffProvenance,
  HandoffSourceRow,
  MissingCoverage,
} from "./types.js";

export interface ContextHandoffInput extends BudgetInput, EnvelopeMetadata {
  rows: readonly HandoffSourceRow[];
  excludeNativeRows: ReadonlySet<string>;
  artifacts: readonly ContextArtifact[];
  missingCoverage: readonly MissingCoverage[];
  receivesPaseoTools: boolean;
  restartNote?: string;
}

function sourceRanges(provenance: readonly HandoffProvenance[]): CoverageRange[] {
  const ranges: CoverageRange[] = [];
  for (const source of provenance) {
    if (source.type !== "row") continue;
    const { segmentId, rowIndex } = source.identity;
    const last = ranges.at(-1);
    const continuesRange = last && last.segmentId === segmentId && last.toRowIndex + 1 === rowIndex;
    if (continuesRange) {
      last.toRowIndex = rowIndex;
    } else {
      ranges.push({ segmentId, fromRowIndex: rowIndex, toRowIndex: rowIndex });
    }
  }
  return ranges;
}

export function buildContextHandoff(input: ContextHandoffInput) {
  const budget = handoffBudget(input);
  const mapped = mapHandoffItems(input);
  const provenance = [...mapped.items.map((item) => item.provenance), ...mapped.omittedItems];
  const ranges = sourceRanges(provenance);
  const recovery = input.receivesPaseoTools
    ? "Recover retained history using get_agent_activity; use its returned paging cursors. Dropped or unavailable history may not be recoverable."
    : "Dropped or unavailable history may not be recoverable.";
  const sourceCount = provenance.length;
  const missingCount = input.missingCoverage.length;
  const summary = `Provider context handoff. ${sourceCount} source items; ${missingCount} dropped/unavailable ranges.`;
  const details = `Source ranges: ${JSON.stringify(ranges)}. Missing ranges: ${JSON.stringify(input.missingCoverage)}.`;
  let coverage = `${summary}\n${details}\n${recovery}`;
  const coverageCost = historyCost({ messages: [], context: coverage, envelope: input });
  const collapsed = coverageCost > Math.min(4_000, budget.available / 2);
  if (collapsed) coverage = `${summary} Detailed coverage references omitted.\n${recovery}`;
  let selectionCoverage = coverage;
  if (input.restartNote) selectionCoverage += `\n\n${input.restartNote}`;
  const selected = selectHistory({
    messages: mapped.items,
    omittedItems: mapped.omittedItems,
    coverage: selectionCoverage,
    budget: budget.available,
    envelope: input,
  });
  const history = renderHistory(selected.messages, selected.context);
  const prefix = renderEnvelope({ ...input, history });
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
