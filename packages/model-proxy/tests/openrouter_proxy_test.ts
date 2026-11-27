// The data plane in front of OpenRouter, driven in-process against a fake upstream: what is
// forwarded and with which headers, what an OpenRouter body may not ask for, the cost every call
// is made to ask for, and that cost stored as the row's spend.

import { test } from "bun:test";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { makeProxyHandler } from "../src/http/proxy.ts";
import { makeCredentialIssuer } from "../src/core/service.ts";
import { catalogueOf, OPENROUTER } from "../src/core/openrouter.ts";
import { makeOpenRouterCatalogue } from "../src/core/openrouter_catalogue.ts";
import {
  makeUsableOpenRouterModels,
  type UsableOpenRouterModels,
} from "../src/core/openrouter_usable.ts";
import { makeSpendMeter } from "../src/core/spend_meter.ts";
import { spendOfRun } from "../src/core/spend.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { listedModel, MODELS_BODY, seedCatalogue } from "./fake_openrouter.ts";
import { publicDns } from "./dns.ts";

const T0 = "2026-11-27T12:00:00.000Z";

/** A catalogue of the fake's three models plus an unpriced one, the given ones enabled. */
async function makeSlice(opts: {
  enabled?: string[];
  allowedModels?: string[] | "*";
  /** The run's own model; the first enabled one it may use unless given. */
  model?: string;
  spendUsd?: number;
  upstream?: (req: Request) => Response | Promise<Response>;
  now?: () => Date;
  openRouterModels?: (store: ReturnType<typeof memoryKeyStore>) => UsableOpenRouterModels;
  warn?: (event: string, data?: Record<string, unknown>) => void;
} = {}) {
  const store = memoryKeyStore();
  await seedCatalogue(
    store,
    catalogueOf({
      data: [
        ...MODELS_BODY.data,
        listedModel("mystery/unpriced", { pricing: { prompt: "-1", completion: "-1" } }),
      ],
    }),
    T0,
  );
  const enabled = opts.enabled ??
    ["anthropic/claude-sonnet-5", "openai/gpt-6", "mystery/unpriced"];
  await store.setOpenRouterEnabled(enabled, T0);
  const allowedModels = opts.allowedModels ?? "*";
  await store.createProviderKey({
    id: "pk-or",
    provider: OPENROUTER,
    label: "team",
    last4: "real",
    encryptedSecret: "sealed:sk-or-v1-real",
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const env = await makeCredentialIssuer({
    store,
    now: () => new Date(T0),
    proxyUrl: "http://proxy.test",
  }).issue({
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-or",
    provider: OPENROUTER,
    allowedModels,
    model: opts.model ??
      (allowedModels === "*" ? enabled : allowedModels).find((m) => enabled.includes(m)),
    spendUsd: opts.spendUsd ?? null,
  });
  const seen: Array<{ url: string; headers: Headers; body: string }> = [];
  const upstream = opts.upstream ?? (() =>
    Response.json({
      model: "openai/gpt-6",
      choices: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, cost: 0.0042 },
    }));
  const handler = makeProxyHandler({
    resolveHost: publicDns,
    store,
    decrypt: (sealed) => Promise.resolve(sealed.replace(/^sealed:/, "")),
    now: opts.now ?? (() => new Date(T0)),
    diag: { debug() {}, warn: opts.warn ?? (() => {}) },
    limits: { meter: makeSpendMeter({ backstopMs: 30_000 }), gauge: null },
    ...(opts.openRouterModels === undefined
      ? {}
      : { openRouterModels: opts.openRouterModels(store) }),
    upstreamFetch: (async (input: URL | Request | string, init?: RequestInit) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
      seen.push({ url: req.url, headers: req.headers, body: await req.text() });
      return upstream(req);
    }) as typeof fetch,
  });
  const call = (body: unknown, path = "/v1/chat/completions", headers: HeadersInit = {}) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  /** The usage rows, once the fire-and-forget writes have landed. */
  const rows = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return await store.listUsageForRun("r-1");
  };
  return { handler, store, env, seen, call, rows };
}

