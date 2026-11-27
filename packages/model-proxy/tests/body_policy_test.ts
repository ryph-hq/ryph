// What a model call's body may carry: client tools and inline media pass, server tools, media by
// URL or by stored id, and stored state are refused, wherever in the body they stand.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { refusedInBody, vetBody } from "../src/core/body_policy.ts";
import type { BodyShape } from "../src/core/endpoints.ts";
import { topLevelMembers } from "../src/core/model_field.ts";

const enc = new TextEncoder();

function refused(shape: BodyShape, body: unknown | string): string[] {
  const bytes = enc.encode(typeof body === "string" ? body : JSON.stringify(body));
  const members = topLevelMembers(
    bytes,
    new Set([
      "previous_response_id",
      "conversation",
      "prompt",
      "thread",
      "mcp_servers",
      "container",
      "web_search_options",
    ]),
  )!;
  const present = new Set(
    [...members].filter(([, span]) =>
      new TextDecoder().decode(
        bytes.subarray(span.start, span.end),
      ) !== "null"
    ).map(([name]) => name),
  );
  return refusedInBody(bytes, shape, present);
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const schema = {
  type: "object",
  // A tool's own parameters may be called anything, the names the rules key on included.
  properties: {
    file_id: { type: "string" },
    url: { type: "string" },
    source: { type: "url" },
    image_url: { type: "string" },
    tools: { type: "array", items: { type: "object" } },
  },
};

test("what pi 1.6.1 sends passes, for each shape", () => {
  assertEquals(
    refused("anthropic-messages", {
      model: "claude-sonnet-5",
      max_tokens: 1000,
      tools: [{
        name: "bash",
        description: "x",
        input_schema: schema,
        eager_input_streaming: true,
      }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "t1",
            name: "fetch",
            // A call's arguments are the model's, and never judged.
            input: { url: "https://example.com", file_id: "f", type: "image" },
          }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", data: "AAAA" } }],
            },
            {
              type: "tool_addition",
              tool: { type: "tool_definition", definition: { name: "x", input_schema: schema } },
            },
          ],
        },
      ],
    }),
    [],
  );
  assertEquals(
    refused("openai-responses", {
      model: "gpt-5",
      store: false,
      stream: true,
      previous_response_id: null,
      tools: [
        { type: "function", name: "bash", parameters: schema, strict: false },
        { type: "custom", name: "patch", format: { type: "grammar", syntax: "lark" } },
      ],
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "a" }] },
        {
          type: "tool_search_output",
          execution: "client",
          tools: [{ type: "function", name: "b", defer_loading: true }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: PNG }],
        },
        { type: "function_call", call_id: "c", name: "a", arguments: '{"url":"https://x"}' },
        {
          type: "function_call_output",
          call_id: "c",
          output: [{ type: "input_image", image_url: PNG }],
        },
      ],
    }),
    [],
  );
  assertEquals(
    refused("openai-chat", {
      model: "llama-4",
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "bash", parameters: schema } }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: PNG } }],
      }],
    }),
    [],
  );
});

test("server tools are refused, wherever a tool list stands", () => {
  for (
    const type of [
      "web_search",
      "web_search_preview",
      "file_search",
      "code_interpreter",
      "image_generation",
      "mcp",
      "computer_use_preview",
      "local_shell",
    ]
  ) {
    assertEquals(refused("openai-responses", { tools: [{ type }] }).length, 1, type);
    assertEquals(
      refused("openai-responses", {
        input: [{ type: "additional_tools", tools: [{ type: "function", name: "a" }, { type }] }],
      }).length,
      1,
      `${type} in additional_tools`,
    );
  }
  const mcp = refused("openai-responses", {
    tools: [{ type: "namespace", name: "n", tools: [{ type: "mcp", server_url: "https://evil" }] }],
  });
  assertEquals(mcp.length, 1);
  assert(mcp[0].startsWith("tools[0].tools[0]"), mcp[0]);

  for (
    const type of [
      "web_search_20250305",
      "web_fetch_20250910",
      "code_execution_20250825",
      "bash_20250124",
      "memory_20250818",
    ]
  ) {
    assertEquals(refused("anthropic-messages", { tools: [{ type, name: "x" }] }).length, 1, type);
  }
  assertEquals(refused("anthropic-messages", { tools: [{ type: "custom", name: "x" }] }), []);
  // A server tool slipped in as a mid-conversation addition.
  assertEquals(
    refused("anthropic-messages", {
      messages: [{
        role: "user",
        content: [{
          type: "tool_addition",
          tool: { type: "tool_definition", definition: { type: "web_fetch_20250910" } },
        }],
      }],
    }).length,
    1,
  );
  assertEquals(refused("openai-chat", { tools: [{ type: "web_search" }] }).length, 1);
  // An OpenAI tool always names its type; one that does not is not a function tool.
  assertEquals(refused("openai-chat", { tools: [{ function: { name: "x" } }] }).length, 1);
});

