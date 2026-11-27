// The OpenRouter model picker's logic, kept out of the component so it can be tested: which
// models are offered, how a search matches them, their order, and the words for prices, context,
// the sync and a key's credit.

import type {
  EnableRefusal,
  OpenRouterKeyInfo,
  OpenRouterModel,
  OpenRouterSync,
} from "#lib/api/openrouter.ts";
import { formatRelativeTime, formatUsd } from "#lib/utils/format.ts";

/** Rows drawn at first, and added by each "Show more". */
export const PAGE_SIZE = 50;

/** Which rows the list shows: every offered model, or only the enabled ones. */
export type ModelFilter = "all" | "enabled";

/**
 * The models an admin can choose from: those that take tools, plus any already enabled, so one
 * that is on is always visible and can be turned off.
 */
export function offeredModels(models: readonly OpenRouterModel[]): OpenRouterModel[] {
  return models.filter((m) => m.tools || m.enabled);
}

/**
 * Whether a model matches a search. Every word must appear in its name or its id, in any order
 * and any case, so "claude sonnet" finds `anthropic/claude-sonnet-4.5`.
 */
export function matchesSearch(model: Pick<OpenRouterModel, "id" | "label">, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const haystack = `${model.label} ${model.id}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * The list's order: saved-enabled models first, then by name. It sorts on what is saved, not on
 * the unsaved choice, so a row stays where it is while it is being ticked.
 */
export function sortModels(
  models: readonly OpenRouterModel[],
  saved: ReadonlySet<string>,
): OpenRouterModel[] {
  return [...models].sort((a, b) => {
    const enabled = Number(saved.has(b.id)) - Number(saved.has(a.id));
    if (enabled !== 0) return enabled;
    return a.label.localeCompare(b.label, "en", { sensitivity: "base" }) ||
      a.id.localeCompare(b.id);
  });
}

/**
 * The rows to show, in order. "Enabled" keeps every model that is enabled either as saved or in
 * the unsaved choice, so turning one off in that view does not make it vanish.
 */
export function visibleModels(
  models: readonly OpenRouterModel[],
  options: {
    query: string;
    filter: ModelFilter;
    saved: ReadonlySet<string>;
    draft: ReadonlySet<string>;
  },
): OpenRouterModel[] {
  const { query, filter, saved, draft } = options;
  const shown = offeredModels(models).filter((m) =>
    (filter === "all" || saved.has(m.id) || draft.has(m.id)) && matchesSearch(m, query)
  );
  return sortModels(shown, saved);
}

/** The ids enabled as saved. */
export function enabledIds(models: readonly OpenRouterModel[]): Set<string> {
  return new Set(models.filter((m) => m.enabled).map((m) => m.id));
}

/** How many ids differ between two sets: what the Save bar counts as changes. */
export function changeCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const id of a) if (!b.has(id)) n++;
  for (const id of b) if (!a.has(id)) n++;
  return n;
}

/**
 * The ids a save sends: the choice, less any model OpenRouter no longer lists. Those can't be
 * enabled, and agents can't use them, so saving turns them off.
 */
export function idsToSave(
  draft: ReadonlySet<string>,
  models: readonly OpenRouterModel[],
): string[] {
  const listed = new Set(models.filter((m) => m.listed).map((m) => m.id));
  return [...draft].filter((id) => listed.has(id)).sort();
}

/** A context window as people say it: "128K", "1M", "1.05M". */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
  return String(tokens);
}

const trim = (n: number) => String(Math.round(n * 100) / 100);

const perMillion = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

/** "$3 / $15" per million tokens in and out, "Free" when both are zero, null when unpriced. */
export function formatModelPrice(price: OpenRouterModel["price"]): string | null {
  if (price === null) return null;
  if (price.input === 0 && price.output === 0) return "Free";
  return `${perMillion.format(price.input)} / ${perMillion.format(price.output)}`;
}

/** The sync's state as one line, and whether it is a failure. */
export type SyncLine = { text: string; failed: boolean };

/** "Syncing…", "Sync failed: …", "Synced 2h ago" or "Not synced yet". */
export function syncLine(sync: OpenRouterSync): SyncLine {
  if (sync.syncing) return { text: "Syncing…", failed: false };
  if (sync.error !== null) return { text: `Sync failed: ${sync.error}`, failed: true };
  if (sync.syncedAt === null) return { text: "Not synced yet", failed: false };
  return { text: `Synced ${formatRelativeTime(sync.syncedAt)}`, failed: false };
}

/** A refused save as lines to show, each naming the models by their names where known. */
export function refusalLines(
  refusal: EnableRefusal,
  models: readonly Pick<OpenRouterModel, "id" | "label">[],
): string[] {
  const names = new Map(models.map((m) => [m.id, m.label]));
  const named = (ids: string[]) => ids.map((id) => names.get(id) ?? id).join(", ");
  const lines = [
    refusal.unknown.length > 0 && `Not on OpenRouter: ${named(refusal.unknown)}`,
    refusal.unlisted.length > 0 && `No longer on OpenRouter: ${named(refusal.unlisted)}`,
    refusal.noTools.length > 0 && `Can't use tools: ${named(refusal.noTools)}`,
  ].filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines : [refusal.message];
}

/** A key card's credit line, and whether it is a problem. */
export type CreditLine = { text: string; empty: boolean };

/**
 * "No credits left" when the key's limit is spent, "$4.20 of $10 left" under a limit, and
 * nothing for a key without one: its spend is OpenRouter's account balance, which this does not
 * read.
 */
export function creditLine(info: OpenRouterKeyInfo): CreditLine | null {
  if (info.limitRemaining !== null && info.limitRemaining <= 0) {
    return { text: "No credits left", empty: true };
  }
  if (info.limit !== null && info.limitRemaining !== null) {
    return {
      text: `${formatUsd(info.limitRemaining)} of ${formatUsd(info.limit)} left`,
      empty: false,
    };
  }
  return null;
}