test("a call goes to OpenRouter with the real key, the fixed attribution and the cost asked for", async () => {
  const { call, seen, env } = await makeSlice();
  // The issuer hands pi ryph's own two variables, pointed at the proxy.
  assertEquals(env.RYPH_MODEL_BASE_URL, "http://proxy.test/v1");

  const res = await call(
    { model: "openai/gpt-6", messages: [] },
    "/v1/chat/completions?debug=1",
    {
      "http-referer": "https://my-deployment.internal",
      "x-title": "not ryph",
      "openai-organization": "org-x",
    },
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(seen.length, 1);
  // Its base URL's own path kept, and no query: OpenRouter's model call reads none.
  assertEquals(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assertEquals(seen[0].headers.get("authorization"), "Bearer sk-or-v1-real");
  // The attribution is ryph's, never the caller's (and never the deployment's own address).
  assertEquals(seen[0].headers.get("http-referer"), "https://ryph.ai");
  assertEquals(seen[0].headers.get("x-title"), "ryph");
  assertEquals(seen[0].headers.get("openai-organization"), null);
  assertEquals(JSON.parse(seen[0].body), {
    usage: { include: true },
    model: "openai/gpt-6",
    messages: [],
  });
});

test("a streamed call asks for both its usage and its cost", async () => {
  const { call, seen } = await makeSlice({
    upstream: () =>
      new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
  });
  await (await call({
    model: "openai/gpt-6",
    stream: true,
    usage: { include: false, other: 1 },
    messages: [],
  })).text();
  assertEquals(JSON.parse(seen[0].body), {
    stream_options: { include_usage: true },
    model: "openai/gpt-6",
    stream: true,
    usage: { include: true, other: 1 },
    messages: [],
  });
});

test("an OpenRouter body may not route around the allowlist or the meter", async () => {
  // A policy of "*": the credential still holds only the enabled models.
  const { call, seen } = await makeSlice();
  for (
    const extra of [
      { models: ["openai/gpt-6", "x-ai/grok-9"] },
      { plugins: [{ id: "web" }] },
      { preset: "my-preset" },
      { provider: { data_collection: "allow", only: ["some-host"] } },
      { debug: { echo_upstream_body: true } },
      // Refused by name: a `null` here is one OpenRouter reads, and the proxy's own `plugins`
      // must never sit beside the body's.
      { models: null },
      { plugins: null },
      { preset: null },
      { provider: null },
      { debug: null },
      { debug: {} },
      { debug: false },
    ]
  ) {
    const res = await call({ model: "openai/gpt-6", messages: [], ...extra });
    assertEquals(res.status, 400, JSON.stringify(extra));
    const body = await res.json();
    assertEquals(body.code, "body_not_allowed");
    assert(body.refused[0].startsWith(Object.keys(extra)[0]), body.refused[0]);
  }
  // A `usage` the proxy cannot make ask for the cost is refused; an object or null is not.
  for (const usage of ["no", false, [], 1, { pad: "x".repeat(70 * 1024) }]) {
    const res = await call({ model: "openai/gpt-6", messages: [], usage });
    assertEquals(res.status, 400, JSON.stringify(usage).slice(0, 40));
    assertEquals((await res.json()).refused[0].startsWith("usage"), true);
  }
  for (const usage of [null, {}, { include: false }]) {
    const res = await call({ model: "openai/gpt-6", messages: [], usage });
    assertEquals(res.status, 200, JSON.stringify(usage));
    await res.body?.cancel();
    assertEquals(JSON.parse(seen.at(-1)!.body).usage.include, true);
  }
  // The fields every chat body is held to still read `null` as asking for nothing.
  const plain = await call({ model: "openai/gpt-6", messages: [], web_search_options: null });
  assertEquals(plain.status, 200);
  await plain.body?.cancel();
  seen.length = 0;
  assertEquals((await call({ model: "openai/gpt-6", messages: [] })).status, 200);
  // A model id's own suffixes are not the enabled model: the allowlist is exact ids.
  for (const model of ["openai/gpt-6:online", "@preset/mine", "openrouter/auto"]) {
    const res = await call({ model, messages: [] });
    assertEquals(res.status, 403, model);
    await res.body?.cancel();
  }
  assertEquals(seen.length, 1);
});

test("an OpenRouter key serves only the model call and the models list", async () => {
  const { handler, env, seen } = await makeSlice();
  for (
    const [method, path] of [
      ["GET", "/v1/credits"],
      ["GET", "/v1/key"],
      ["POST", "/v1/completions"],
      // The account's routing and privacy filters, and a count: never a model.
      ["GET", "/v1/models/user"],
      ["GET", "/v1/models/count"],
      ["GET", "/v1/models/openai"],
    ]
  ) {
    const res = await handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: { authorization: `Bearer ${env.RYPH_MODEL_API_KEY}` },
      }),
    );
    assertEquals(res.status, 404, `${method} ${path}`);
    assertEquals((await res.json()).code, "endpoint_not_allowed");
  }
  assertEquals(seen, [], "nothing reached OpenRouter");
});

