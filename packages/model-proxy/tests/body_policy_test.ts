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

test("OpenRouter's content parts: only text, image, file and audio, every one inline", () => {
  const vet = (part: unknown, openRouter = true) => {
    const bytes = enc.encode(JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, part] }],
    }));
    return vetBody(bytes, "openai-chat", new Set(), { openRouter });
  };
  const pdf = "data:application/pdf;base64,JVBERi0xLjQK";
  for (
    const part of [
      { type: "image_url", image_url: { url: PNG } },
      { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
      { type: "file", file: { filename: "a.pdf", file_data: pdf } },
    ]
  ) {
    assertEquals(vet(part).refused, [], JSON.stringify(part));
  }
  assertEquals(vet({ type: "file", file: { file_data: pdf } }).carriesFile, true);
  assertEquals(vet({ type: "text", text: "x" }).carriesFile, false);

  for (
    const part of [
      { type: "video_url", video_url: { url: "https://x.test/v.mp4" } },
      { type: "refusal", refusal: "no" },
      { text: "untyped" },
      { type: "file", file: { file_data: "https://x.test/a.pdf" } },
      { type: "file", file: { file_data: " HTTP://x.test/a.pdf" } },
      { type: "file", file: { filename: "a.pdf" } },
      { type: "file", file: { file_data: { url: "https://x.test" } } },
      { type: "input_audio", input_audio: { data: "https://x.test/a.wav" } },
      { type: "input_audio", input_audio: { data: "data:audio/wav;base64,UklG" } },
      { type: "input_audio", input_audio: { format: "wav" } },
    ]
  ) {
    const { refused } = vet(part);
    assertEquals(refused.length, 1, JSON.stringify(part));
    assert(refused[0].startsWith("messages[0].content[1]: "), refused[0]);
  }
  // A file by id is refused for every provider, as it was.
  assertEquals(vet({ type: "file", file: { file_id: "f-1" } }, false).refused.length, 1);
  // The OpenRouter-only rules stay OpenRouter's.
  assertEquals(vet({ type: "video_url", video_url: { url: "https://x.test" } }, false).refused, []);
  // OpenRouter's own top-level fields, beside the shape's.
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
