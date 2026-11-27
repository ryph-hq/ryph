// Turning the metering trail into a report. The store SUMS tokens per group and tier bucket; this
// PRICES each of those sums against the catalogue and rolls them up — pure, so every rule of the
// money is unit-tested with plain rows.
//
// Invariants:
// - a row is priced before it is summed with another: its tier bucket is only meaningful alone
// - an unpriced model's tokens still count; its cost is left out and its requests say so
// - an included model's tokens count too, at $0, and its requests say THAT — so a report never
//   passes a plan's usage off as free list-price spend, nor as spend it could not price
// - requests without a usage report (errors, model lists, streams that carried none) count as
//   requests and add nothing else
// - the OVERLAY is a parameter, not a lookup: a custom endpoint's declared prices are rows, and
//   this file stays pure by being handed them rather than reaching for a store
// - a row the provider stated its bill for (OpenRouter's `costUsd`) costs exactly that: the
//   store sums those apart (`costReported`), and their total is the reported sum, never a list
//   price. Its breakdown is the catalogue's, scaled to that total — all of it under output when
//   the catalogue cannot split it — and it is never counted as unpriced. A model's estimated and
//   unreported rows are priced from the catalogue as ever, and added to it

import {
  type CostBreakdown,
  costOf,
  included,
  priceFor,
  type PriceOverlay,
  type PricingKind,
  pricingOf,
  type TokenCounts,
  ZERO_COST,
} from "./pricing.ts";

/** What a report groups the trail by. */
export type UsageDimension = "model" | "agent" | "providerKey" | "day" | "task";

export interface UsageAggregateQuery {
  /** One run's trail only. */
  runId?: string;
  /** Inclusive lower bound on `at`, ISO-8601. */
  from?: string;
  /** Exclusive upper bound on `at`, ISO-8601. */
  to?: string;
  /** The dimensions to group by, each answered separately — but all from one snapshot. */
  by: readonly UsageDimension[];
  /** The tier buckets to sum in: the catalogue's TIER_THRESHOLDS. */
  tierThresholds: readonly number[];
}

/** One group's sums: a dimension key × provider × model × tier bucket. */
export interface UsageAggregateRow {
  /**
   * By `model`: null (the model is in the row). By `agent`: the agent id, or the platform principal
   * (`platform:<consumer>`) for spend that belongs to no agent. By `providerKey`: the key id. By
   * `day`: `YYYY-MM-DD` in UTC. By `task`: the task id, null for a platform principal.
   */
  key: string | null;
  provider: string;
  model: string | null;
  /** See tierFloorOf. */
  tierFloor: number;
  requests: number;
  failedRequests: number;
  meteredRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  /** Whether these rows carry the provider's own bill (`cost_usd`). The store groups rows that
   * do apart from rows that do not, so one key, provider, model and tier can come as two rows. */
  costReported: boolean;
  /** The sum of that bill, USD; 0 when `costReported` is false. */
  reportedCostUsd: number;
}

export interface UsageTotals {
  requests: number;
  /** The upstream answered 4xx or 5xx. */
  failedRequests: number;
  /** Carried a usage report — the requests the token counts come from. */
  meteredRequests: number;
  /** Metered on a model the price catalogue does not list: tokens counted, cost left out. */
  unpricedRequests: number;
  /** Metered on a ChatGPT plan: tokens counted, cost $0 because the plan pays for them. */
  includedRequests: number;
  /** Costed at what the provider itself billed (OpenRouter's `usage.cost`), not at list price. */
  reportedRequests: number;
  tokens: Omit<TokenCounts, "cacheWrite1h">;
  /** USD. */
  cost: CostBreakdown;
}

export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string | null;
  /** How this model's cost was arrived at: list prices, a plan's included usage, the provider's
   * own bill (`reported`, when any of its calls carried one), or nothing. */
  pricing: PricingKind;
}

