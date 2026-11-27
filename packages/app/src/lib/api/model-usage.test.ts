import { describe, expect, it } from "vitest";
import {
  costBasis,
  costHeadline,
  costLabel,
  costSourceNote,
  getRunUsageState,
  getUsageReportOrOff,
  isIncluded,
  modelUsageSchema,
  usageTotalsSchema,
} from "./model-usage";
import { formatCount, formatUsd } from "#lib/utils/format.ts";

// A run page must open whether or not the deployment meters model calls, and whether or not the
// model proxy is answering right now: the bill is a detail of that page, the run is the page.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const totals = {
  requests: 3,
  failedRequests: 1,
  meteredRequests: 2,
  unpricedRequests: 0,
  includedRequests: 0,
  reportedRequests: 0,
  tokens: { input: 300, output: 150, cacheRead: 1000, cacheWrite: 0, reasoning: 0 },
  cost: { input: 0.0006, output: 0.0015, cacheRead: 0.0002, cacheWrite: 0, total: 0.0023 },
};

const disabled = { error: "model access not configured", code: "model_access_disabled" };

describe("getRunUsageState", () => {
  it("reads the bill", async () => {
    const body = {
      runId: "r-1",
      totals,
      byModel: [{ provider: "anthropic", model: "claude-sonnet-5", ...totals }],
      pricing: { currency: "USD", source: "pi-ai 1.0.0 model catalogue, 2026-10-02" },
    };
    const fetch = respond(200, body) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: body, unavailable: false });
  });

  it("folds a deployment without model access into no bill, and says nothing is wrong", async () => {
    const fetch = respond(503, disabled) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: null, unavailable: false });
  });

  it("folds a proxy that is down into an unavailable bill", async () => {
    const fetch = respond(502, { error: "bad gateway" }) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: null, unavailable: true });
  });
});

describe("getUsageReportOrOff", () => {
  it("is null without model access, and still throws on a broken proxy", async () => {
    const off = respond(503, disabled) as unknown as typeof globalThis.fetch;
    expect(await getUsageReportOrOff(off, { from: "a", to: "b" })).toBeNull();
    const broken = respond(503, { error: "upstream unavailable" }) as unknown as typeof fetch;
    await expect(getUsageReportOrOff(broken, { from: "a", to: "b" })).rejects.toThrow(
      "upstream unavailable",
    );
  });
});

describe("formatUsd", () => {
  it("reads to the cent, and never rounds a real spend down to free", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.0812)).toBe("$0.08");
    expect(formatUsd(0.0023)).toBe("<$0.01");
    expect(formatUsd(0.00001)).toBe("<$0.01");
    expect(formatCount(12_900)).toBe("12.9K");
  });
});

describe("included usage", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  it("defaults includedRequests to 0 for a proxy that does not send it", () => {
    const { includedRequests: _, ...before } = totals;
    expect(usageTotalsSchema.parse(before).includedRequests).toBe(0);
  });

  it("parses the included marker on a model row", () => {
    const row = modelUsageSchema.parse({
      provider: "chatgpt-plan",
      model: "gpt-5.5",
      pricing: "included",
      ...totals,
      cost: zero,
    });
    expect(row.pricing).toBe("included");
    expect(costLabel(row)).toBe("Included");
  });

  it("reads totals that are all included as Included, never $0.00", () => {
    const t = usageTotalsSchema.parse({ ...totals, includedRequests: 2, cost: zero });
    expect(isIncluded(t)).toBe(true);
    expect(costLabel(t)).toBe("Included");
  });

  it("shows the priced cost of a mix, and the old answers otherwise", () => {
    const mixed = usageTotalsSchema.parse({ ...totals, includedRequests: 1 });
    expect(isIncluded(mixed)).toBe(false);
    expect(costLabel(mixed)).toBe(formatUsd(totals.cost.total));
    const unpriced = usageTotalsSchema.parse({ ...totals, unpricedRequests: 2, cost: zero });
    expect(costLabel(unpriced)).toBe("Unpriced");
  });
});

describe("reported usage", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  it("defaults reportedRequests to 0 for a proxy that does not send it", () => {
    const { reportedRequests: _, ...before } = totals;
    expect(usageTotalsSchema.parse(before).reportedRequests).toBe(0);
  });

  it("shows what the provider billed as a cost, never as unpriced", () => {
    const row = modelUsageSchema.parse({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      pricing: "reported",
      ...totals,
      reportedRequests: 2,
    });
    expect(row.pricing).toBe("reported");
    expect(costLabel(row)).toBe(formatUsd(totals.cost.total));
    const free = usageTotalsSchema.parse({
      ...totals,
      reportedRequests: 1,
      unpricedRequests: 1,
      cost: zero,
    });
    expect(costLabel(free)).toBe(formatUsd(0));
  });
});

describe("where the costs come from", () => {
  const source = "pi-ai 1.6.1 model catalogue";

  it("says list-price estimates when nothing was billed", () => {
    const t = usageTotalsSchema.parse(totals);
    expect(costBasis(t)).toBe("list");
    expect(costHeadline(t)).toBe("Estimated cost");
    expect(costSourceNote(t, source)).toBe(
      `Costs are list-price estimates from Ryph's built-in price list (${source}), not an invoice.`,
    );
  });

  it("says Cost when OpenRouter billed every priced call", () => {
    const t = usageTotalsSchema.parse({ ...totals, reportedRequests: 2 });
    expect(costBasis(t)).toBe("billed");
    expect(costHeadline(t)).toBe("Cost");
    expect(costSourceNote(t, source)).toBe("Costs are what OpenRouter billed.");
  });

  it("does not count included or unpriced calls as estimates", () => {
    const t = usageTotalsSchema.parse({
      ...totals,
      meteredRequests: 4,
      reportedRequests: 2,
      includedRequests: 1,
      unpricedRequests: 1,
    });
    expect(costBasis(t)).toBe("billed");
  });

  it("keeps the estimate wording for the rest of a mix", () => {
    const one = usageTotalsSchema.parse({ ...totals, reportedRequests: 1 });
    expect(costBasis(one)).toBe("mixed");
    expect(costHeadline(one)).toBe("Estimated cost");
    expect(costSourceNote(one, source)).toBe(
      `Costs are list-price estimates from Ryph's built-in price list (${source}), except 1 call priced at OpenRouter's bill.`,
    );
    const two = usageTotalsSchema.parse({ ...totals, meteredRequests: 5, reportedRequests: 2 });
    expect(costSourceNote(two, source)).toMatch(/except 2 calls priced at OpenRouter's bill\.$/);
  });
});
