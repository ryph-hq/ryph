// What a call is charged when its response never said: the request made to ask, and the
// estimate when it still did not.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  ensureObjectField,
  estimatedInputTokens,
  estimatedTokens,
  insertMember,
  MEDIA_MIN_TOKENS,
  requestedMaxOutput,
  streams,
} from "../src/core/usage_fallback.ts";
import { topLevelMembers } from "../src/core/model_field.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const FIELDS = new Set([
  "stream",
  "stream_options",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
]);

/** The proxy's stream splice: only a streamed body is made to ask. */
function asked(body: string): unknown {
  const bytes = enc.encode(body);
  const members = topLevelMembers(bytes, FIELDS)!;
  if (!streams(bytes, members)) return null;
  const out = ensureObjectField(bytes, members, "stream_options", "include_usage");
  return out === null ? null : JSON.parse(dec.decode(out));
}

test("a streamed body is made to ask for its usage, spliced in place", () => {
  assertEquals(asked('{"model":"m","stream":true}'), {
    stream_options: { include_usage: true },
    model: "m",
    stream: true,
  });
  assertEquals(asked(' \n{"stream":true,"stream_options":null}'), {
    stream: true,
    stream_options: { include_usage: true },
  });
  // A later `stream_options` would win in a parse, so it is the one edited, wherever it is.
  assertEquals(asked('{"stream_options":{"include_usage":false,"x":1},"stream":true}'), {
    stream_options: { include_usage: true, x: 1 },
    stream: true,
  });
  assertEquals(asked('{"stream":true,"stream_options":{"include_usage":true}}'), null);
  assertEquals(asked('{"stream":false}'), null);
  assertEquals(asked('{"model":"m"}'), null);
  assertEquals(asked('{"stream":true,"stream_options":"x"}'), null);
});

test("the estimate: text by bytes, media by run, output by the request's own cap", () => {
  const text = enc.encode(JSON.stringify({ messages: [{ content: "hello there, model" }] }));
  assertEquals(estimatedInputTokens(text), Math.ceil(text.length / 4));
  const image = "A".repeat(750 * 4000);
  const withImage = enc.encode(`{"data":"${image}"}`);
  assertEquals(estimatedInputTokens(withImage), Math.ceil(11 / 4) + 4000);
  const small = enc.encode(`{"data":"${"A".repeat(2000)}"}`);
  assertEquals(estimatedInputTokens(small), Math.ceil(11 / 4) + MEDIA_MIN_TOKENS);

  const body = enc.encode('{"max_tokens":800,"max_completion_tokens":1200}');
  assertEquals(requestedMaxOutput(body, topLevelMembers(body, FIELDS)), 1200);
  const none = enc.encode('{"max_tokens":null}');
  assertEquals(requestedMaxOutput(none, topLevelMembers(none, FIELDS)), null);
});

test("what a response did report stands; only what it did not is estimated", () => {
  assertEquals(estimatedTokens(null, { input: 10, output: 20 }), {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
  });
  const reported = {
    input: 3,
    output: 5,
    cacheRead: 900,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
  };
  assertEquals(estimatedTokens(reported, { input: 10, output: 20 }), {
    ...reported,
    output: 20,
  });
});

function costAsked(body: string): unknown {
  const bytes = enc.encode(body);
  const out = ensureObjectField(
    bytes,
    topLevelMembers(bytes, new Set([...FIELDS, "usage"]))!,
    "usage",
    "include",
  );
  return out === null ? null : JSON.parse(dec.decode(out));
}

test("an OpenRouter body is made to ask for its cost, spliced in place", () => {
  assertEquals(costAsked('{"model":"m","stream":true}'), {
    usage: { include: true },
    model: "m",
    stream: true,
  });
  assertEquals(costAsked(" {}"), { usage: { include: true } });
  assertEquals(costAsked('{"usage":null,"stream":false}'), {
    usage: { include: true },
    stream: false,
  });
  assertEquals(costAsked('{"usage":{"include":false},"stream":true}'), {
    usage: { include: true },
    stream: true,
  });
  // Already asking, or a `usage` that is no object: left as it came.
  assertEquals(costAsked('{"usage":{"include":true}}'), null);
  assertEquals(costAsked('{"usage":"yes"}'), null);
  assertEquals(costAsked('{"usage":[1]}'), null);
});

test("a member is inserted first, with a comma only when one follows", () => {
  const inserted = (body: string) =>
    JSON.parse(dec.decode(insertMember(enc.encode(body), "plugins", '[{"id":"x"}]')!));
  assertEquals(inserted('{"model":"m"}'), { plugins: [{ id: "x" }], model: "m" });
  assertEquals(inserted(" { } "), { plugins: [{ id: "x" }] });
  assertEquals(insertMember(enc.encode("[1]"), "plugins", "[]"), null);
});