export interface UsageGroup {
  key: string | null;
  totals: UsageTotals;
  /** Highest cost first. */
  models: ModelUsage[];
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    failedRequests: 0,
    meteredRequests: 0,
    unpricedRequests: 0,
    includedRequests: 0,
    reportedRequests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: { ...ZERO_COST },
  };
}

function add(
  totals: UsageTotals,
  row: UsageAggregateRow,
  cost: CostBreakdown,
  unpriced: number,
  includedHere: number,
  reported: number,
) {
  totals.requests += row.requests;
  totals.failedRequests += row.failedRequests;
  totals.meteredRequests += row.meteredRequests;
  totals.unpricedRequests += unpriced;
  totals.includedRequests += includedHere;
  totals.reportedRequests += reported;
  totals.tokens.input += row.inputTokens;
  totals.tokens.output += row.outputTokens;
  totals.tokens.cacheRead += row.cacheReadTokens;
  totals.tokens.cacheWrite += row.cacheWriteTokens;
  totals.tokens.reasoning += row.reasoningTokens;
  totals.cost.input += cost.input;
  totals.cost.output += cost.output;
  totals.cost.cacheRead += cost.cacheRead;
  totals.cost.cacheWrite += cost.cacheWrite;
  totals.cost.total += cost.total;
}

const byCost = (a: UsageTotals, b: UsageTotals) =>
  b.cost.total - a.cost.total || b.requests - a.requests;

/**
 * A breakdown scaled to the total the provider billed: the catalogue's split of it in proportion,
 * or — when the catalogue cannot split it (no price, or a price of $0) — all of it under output.
 */
function scaledTo(breakdown: CostBreakdown, total: number): CostBreakdown {
  if (!(breakdown.total > 0)) return { ...ZERO_COST, output: total, total };
  const k = total / breakdown.total;
  return {
    input: breakdown.input * k,
    output: breakdown.output * k,
    cacheRead: breakdown.cacheRead * k,
    cacheWrite: breakdown.cacheWrite * k,
    total,
  };
}

/** Prices every row and rolls the rows up per key. Groups come back highest cost first. The
 * overlay, when given, prices the custom endpoints' declared models and OpenRouter's synced ones
 * (see priceOverlayFrom). */
export function rollUp(
  rows: readonly UsageAggregateRow[],
  overlay?: PriceOverlay,
): UsageGroup[] {
  const groups = new Map<string | null, { totals: UsageTotals; models: Map<string, ModelUsage> }>();
  for (const row of rows) {
    const price = row.meteredRequests > 0 ? priceFor(row.provider, row.model, overlay) : null;
    const listed = price === null ? ZERO_COST : costOf(price, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens,
      cacheWrite1h: row.cacheWrite1hTokens,
      reasoning: row.reasoningTokens,
    }, row.tierFloor);
    const cost = row.costReported ? scaledTo(listed, row.reportedCostUsd) : listed;
    const unpriced = !row.costReported && price === null ? row.meteredRequests : 0;
    const includedHere = included(row.provider) ? row.meteredRequests : 0;
    const reported = row.costReported ? row.meteredRequests : 0;

    let group = groups.get(row.key);
    if (group === undefined) {
      group = { totals: emptyTotals(), models: new Map() };
      groups.set(row.key, group);
    }
    add(group.totals, row, cost, unpriced, includedHere, reported);
    // A separator no provider id or model id can contain. Written as an ESCAPE and never
    // as a literal NUL byte: a raw one in the source makes git classify this whole file as
    // binary, and every diff, blame and review of the rules of the money disappears with it.
    const modelKey = `${row.provider}\x00${row.model ?? ""}`;
    let model = group.models.get(modelKey);
    if (model === undefined) {
      model = {
        provider: row.provider,
        model: row.model,
        pricing: pricingOf(row.provider, row.model, overlay),
        ...emptyTotals(),
      };
      group.models.set(modelKey, model);
    }
    if (row.costReported) model.pricing = "reported";
    add(model, row, cost, unpriced, includedHere, reported);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      totals: group.totals,
      models: [...group.models.values()].sort(byCost),
    }))
    .sort((a, b) => byCost(a.totals, b.totals));
}
