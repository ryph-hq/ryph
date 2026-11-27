import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "#lib/api/call.ts";
import { OPENROUTER_KEY_REFUSED, type OpenRouterModel } from "#lib/api/openrouter.ts";
import { formatUsd } from "#lib/utils/format.ts";
import {
  catalogueReader,
  changeCount,
  creditFailureLine,
  creditLine,
  draftInCatalogue,
  enabledIds,
  enabledModelsLine,
  formatContext,
  formatModelPrice,
  idsToSave,
  matchesSearch,
  offeredModels,
  openRouterErrorText,
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

  it("forgets a tick on a model a sync dropped, so it is no change", () => {
    const models = [model("a"), model("b", { enabled: true })];
    const draft = draftInCatalogue(new Set(["b", "dropped"]), models);
    expect([...draft]).toEqual(["b"]);
    expect(changeCount(draft, new Set(["b"]))).toBe(0);
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

  const base = {
    syncedAt: null,
    attemptedAt: null,
    error: null,
    errorCode: null,
    syncing: false,
  };

  it("says syncing first, then when it last worked, and leaves a failure out", () => {
    expect(syncLine({ ...base, syncing: true, error: "x" })).toBe("Syncing…");
    expect(syncLine(base)).toBe("Not synced yet");
    const failed = syncLine({ ...base, syncedAt: "2026-11-27T10:00:00.000Z", error: "timed out" });
    expect(failed).toMatch(/^Synced .*2/);
    expect(failed).not.toContain("timed out");
  });

  it("reads the age against the clock it is given", () => {
    const sync = { ...base, syncedAt: "2026-11-27T10:00:00.000Z" };
    const later = new Date("2026-11-27T15:00:00.000Z").getTime();
    expect(syncLine(sync, later)).toMatch(/5/);
    expect(syncLine(sync, later)).not.toBe(syncLine(sync));
  });
});

describe("a key's credit line", () => {
  it("says when the credit is spent", () => {
    expect(creditLine({ limit: 10, limitRemaining: 0, usage: 10, isFreeTier: false }))
      .toEqual({ text: "No credits left", problem: true });
    expect(creditLine({ limit: 10, limitRemaining: -0.5, usage: 10.5, isFreeTier: false })?.problem)
      .toBe(true);
  });

  it("shows what is left under a limit", () => {
    expect(creditLine({ limit: 10, limitRemaining: 4.2, usage: 5.8, isFreeTier: false }))
      .toEqual({ text: `${formatUsd(4.2)} of ${formatUsd(10)} left`, problem: false });
  });

  it("shows nothing for a key without a limit", () => {
    expect(creditLine({ limit: null, limitRemaining: null, usage: 3, isFreeTier: false }))
      .toBeNull();
  });

  it("says when OpenRouter refused the key, and nothing for any other failure", () => {
    const refused = new ApiError(502, { error: "no", code: OPENROUTER_KEY_REFUSED }, "no");
    expect(creditFailureLine(refused)).toEqual({
      text: "OpenRouter refused this key",
      problem: true,
    });
    expect(creditFailureLine(new ApiError(502, { error: "down" }, "down"))).toBeNull();
    expect(creditFailureLine(new Error("offline"))).toBeNull();
  });
});

describe("errors", () => {
  it("says model access is off in plain words", () => {
    const off = new ApiError(503, {
      error: "model access not configured",
      code: "model_access_disabled",
    }, "model access not configured");
    expect(openRouterErrorText(off, "fallback")).toBe("Model access is off");
    expect(openRouterErrorText(new Error("boom"), "fallback")).toBe("boom");
    expect(openRouterErrorText("??", "fallback")).toBe("fallback");
  });
});

describe("the page's catalogue read", () => {
  const catalogue = {
    models: [model("a")],
    sync: {
      syncedAt: null,
      attemptedAt: null,
      error: null,
      errorCode: null,
      syncing: true,
    },
  };

  function answering(...answers: [number, unknown][]) {
    return (() => {
      const [status, body] = answers.shift()!;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
  }

  it("keeps the last catalogue when a later read fails, so polling goes on", async () => {
    const read = catalogueReader(true);
    const f = answering([200, catalogue], [500, { error: "orchestrator restarting" }]);
    expect(await read(f)).toEqual({ catalogue, error: null });
    expect(await read(f)).toEqual({ catalogue, error: "orchestrator restarting" });
  });

  it("has nothing to keep on the server, or before a first read worked", async () => {
    const read = catalogueReader(false);
    const f = answering([200, catalogue], [500, { error: "down" }]);
    await read(f);
    expect(await read(f)).toEqual({ catalogue: null, error: "down" });
  });
});

describe("a key card's models line", () => {
  const sync = {
    syncedAt: "2026-11-01T00:00:00Z",
    attemptedAt: "2026-11-01T00:00:00Z",
    error: null,
    errorCode: null,
    syncing: false,
  };

  it("counts only the enabled models agents can use", () => {
    const models = [
      model("a", { enabled: true }),
      model("b", { enabled: true }),
      model("c", { enabled: true, listed: false }),
      model("d", { enabled: true, tools: false }),
      model("e"),
    ];
    expect(enabledModelsLine({ models, sync })).toEqual({
      text: "2 models enabled",
      problem: false,
    });
    expect(enabledModelsLine({ models: [model("a", { enabled: true })], sync }).text)
      .toBe("1 model enabled");
  });

  it("flags none enabled, unusable ones included", () => {
    const models = [model("a"), model("b", { enabled: true, listed: false })];
    expect(enabledModelsLine({ models, sync })).toEqual({
      text: "No models enabled",
      problem: true,
    });
  });

  it("says a first sync is still running instead of flagging an empty list", () => {
    expect(enabledModelsLine({ models: [], sync: { ...sync, syncing: true } })).toEqual({
      text: "Syncing models…",
      problem: false,
    });
    expect(enabledModelsLine({ models: [model("a")], sync: { ...sync, syncing: true } }).problem)
      .toBe(true);
  });
});