test("media by URL or by stored id is refused; inline media passes", () => {
  const evil = "https://attacker.example/x.png?secret=1";
  const cases: Array<[BodyShape, unknown]> = [
    ["openai-responses", {
      input: [{ role: "user", content: [{ type: "input_image", image_url: evil }] }],
    }],
    ["openai-responses", {
      input: [{ role: "user", content: [{ type: "input_image", file_id: "file-1" }] }],
    }],
    ["openai-responses", {
      input: [{ role: "user", content: [{ type: "input_file", file_url: evil }] }],
    }],
    ["openai-responses", {
      input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }],
    }],
    ["openai-responses", { input: [{ type: "item_reference", id: "msg_other_run" }] }],
    // Escaped, mixed-case and padded spellings of a scheme are still that scheme.
    ["openai-responses", '{"input":[{"type":"input_image","image_url":"h\\u0074tps://x"}]}'],
    ["openai-responses", '{"input":[{"type":"input\\u005fimage","image_url":"https://x"}]}'],
    ["openai-chat", {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: evil } }] }],
    }],
    ["openai-chat", {
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-1" } }] }],
    }],
    ["anthropic-messages", {
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "url", url: evil } }],
      }],
    }],
    ["anthropic-messages", {
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "file", file_id: "f" } }],
      }],
    }],
    ["anthropic-messages", {
      messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }],
    }],
    // Nested in a tool result, still media.
    ["anthropic-messages", {
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          content: [{ type: "image", source: { type: "url", url: evil } }],
        }],
      }],
    }],
  ];
  for (const [shape, body] of cases) {
    assertEquals(refused(shape, body).length, 1, JSON.stringify(body));
  }
  assertEquals(
    refused("openai-responses", {
      input: [{
        role: "user",
        content: [{ type: "input_image", image_url: ` DATA:image/png;base64,AA` }],
      }],
    }),
    [],
  );
  assertEquals(
    refused("openai-responses", {
      input: [{
        role: "user",
        content: [{
          type: "input_file",
          filename: "a.pdf",
          file_data: "data:application/pdf;base64,AA",
        }],
      }],
    }),
    [],
  );
  assertEquals(
    refused("anthropic-messages", {
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "text", data: "x" } }],
      }],
    }),
    [],
  );
});

test("the last of two spellings of a member is the one judged, as a parse judges it", () => {
  assertEquals(
    refused(
      "openai-responses",
      '{"input":[{"type":"input_image","image_url":"data:x","image_url":"https://x"}]}',
    ).length,
    1,
  );
  assertEquals(
    refused("openai-responses", '{"tools":[{"type":"function","type":"mcp"}]}').length,
    1,
  );
});

test("stored state and provider-side fields at the top level are refused", () => {
  assertEquals(refused("openai-responses", { previous_response_id: "resp_1" }).length, 1);
  assertEquals(refused("openai-responses", { conversation: "conv_1" }).length, 1);
  assertEquals(refused("openai-responses", { prompt: { id: "pmpt_1" } }).length, 1);
  assertEquals(refused("openai-chat", { web_search_options: {} }).length, 1);
  assertEquals(
    refused("anthropic-messages", { thread: { type: "continue", previous_message_id: "msg_1" } })
      .length,
    1,
  );
  assertEquals(refused("anthropic-messages", { mcp_servers: [{ url: "https://x" }] }).length, 1);
  assertEquals(refused("anthropic-messages", { container: "c_1" }).length, 1);
});