test("an OpenRouter models list is answered by the proxy: the models this run may use", async () => {
  const { handler, env, seen, store } = await makeSlice({
    allowedModels: ["openai/gpt-6", "mystery/unpriced", "acme/no-tools"],
    model: "openai/gpt-6",
  });
  // Turned off after the credential was issued: no longer listed for the run.
  await store.setOpenRouterEnabled(["openai/gpt-6", "anthropic/claude-sonnet-5"], T0);
  const res = await handler(
    new Request("http://proxy.test/v1/models", {
      headers: { authorization: `Bearer ${env.RYPH_MODEL_API_KEY}` },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    object: "list",
    data: [{
      id: "openai/gpt-6",
      object: "model",
      owned_by: "openai",
      name: "Model openai/gpt-6",
      context_length: 200_000,
    }],
  });
  assertEquals(seen, [], "OpenRouter was never asked");
});

test("OpenRouter's refusal for money reaches the run without the account's credit", async () => {
  const CREDIT_402 = {
    error: {
      code: 402,
      message: "This request requires more credits. You requested up to 32000 tokens, but can " +
        "only afford 1234. Your balance is $0.37",
    },
  };
  const KEY_LIMIT_403 = {
    error: { code: 403, message: "Key limit exceeded (daily limit). Remaining: $0.01" },
  };
  const MODERATION_403 = {
    error: { code: 403, message: "Your input was flagged", metadata: { reasons: ["harassment"] } },
  };
  for (
    const [status, upstreamBody, fixed] of [
      [402, CREDIT_402, true],
      [403, KEY_LIMIT_403, true],
      [403, MODERATION_403, false],
    ] as const
  ) {
    const logged: Array<Record<string, unknown> | undefined> = [];
    const { call, rows } = await makeSlice({
      upstream: () => Response.json(upstreamBody, { status }),
      warn: (event, data) => {
        if (event === "proxy.upstream_error") logged.push(data);
      },
    });
    const res = await call({ model: "openai/gpt-6", messages: [] });
    // The upstream's status, kept: a 402 is what the runner treats as fatal.
    assertEquals(res.status, status);
    const body = await res.json();
    if (fixed) {
      assertEquals(body, {
        error: {
          message: "OpenRouter refused the call: the account is out of credit or over its " +
            "limit. An admin must check the key under Model keys",
          type: "upstream_credit_refused",
        },
        code: "upstream_credit_refused",
      });
      assertEquals(res.headers.get("x-should-retry"), "false");
    } else {
      assertEquals(body, upstreamBody, "any other refusal is the run's to read");
    }
    // The operator's line still has what OpenRouter said, balance and all.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(logged.length, 1);
    assertEquals(logged[0]?.status, status);
    assertEquals(logged[0]?.body, JSON.stringify(upstreamBody));
    assertEquals((await rows()).map((r) => [r.status, r.estimated]), [[status, false]]);
  }
});

test("OpenRouter's stated cost is the row's spend, JSON or streamed", async () => {
  const { call, rows, store } = await makeSlice();
  await (await call({ model: "openai/gpt-6", messages: [] })).text();
  let [row] = await rows();
  assertEquals(row.provider, OPENROUTER);
  assertEquals(row.costUsd, 0.0042);
  assertEquals(row.estimated, false);
  // Spend is the bill, not the list price of 1,000 in and 100 out ($0.0035 here).
  assertEquals((await spendOfRun(store, "r-1")).spentUsd, 0.0042);

  const streamed = await makeSlice({
    upstream: () =>
      new Response(
        ": OPENROUTER PROCESSING\n\n" +
          'data: {"model":"openai/gpt-6","choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"model":"openai/gpt-6","choices":[],"usage":{"prompt_tokens":10,' +
          '"completion_tokens":2,"cost":0.00007}}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await (await streamed.call({ model: "openai/gpt-6", stream: true, messages: [] })).text();
  [row] = await streamed.rows();
  assertEquals(row.costUsd, 0.00007);
  assertEquals(row.inputTokens, 10);
});

test("a call that never reported is estimated from the catalogue, with no cost of its own", async () => {
  const { call, rows } = await makeSlice({
    upstream: () => Response.json({ model: "openai/gpt-6", choices: [] }),
  });
  await (await call({ model: "openai/gpt-6", messages: [] })).text();
  const [row] = await rows();
  assertEquals(row.estimated, true);
  assertEquals(row.costUsd, null);
  // No `max_tokens` in the request: the catalogue's clamped output cap is what is charged.
  assertEquals(row.outputTokens, 32_000);
});

test("under a spend cap an unpriced OpenRouter model is refused, a priced one passes", async () => {
  const { call, seen } = await makeSlice({ spendUsd: 5 });
  const refused = await call({ model: "mystery/unpriced", messages: [] });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "unpriced");
  const passed = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(passed.status, 200);
  await passed.body?.cancel();
  assertEquals(seen.length, 1);
});

test("a BYOK call's spend is OpenRouter's fee and the upstream cost, JSON or streamed", async () => {
  const usage = {
    prompt_tokens: 1_000,
    completion_tokens: 100,
    cost: 0.0001,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0.002 },
  };
  const json = await makeSlice({
    upstream: () => Response.json({ model: "openai/gpt-6", choices: [], usage }),
  });
  await (await json.call({ model: "openai/gpt-6", messages: [] })).text();
  assertAlmostEquals((await json.rows())[0].costUsd!, 0.0021);

  const streamed = await makeSlice({
    upstream: () =>
      new Response(
        `data: ${JSON.stringify({ model: "openai/gpt-6", choices: [], usage })}\n\n` +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await (await streamed.call({ model: "openai/gpt-6", stream: true, messages: [] })).text();
  assertAlmostEquals((await streamed.rows())[0].costUsd!, 0.0021);

  // Not BYOK: the fee is the whole bill.
  const plain = await makeSlice({
    upstream: () =>
      Response.json({
        model: "openai/gpt-6",
        choices: [],
        usage: { ...usage, is_byok: false },
      }),
  });
  await (await plain.call({ model: "openai/gpt-6", messages: [] })).text();
  assertEquals((await plain.rows())[0].costUsd, 0.0001);

  // BYOK with no upstream figure that is one: no bill at all, so the row is priced from the
  // catalogue (1,000 in and 100 out of gpt-6: $0.0035), never at the fee alone.
  for (
    const over of [
      { cost_details: { upstream_inference_cost: null } },
      { cost_details: { upstream_inference_cost: -1 } },
      { cost_details: {} },
      { cost_details: null },
    ]
  ) {
    const slice = await makeSlice({
      upstream: () =>
        Response.json({ model: "openai/gpt-6", choices: [], usage: { ...usage, ...over } }),
    });
    await (await slice.call({ model: "openai/gpt-6", messages: [] })).text();
    const [row] = await slice.rows();
    assertEquals(row.costUsd, null, JSON.stringify(over));
    assertEquals(row.estimated, false);
    assertAlmostEquals((await spendOfRun(slice.store, "r-1")).spentUsd, 0.0035);
  }
});

test("the live spend meter counts the bill: one above list price refuses the next capped call", async () => {
  let now = new Date(T0);
  const { call, seen } = await makeSlice({
    spendUsd: 1,
    now: () => now,
    upstream: () =>
      Response.json({
        model: "openai/gpt-6",
        choices: [],
        // $0.0035 at list price; billed $1.50.
        usage: { prompt_tokens: 1_000, completion_tokens: 100, cost: 1.5 },
      }),
  });
  const first = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(first.status, 200);
  await first.text();
  // Past the cap, the meter refuses once the orchestrator's grace to cancel the run is over.
  now = new Date(Date.parse(T0) + 31_000);
  const next = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(next.status, 403);
  assertEquals((await next.json()).code, "limit_reached");
  assertEquals(seen.length, 1);
});

test("the usage row names the model the run asked for, not the variant OpenRouter served", async () => {
  const { call, rows } = await makeSlice({
    upstream: () =>
      Response.json({
        model: "openai/gpt-6-20261101",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 },
      }),
  });
  await (await call({ model: "openai/gpt-6", messages: [] })).text();
  assertEquals((await rows())[0].model, "openai/gpt-6");
});

test("OpenRouter's response headers come back by allowlist", async () => {
  const { call } = await makeSlice({
    upstream: () =>
      Response.json({ model: "openai/gpt-6", choices: [] }, {
        headers: {
          "x-generation-id": "gen-123",
          "x-ratelimit-remaining": "99",
          "retry-after": "2",
          "set-cookie": "__cf_bm=abc; path=/",
          "x-openrouter-account": "acct-1",
          "cf-ray": "abc-AMS",
        },
      }),
  });
  const res = await call({ model: "openai/gpt-6", messages: [] });
  await res.text();
  assertEquals(res.headers.get("x-generation-id"), "gen-123");
  assertEquals(res.headers.get("x-ratelimit-remaining"), "99");
  assertEquals(res.headers.get("retry-after"), "2");
  assert(res.headers.get("content-type")?.includes("application/json"));
  assertEquals(res.headers.get("set-cookie"), null);
  assertEquals(res.headers.get("x-openrouter-account"), null);
  assertEquals(res.headers.get("cf-ray"), null);
});

test("an OpenRouter message carries only inline parts OpenRouter reads", async () => {
  const { call, seen } = await makeSlice();
  const pdf = "data:application/pdf;base64,JVBERi0xLjQK";
  const message = (...content: unknown[]) => ({
    model: "openai/gpt-6",
    messages: [{ role: "user", content }],
  });
  for (
    const part of [
      { type: "video_url", video_url: { url: "https://attacker.test/v.mp4" } },
      { type: "file", file: { filename: "a.pdf", file_data: "https://attacker.test/a.pdf" } },
      { type: "file", file: { filename: "a.pdf" } },
      { type: "file", file: { file_id: "file-123" } },
      { type: "input_audio", input_audio: { data: "https://attacker.test/a.wav", format: "wav" } },
      { type: "image_url", image_url: { url: "https://attacker.test/i.png" } },
      { text: "no type" },
    ]
  ) {
    const res = await call(message({ type: "text", text: "look" }, part));
    assertEquals(res.status, 400, JSON.stringify(part));
    const body = await res.json();
    assertEquals(body.code, "body_not_allowed");
    assert(body.refused[0].startsWith("messages[0].content[1]"), body.refused[0]);
  }
  assertEquals(seen.length, 0);

  // Inline text, image, audio and file pass; a file part has the free PDF parser named for it.
  const inline = await call(message(
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
    { type: "file", file: { filename: "a.pdf", file_data: pdf } },
  ));
  assertEquals(inline.status, 200);
  await inline.text();
  const sent = JSON.parse(seen[0].body);
  assertEquals(sent.plugins, [{ id: "file-parser", pdf: { engine: "pdf-text" } }]);
  assertEquals(sent.usage, { include: true });

  // No file, no plugin; and a tool's JSON Schema is not a message.
  const plain = await call({
    ...message({ type: "text", text: "hi" }),
    tools: [{
      type: "function",
      function: {
        name: "t",
        parameters: { examples: [{ content: [{ type: "video_url" }] }] },
      },
    }],
  });
  assertEquals(plain.status, 200);
  await plain.text();
  assertEquals(JSON.parse(seen[1].body).plugins, undefined);
});

test("a model turned off mid-run is refused from the next call, the credential notwithstanding", async () => {
  let cache: UsableOpenRouterModels | null = null;
  const { call, store } = await makeSlice({
    openRouterModels: (
      store,
    ) => (cache = makeUsableOpenRouterModels({ store, now: () => new Date(T0) })),
  });
  const ok = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(ok.status, 200);
  await ok.body?.cancel();

  // The admin saves the enabled set without it; the save drops this process's cache.
  await store.setOpenRouterEnabled(["anthropic/claude-sonnet-5"], T0);
  cache!.invalidate();
  const refused = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(refused.status, 403);
  assertEquals(
    (await refused.json()).error,
    'model "openai/gpt-6" is not allowed for this run: it isn\'t enabled for OpenRouter',
  );
  // A model still enabled answers as before.
  const other = await call({ model: "anthropic/claude-sonnet-5", messages: [] });
  assertEquals(other.status, 200);
  await other.body?.cancel();
});

test("a change made in another process reaches the proxy once its cache runs out", async () => {
  let now = new Date(T0);
  const { call, store } = await makeSlice({ now: () => now });
  const ok = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(ok.status, 200);
  await ok.body?.cancel();

  // Nothing tells this process: the cached set answers for up to a minute...
  await store.setOpenRouterEnabled(["anthropic/claude-sonnet-5"], T0);
  const cached = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(cached.status, 200);
  await cached.body?.cancel();
  // ...and no longer.
  now = new Date(Date.parse(T0) + 61_000);
  const refused = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(refused.status, 403);
  await refused.body?.cancel();
});

test("a model enabled through another replica is served here at once", async () => {
  // Two proxy replicas over one store, each with its own cache. This one has read the set
  // before the model was enabled, and nothing tells it of the change.
  let here: UsableOpenRouterModels | null = null;
  const { handler, call, store } = await makeSlice({
    enabled: ["anthropic/claude-sonnet-5"],
    openRouterModels: (
      store,
    ) => (here = makeUsableOpenRouterModels({ store, now: () => new Date(T0) })),
  });
  const warm = await call({ model: "anthropic/claude-sonnet-5", messages: [] });
  assertEquals(warm.status, 200);
  await warm.body?.cancel();
  assertEquals((await here!.get()).map((m) => m.id), ["anthropic/claude-sonnet-5"]);

  // The admin enables gpt-6 through the other replica, which drops only its own cache; a run
  // is then issued a credential that carries it.
  const there = makeUsableOpenRouterModels({ store, now: () => new Date(T0) });
  await store.setOpenRouterEnabled(["anthropic/claude-sonnet-5", "openai/gpt-6"], T0);
  there.invalidate();
  const env = await makeCredentialIssuer({
    store,
    now: () => new Date(T0),
    proxyUrl: "http://proxy.test",
  }).issue({
    runId: "r-2",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-or",
    provider: OPENROUTER,
    allowedModels: "*",
    model: "openai/gpt-6",
  });
  const res = await handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "openai/gpt-6", messages: [] }),
    }),
  );
  assertEquals(res.status, 200, "served without waiting out this replica's cache");
  await res.body?.cancel();
  // The reread is cached: the next call for it costs no refusal path.
  assertEquals((await here!.get()).map((m) => m.id), [
    "anthropic/claude-sonnet-5",
    "openai/gpt-6",
  ]);
});

test("a model a sync unlists is refused from the next call", async () => {
  let cache: UsableOpenRouterModels | null = null;
  const { call, store } = await makeSlice({
    openRouterModels: (
      store,
    ) => (cache = makeUsableOpenRouterModels({ store, now: () => new Date(T0) })),
  });
  const ok = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(ok.status, 200);
  await ok.body?.cancel();

  // Two lists in a row leave it out (forced: they are short), and the sync drops the cache.
  const rest = MODELS_BODY.data.filter((m) => m.id !== "openai/gpt-6");
  const catalogue = makeOpenRouterCatalogue({
    store,
    api: {
      listModels: () => Promise.resolve({ data: rest }),
      keyInfo: () => Promise.reject(new Error("unused")),
    },
    now: () => new Date(T0),
    diag: { debug() {}, warn() {} },
    changed: () => cache!.invalidate(),
  });
  await catalogue.sync({ force: true });
  const once = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(once.status, 200, "one miss keeps an enabled model");
  await once.body?.cancel();
  await catalogue.sync({ force: true });
  const refused = await call({ model: "openai/gpt-6", messages: [] });
  assertEquals(refused.status, 403);
  await refused.body?.cancel();
});
