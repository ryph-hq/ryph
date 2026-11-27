// The data plane in front of OpenRouter, driven in-process against a fake upstream: what is
// forwarded and with which headers, what an OpenRouter body may not ask for, the cost every call
// is made to ask for, and that cost stored as the row's spend.

import { test } from "bun:test";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { makeProxyHandler } from "../src/http/proxy.ts";
import { makeCredentialIssuer } from "../src/core/service.ts";
import { catalogueOf, OPENROUTER } from "../src/core/openrouter.ts";
import { makeSpendMeter } from "../src/core/spend_meter.ts";
import { spendOfRun } from "../src/core/spend.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { listedModel, MODELS_BODY } from "./fake_openrouter.ts";
import { publicDns } from "./dns.ts";

const T0 = "2026-11-27T12:00:00.000Z";

/** A catalogue of the fake's three models plus an unpriced one, the given ones enabled. */
async function makeSlice(opts: {
  enabled?: string[];
  allowedModels?: string[] | "*";
  spendUsd?: number;
  upstream?: (req: Request) => Response | Promise<Response>;
  now?: () => Date;
} = {}) {
  const store = memoryKeyStore();
  await store.upsertOpenRouterCatalogue(
    catalogueOf({
      data: [
        ...MODELS_BODY.data,
        listedModel("mystery/unpriced", { pricing: { prompt: "-1", completion: "-1" } }),
      ],
    }),
    T0,
  );
  await store.setOpenRouterEnabled(
    opts.enabled ?? ["anthropic/claude-sonnet-5", "openai/gpt-6", "mystery/unpriced"],
    T0,
  );
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
    allowedModels: opts.allowedModels ?? "*",
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
    diag: { debug() {}, warn() {} },
    limits: { meter: makeSpendMeter({ backstopMs: 30_000 }), gauge: null },
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
    ]
  ) {
    const res = await call({ model: "openai/gpt-6", messages: [], ...extra });
    assertEquals(res.status, 400, JSON.stringify(extra));
    const body = await res.json();
    assertEquals(body.code, "body_not_allowed");
    assert(body.refused[0].startsWith(Object.keys(extra)[0]), body.refused[0]);
  }
  // `null` is not asking for anything.
  assertEquals((await call({ model: "openai/gpt-6", messages: [], models: null })).status, 200);
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
    const [method, path] of [["GET", "/v1/credits"], ["GET", "/v1/key"], [
      "POST",
      "/v1/completions",
    ]]
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
  const models = await handler(
    new Request("http://proxy.test/v1/models", {
      headers: { authorization: `Bearer ${env.RYPH_MODEL_API_KEY}` },
    }),
  );
  assertEquals(models.status, 200);
  await models.body?.cancel();
  assertEquals(seen.map((s) => s.url), ["https://openrouter.ai/api/v1/models"]);
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

  // Not BYOK, or no upstream figure that is one: the fee is the whole bill.
  for (
    const over of [
      { is_byok: false },
      { cost_details: { upstream_inference_cost: null } },
      { cost_details: { upstream_inference_cost: -1 } },
    ]
  ) {
    const slice = await makeSlice({
      upstream: () =>
        Response.json({ model: "openai/gpt-6", choices: [], usage: { ...usage, ...over } }),
    });
    await (await slice.call({ model: "openai/gpt-6", messages: [] })).text();
    assertEquals((await slice.rows())[0].costUsd, 0.0001, JSON.stringify(over));
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