test("a body nested past the limit is refused rather than walked", () => {
  const deep = `{"a":${"[".repeat(300)}${"]".repeat(300)}}`;
  assertEquals(refused("openai-chat", deep).length, 1);
});

// ── OpenRouter: closed shapes under a message's content and images ─────────────────────────

/** Vets `body` as the proxy vets an OpenRouter call: every top-level name, null ones included. */
function vetOpenRouter(body: Record<string, unknown>) {
  const bytes = enc.encode(JSON.stringify(body));
  const named = new Set(Object.keys(body));
  const present = new Set(Object.keys(body).filter((name) => body[name] !== null));
  return vetBody(bytes, "openai-chat", present, { openRouter: true, named });
}

const CACHE = { type: "ephemeral" };
const CACHE_LONG = { type: "ephemeral", ttl: "1h" };

/**
 * A body exactly as pi-ai 1.6.0's openai-completions provider builds one for OpenRouter
 * (`dist/api/openai-completions.js`: `buildParams`, `convertMessages`, `convertTools` and
 * `applyAnthropicCacheControl`), every branch an OpenRouter run can take at once. If any of it is
 * refused, OpenRouter runs break.
 */
function piBody(): Record<string, unknown> {
  return {
    model: "anthropic/claude-sonnet-5",
    messages: [
      // The system prompt, its text moved into a part to carry `cache_control`
      // (addCacheControlToSystemPrompt).
      { role: "system", content: [{ type: "text", text: "You are ryph.", cache_control: CACHE }] },
      // A later system update stays a string.
      { role: "system", content: "Tools were added." },
      // User text as a string, and as a list of text and an inline image.
      { role: "user", content: "fix the build" },
      {
        role: "user",
        content: [
          { type: "text", text: "this screenshot" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
      // An assistant turn of tool calls alone: content null, a function call and a grammar
      // tool's custom call, and the reasoning OpenRouter handed back, whose data is opaque and
      // may hold anything, a URL included.
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"curl https://x.test"}' },
          },
          { id: "call_2", type: "custom", custom: { name: "apply_patch", input: "*** Begin" } },
        ],
        reasoning_details: [
          {
            type: "reasoning.encrypted",
            id: "rs_1",
            format: "anthropic-claude-v1",
            index: 0,
            data: "https://x.test/reasoning",
          },
          { type: "reasoning.text", text: "thinking", signature: null, index: 1 },
          { type: "reasoning.summary", summary: "summary", format: "openai-responses-v1" },
        ],
      },
      // A tool result as a string, and the last one turned into a list for its cache_control.
      { role: "tool", content: "ok", tool_call_id: "call_1" },
      {
        role: "tool",
        content: [{ type: "text", text: "patched", cache_control: CACHE_LONG }],
        tool_call_id: "call_2",
        name: "apply_patch",
      },
      // The images a tool result returned, as the user message that follows it.
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "image_url", image_url: { url: PNG } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
        ],
      },
      // An assistant's text as a string with its reasoning field; an empty one
      // (requiresNonNullAssistantContent); thinking as text parts (requiresThinkingAsText).
      { role: "assistant", content: "Done.", reasoning_content: "it built" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c3", type: "function", function: { name: "a", arguments: "{}" } }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "thinking" }, { type: "text", text: "answer" }],
        reasoning_content: "",
      },
      { role: "assistant", content: "I have processed the tool results." },
      // Tools added mid-conversation, on a system message of their own.
      {
        role: "system",
        tools: [{ type: "function", function: { name: "late", parameters: schema } }],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_tokens: 16384,
    temperature: 0.2,
    tools: [
      {
        type: "function",
        function: { name: "bash", description: "run", parameters: schema, strict: false },
      },
      {
        type: "custom",
        custom: {
          name: "apply_patch",
          description: "patch",
          format: { type: "grammar", grammar: { syntax: "lark", definition: "start: x" } },
        },
        cache_control: CACHE,
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "high" },
  };
}

test("OpenRouter: everything pi sends passes", () => {
  const { refused, carriesFile } = vetOpenRouter(piBody());
  assertEquals(refused, []);
  assertEquals(carriesFile, false);
  // pi's other reasoning settings, and a model told to think not at all.
  assertEquals(vetOpenRouter({ ...piBody(), reasoning: { effort: "none" } }).refused, []);
});

