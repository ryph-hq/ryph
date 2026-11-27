import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRouterModel } from "#lib/api/openrouter.ts";
import { formatUsd } from "#lib/utils/format.ts";
import {
  changeCount,
  creditLine,
  enabledIds,
  formatContext,
  formatModelPrice,
  idsToSave,
  matchesSearch,
  offeredModels,
  refusalLines,
  sortModels,
  syncLine,
  visibleModels,
} from "./openrouter-models";

function model(id: string, over: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id,
    label: id,
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    vision: false,
    reasoning: false,
    tools: true,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    listed: true,
    enabled: false,
    ...over,
  };
}

const ids = (models: OpenRouterModel[]) => models.map((m) => m.id);

describe("which models are offered", () => {
  it("leaves out models without tools unless one is already enabled", () => {
    const models = [
      model("a"),
      model("b", { tools: false }),
      model("c", { tools: false, enabled: true }),
    ];
    expect(ids(offeredModels(models))).toEqual(["a", "c"]);
  });
});

describe("searching", () => {
  const sonnet = model("anthropic/claude-sonnet-4.5", { label: "Anthropic: Claude Sonnet 4.5" });

  it("matches every word against the name or the id, in any order and case", () => {
    expect(matchesSearch(sonnet, "")).toBe(true);
    expect(matchesSearch(sonnet, "  ")).toBe(true);
    expect(matchesSearch(sonnet, "SONNET claude")).toBe(true);
    expect(matchesSearch(sonnet, "anthropic/claude")).toBe(true);
    expect(matchesSearch(sonnet, "sonnet gpt")).toBe(false);
  });
});

describe("the order", () => {
  it("puts saved-enabled models first, then sorts by name", () => {
    const models = [
      model("z", { label: "beta" }),
      model("y", { label: "Alpha" }),
      model("x", { label: "gamma" }),
    ];
    expect(ids(sortModels(models, new Set()))).toEqual(["y", "z", "x"]);
    expect(ids(sortModels(models, new Set(["x"])))).toEqual(["x", "y", "z"]);
  });
});

describe("the visible rows", () => {
  const models = [model("a/one"), model("b/two", { enabled: true }), model("c/three")];
  const saved = enabledIds(models);

  it("shows every offered model under All, enabled first", () => {
    const rows = visibleModels(models, { query: "", filter: "all", saved, draft: saved });
    expect(ids(rows)).toEqual(["b/two", "a/one", "c/three"]);
  });

  it("keeps a model in the Enabled view while it is being turned off or on", () => {
    const draft = new Set(["a/one"]);
    const rows = visibleModels(models, { query: "", filter: "enabled", saved, draft });
    expect(ids(rows)).toEqual(["b/two", "a/one"]);
  });

  it("applies the search on top of the filter", () => {
    const rows = visibleModels(models, { query: "three", filter: "all", saved, draft: saved });
    expect(ids(rows)).toEqual(["c/three"]);
  });
});

describe("saving", () => {
  it("counts changes in either direction", () => {
    expect(changeCount(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(0);
    expect(changeCount(new Set(["a", "c"]), new Set(["a", "b"]))).toBe(2);
    expect(changeCount(new Set(), new Set(["a"]))).toBe(1);
  });

  it("sends the choice less models OpenRouter no longer lists", () => {
    const models = [model("a"), model("gone", { listed: false, enabled: true }), model("b")];
    expect(idsToSave(new Set(["b", "gone", "a"]), models)).toEqual(["a", "b"]);
  });

  it("names refused models by their names", () => {
    const models = [model("a/x", { label: "X" })];
    expect(
      refusalLines({ message: "m", unknown: ["q/q"], unlisted: ["a/x"], noTools: [] }, models),
    ).toEqual(["Not on OpenRouter: q/q", "No longer on OpenRouter: X"]);
    expect(refusalLines({ message: "m", unknown: [], unlisted: [], noTools: [] }, models))
      .toEqual(["m"]);
  });
});

describe("formatting", () => {
  it("writes context windows the way people say them", () => {
    expect(formatContext(512)).toBe("512");
    expect(formatContext(8_192)).toBe("8.19K");
    expect(formatContext(128_000)).toBe("128K");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_048_576)).toBe("1.05M");
  });

  it("writes prices per million tokens, free ones as Free, unpriced as null", () => {
    expect(formatModelPrice({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }))
      .toBe("$3 / $15");
    expect(formatModelPrice({ input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 }))
      .toBe("$0.075 / $0.3");
    expect(formatModelPrice({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe("Free");
    expect(formatModelPrice(null)).toBeNull();
  });
});

describe("the sync line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = { syncedAt: null, attemptedAt: null, error: null, syncing: false };

  it("says syncing first, then a failure, then when it last worked", () => {
    expect(syncLine({ ...base, syncing: true, error: "x" })).toEqual({
      text: "Syncing…",
      failed: false,
    });
    expect(syncLine({ ...base, syncedAt: "2026-11-27T10:00:00.000Z", error: "timed out" }))
      .toEqual({ text: "Sync failed: timed out", failed: true });
    expect(syncLine(base)).toEqual({ text: "Not synced yet", failed: false });
    const synced = syncLine({ ...base, syncedAt: "2026-11-27T10:00:00.000Z" });
    expect(synced.failed).toBe(false);
    expect(synced.text).toMatch(/^Synced .*2/);
  });
});

describe("a key's credit line", () => {
  it("says when the credit is spent", () => {
    expect(creditLine({ limit: 10, limitRemaining: 0, usage: 10, isFreeTier: false }))
      .toEqual({ text: "No credits left", empty: true });
    expect(creditLine({ limit: 10, limitRemaining: -0.5, usage: 10.5, isFreeTier: false })?.empty)
      .toBe(true);
  });

  it("shows what is left under a limit", () => {
    expect(creditLine({ limit: 10, limitRemaining: 4.2, usage: 5.8, isFreeTier: false }))
      .toEqual({ text: `${formatUsd(4.2)} of ${formatUsd(10)} left`, empty: false });
  });

  it("shows nothing for a key without a limit", () => {
    expect(creditLine({ limit: null, limitRemaining: null, usage: 3, isFreeTier: false }))
      .toBeNull();
  });
});