test("OpenRouter: every part type ryph forwards passes, inline, with its own members", () => {
  const pdf = "data:application/pdf;base64,JVBERi0xLjQK";
  const parts = [
    { type: "text", text: "hi" },
    { type: "text", text: "hi", cache_control: CACHE_LONG },
    { type: "image_url", image_url: { url: PNG } },
    { type: "image_url", image_url: { url: PNG, detail: "high" } },
    { type: "file", file: { filename: "a.pdf", file_data: pdf } },
    { type: "file", file: { file_data: pdf } },
    { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
  ];
  for (const part of parts) {
    const body = { model: "m", messages: [{ role: "user", content: [part] }] };
    assertEquals(vetOpenRouter(body).refused, [], JSON.stringify(part));
  }
  const withFile = { model: "m", messages: [{ role: "user", content: [parts[4]] }] };
  assertEquals(vetOpenRouter(withFile).carriesFile, true);
  // Images an assistant message carries back.
  const images = { model: "m", messages: [{ role: "assistant", images: [parts[2]] }] };
  assertEquals(vetOpenRouter(images).refused, []);
  const noImages = { model: "m", messages: [{ role: "assistant", content: "x", images: null }] };
  assertEquals(vetOpenRouter(noImages).refused, []);
});

test("OpenRouter: anything off a part's closed shape is refused", () => {
  const pdf = "data:application/pdf;base64,JVBERi0xLjQK";
  /** The refusals for one part, in a user message's content and in an assistant's images. */
  const vet = (part: unknown, where: "content" | "images" = "content") =>
    vetOpenRouter({
      model: "m",
      messages: [{ role: where === "content" ? "user" : "assistant", [where]: [part] }],
    }).refused;
  const cases: Array<[string, unknown]> = [
    // A member beside the payload that OpenRouter may read, and no rule here would.
    ["a part with a sibling url", { type: "image_url", image_url: { url: PNG }, url: "https://x" }],
    ["an image part with its url at the top", { type: "image_url", url: "https://x.test/a.png" }],
    [
      "an image payload with a file_url",
      { type: "image_url", image_url: { url: PNG, file_url: "https://x.test" } },
    ],
    ["a text part with an image", { type: "text", text: "x", image_url: { url: PNG } }],
    ["a text part with a file", { type: "text", text: "x", file: { file_data: pdf } }],
    ["a null payload", { type: "image_url", image_url: null }],
    ["a missing payload", { type: "file" }],
    ["an image as a bare string", { type: "image_url", image_url: PNG }],
    ["an image by URL", { type: "image_url", image_url: { url: "https://x.test/a.png" } }],
    ["an image whose url is no string", { type: "image_url", image_url: { url: { href: PNG } } }],
    ["an image with no url", { type: "image_url", image_url: { detail: "low" } }],
    ["a null detail", { type: "image_url", image_url: { url: PNG, detail: null } }],
    ["an unknown type", { type: "video_url", video_url: { url: "https://x.test/v.mp4" } }],
    ["a refusal part", { type: "refusal", refusal: "no" }],
    ["an untyped part", { text: "untyped" }],
    ["a type that is no string", { type: ["text"], text: "x" }],
    ["text that is no string", { type: "text", text: { url: "https://x" } }],
    ["a file by URL", { type: "file", file: { file_data: "https://x.test/a.pdf" } }],
    ["a file by URL, spaced", { type: "file", file: { file_data: " HTTP://x.test/a.pdf" } }],
    ["a file with no data", { type: "file", file: { filename: "a.pdf" } }],
    ["a file by id", { type: "file", file: { file_id: "f-1" } }],
    ["a file with a url too", { type: "file", file: { file_data: pdf, url: "https://x.test" } }],
    ["a file with a null file_url", { type: "file", file: { file_data: pdf, file_url: null } }],
    ["file data as an object", { type: "file", file: { file_data: { url: "https://x" } } }],
    ["audio by URL", { type: "input_audio", input_audio: { data: "https://x.test/a.wav" } }],
    ["audio as a data URL", { type: "input_audio", input_audio: { data: "data:audio/wav;b" } }],
    ["audio with no data", { type: "input_audio", input_audio: { format: "wav" } }],
    [
      "audio with a source",
      { type: "input_audio", input_audio: { data: "UklG", source: { url: "https://x.test" } } },
    ],
    ["a cache_control that is no object", { type: "text", text: "x", cache_control: "ephemeral" }],
    [
      "a cache_control with more in it",
      { type: "text", text: "x", cache_control: { type: "ephemeral", url: "https://x" } },
    ],
    ["a cache_control with no type", { type: "text", text: "x", cache_control: { ttl: "1h" } }],
  ];
  for (const [name, part] of cases) {
    for (const where of ["content", "images"] as const) {
      const refused = vet(part, where);
      assertEquals(refused.length, 1, `${name} (${where}): ${refused.join(" | ")}`);
      assert(refused[0].startsWith(`messages[0].${where}[0]`), `${name}: ${refused[0]}`);
    }
  }
  // The shapes are OpenRouter's: another provider's body is held to the shape's rules alone.
  const loose = { model: "m", messages: [{ role: "user", content: [cases[0][1], cases[12][1]] }] };
  assertEquals(refused("openai-chat", loose), []);
});

test("OpenRouter: content is text, null or a list of parts, and images null or a list of parts", () => {
  const vet = (message: Record<string, unknown>) =>
    vetOpenRouter({ model: "m", messages: [{ role: "user", ...message }] }).refused;
  assertEquals(vet({ content: "hi" }), []);
  assertEquals(vet({ content: null }), []);
  assertEquals(vet({}), []);
  assertEquals(vet({ content: [] }), []);
  assertEquals(vet({ content: [{ type: "text", text: "hi" }] }), []);

  const cases: Array<[string, Record<string, unknown>]> = [
    // One part on its own, as an object, would pass every part rule unseen.
    ["content as one part", { content: { type: "text", text: "hi" } }],
    ["content as a number", { content: 42 }],
    ["content as a boolean", { content: true }],
    ["a list in content", { content: [[{ type: "video_url", video_url: { url: "https://x" } }]] }],
    ["a string in content", { content: ["hi"] }],
    ["a null in content", { content: [null] }],
    ["images as one part", { images: { type: "image_url", image_url: { url: PNG } } }],
    ["images as a string", { images: PNG }],
    ["a list in images", { images: [[{ type: "image_url", image_url: { url: PNG } }]] }],
    ["a string in images", { images: ["https://x.test/a.png"] }],
  ];
  for (const [name, message] of cases) {
    const refused = vet(message);
    assertEquals(refused.length, 1, `${name}: ${refused.join(" | ")}`);
    assert(refused[0].startsWith("messages[0]: "), `${name}: ${refused[0]}`);
  }
  // Elsewhere a `content` list of typed objects is not a message's: a tool's JSON Schema.
  const tool = {
    type: "function",
    function: { name: "t", parameters: { content: [{ type: "video_url" }] } },
  };
  assertEquals(vetOpenRouter({ model: "m", tools: [tool], messages: [] }).refused, []);
});

test("OpenRouter: its own top-level fields are refused by name, beside the shape's", () => {
  const top = vetBody(enc.encode("{}"), "openai-chat", new Set(["plugins", "web_search_options"]), {
    openRouter: true,
  });
  assertEquals(top.refused.length, 2);
  // Including `provider`, whose routing preferences can override the account's data settings.
  const routing = vetBody(enc.encode("{}"), "openai-chat", new Set(["provider"]), {
    openRouter: true,
  });
  assertEquals(routing.refused.length, 1);
  assert(routing.refused[0].startsWith("provider ("), routing.refused[0]);
  assertEquals(vetBody(enc.encode("{}"), "openai-chat", new Set(["provider"])).refused, []);
  // OpenRouter's fields are refused by name, a `null` value included; the shape's are not.
  const named = vetBody(enc.encode("{}"), "openai-chat", new Set(), {
    openRouter: true,
    named: new Set(["models", "plugins", "preset", "provider", "web_search_options"]),
  });
  assertEquals(named.refused.map((r) => r.split(" ")[0]), [
    "models",
    "plugins",
    "preset",
    "provider",
  ]);
});
