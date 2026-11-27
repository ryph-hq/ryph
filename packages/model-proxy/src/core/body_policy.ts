// What a model call's BODY may ask the provider to do. The route table (core/endpoints.ts) says
// which calls a run may make with the real key; this says what one of those calls may carry.
//
// A model call is not only tokens in and tokens out. Both providers run tools on their own side
// (web search and fetch, code execution, file search, image generation, hosted MCP servers and
// connectors), fetch images and documents from a URL the request names, and read files, vector
// stores and stored responses the organization keeps. Each of those reaches past what the proxy
// can see or count: the provider dials an address the run chose, from outside the run's network
// (an exfiltration channel and a way around its egress rules); a hosted tool is billed per call
// or per container hour, never in the tokens metered here; and a file id or a stored response
// is the organization's data, other runs' included.
//
// So a body is held to what the harness actually sends — client-side function tools and inline
// (base64) media — and anything else is refused with a 400 that names it. Refused, never
// stripped: a run whose tool or image silently vanished would only find out from the model's
// confusion.
//
// What pi 1.6.1 sends, which this must keep passing (pi-ai's anthropic-messages,
// openai-responses-shared and openai-completions): Anthropic tools with no `type` (client tools),
// `tool_addition` blocks carrying the same, images as `source: {type: "base64"}`; OpenAI
// Responses `function`/`custom` tools, top-level and in `additional_tools` and client
// `tool_search_output` items, images as `input_image` with a `data:` URL; Chat Completions
// `function` tools and `image_url` parts with a `data:` URL.
//
// Invariants:
// - the body is walked once, as bytes (core/model_field.ts `visitObjects`), never parsed whole:
//   the same reason the model is read that way
// - every rule is keyed on an object's own `type`, never on a bare member name, so a tool's
//   JSON Schema with a `file_id` or `url` property, or a tool call's arguments, is not judged
// - unknown is refused: a tool type, a media source type or a URL scheme this does not know
//   fails closed, and the provider's own refusal is never what is relied on
// - on an OpenRouter body, every value reachable under a message's `content` or `images` has a
//   shape known here exactly, and anything else is refused. `content` is text, null or a list of
//   part objects; `images` is null or a list of part objects; each part carries exactly its own
//   type's members (`OPENROUTER_PARTS`), and each of a part's objects exactly its own
//   (`OPENROUTER_PART_OBJECTS`), every one of them a string. A shape is a closed allowlist, never
//   a list of what to refuse: OpenRouter reads members this file has never heard of (a `url`
//   beside inline bytes, say), and only a closed shape keeps each of them out without first
//   having to name it. Parts are found by where they sit, so a tool's JSON Schema with a
//   `content` list of typed objects is not judged

import type { BodyShape } from "./endpoints.ts";
import { type JsonKind, NOT_A_STRING, type ObjectSeen, visitObjects } from "./model_field.ts";

/** How deep a body may nest. A conversation is a handful of levels and a tool's JSON Schema
 * rarely twenty. */
export const MAX_BODY_DEPTH = 256;

/** At most this many refusals are named in one answer. */
const MAX_NAMED = 10;

/** Tool types each shape's provider runs on the CALLER's side. Anthropic's client tools carry
 * no type at all (`ABSENT`), or `custom`; every typed one is a server tool. A Responses
 * `namespace` only groups tools, and its members are judged as tools themselves. */
const ABSENT = "";
const CLIENT_TOOL_TYPES: Record<BodyShape, ReadonlySet<string>> = {
  "anthropic-messages": new Set([ABSENT, "custom"]),
  "openai-responses": new Set(["function", "custom", "namespace"]),
  "openai-chat": new Set(["function", "custom"]),
};

/**
 * Top-level fields that pull in state the proxy cannot see, or reach past one metered call:
 * - `previous_response_id`, `conversation`: a stored response or conversation, by id. pi sends
 *   `store: false` and carries its history in `input`, so it never uses either, and an id from
 *   another run (or another person's session on the same key) would hand its whole context over
 * - `prompt`: a prompt template the organization stored on OpenAI's side, the same kind of data
 * - `thread` (Anthropic): a message thread, continued from a stored reply by id — the same kind
 *   of handle as `previous_response_id`. pi only sends it to `api.anthropic.com` directly
 *   (`compat.supportsMessageThreads` defaults off for any other baseUrl), so never through here
 * - `mcp_servers` (Anthropic): servers the provider dials on the run's behalf
 * - `container` (Anthropic): a code-execution container, billed by the hour
 * - `web_search_options` (Chat Completions): the search models' built-in web search
 */
const REFUSED_TOP_LEVEL: Record<BodyShape, readonly string[]> = {
  "anthropic-messages": ["thread", "mcp_servers", "container"],
  "openai-responses": ["previous_response_id", "conversation", "prompt"],
  "openai-chat": ["web_search_options"],
};

/**
 * Top-level fields OPENROUTER reads that reach past the model a run was allowed, refused on an
 * OpenRouter body whatever its shape:
 * - `models`: a fallback list OpenRouter tries when the named model fails — models the allowlist
 *   never saw, at prices the cap never counted
 * - `plugins`: web search, file parsing and the like, run on OpenRouter's side and billed per
 *   request, not in the tokens metered here (the proxy names the one file parser it allows itself:
 *   `OPENROUTER_FILE_PARSER`)
 * - `preset`: a configuration stored in the OpenRouter account, which can name its own models
 *   and plugins
 * - `provider`: routing preferences, which can override what the account decided about which
 *   upstreams may keep or train on its data (`data_collection`, `zdr`, `only`, `ignore`). pi
 *   does not send it
 * - `debug`: OpenRouter's debugging options; `echo_upstream_body` streams back the request as
 *   OpenRouter sent it upstream, the account's routing and what OpenRouter added included
 * Each is refused by NAME, whatever its value, `null` included: the proxy adds members of its own
 * to an OpenRouter body (`plugins`), and a `null` it let through is one OpenRouter reads.
 * A model id's own suffixes (`:online`, `@preset/…`) need no rule: the allowlist is exact ids.
 */
const OPENROUTER_REFUSED: Readonly<Record<string, string>> = {
  models: "fallback models the run's allowlist does not cover",
  plugins: "OpenRouter-side plugins, billed per request",
  preset: "a preset stored in the OpenRouter account",
  provider: "routing preferences that can override the account's data and retention settings",
  debug: "OpenRouter's debugging options, which echo the request it sent upstream",
};

const OPENROUTER_REFUSED_FIELDS: readonly string[] = Object.keys(OPENROUTER_REFUSED);

/** One member of a closed shape: the kind of value it must hold, and whether it must be there. */
interface MemberRule {
  kind: JsonKind;
  required?: boolean;
}

/** A closed shape: exactly these members, each of its kind. */
type Shape = Readonly<Record<string, MemberRule>>;

const TYPE: MemberRule = { kind: "string", required: true };

/**
 * The content parts an OpenRouter message may carry, by `type`, each with exactly its members.
 * OpenRouter fetches what a part names by URL (an image, a PDF, a video, audio) from its own
 * side, at an address the run picked; so each part's payload is held to inline bytes, and a part
 * type not here (`video_url`, and whatever OpenRouter adds next) is refused rather than trusted to
 * be harmless. pi sends `text` (with `cache_control` on an Anthropic model's last text) and
 * `image_url`.
 */
const OPENROUTER_PARTS: Readonly<Record<string, Shape>> = {
  text: { type: TYPE, text: { kind: "string", required: true }, cache_control: { kind: "object" } },
  image_url: { type: TYPE, image_url: { kind: "object", required: true } },
  file: { type: TYPE, file: { kind: "object", required: true } },
  input_audio: { type: TYPE, input_audio: { kind: "object", required: true } },
};

/**
 * The objects a part carries, by the member that holds them, each with exactly its members. Every
 * member is a string, so nothing sits below them. `cache_control` is what pi sends: `{type:
 * "ephemeral"}`, with `ttl: "1h"` for a long retention.
 */
const OPENROUTER_PART_OBJECTS: Readonly<Record<string, Shape>> = {
  image_url: { url: { kind: "string", required: true }, detail: { kind: "string" } },
  file: { filename: { kind: "string" }, file_data: { kind: "string", required: true } },
  input_audio: { data: { kind: "string", required: true }, format: { kind: "string" } },
  cache_control: { type: { kind: "string", required: true }, ttl: { kind: "string" } },
};

/** Where a message sits. */
const MESSAGE = /^messages\[\d+\]$/;

/** Where a message's content part sits: `messages[i].content[j]`, or an image an assistant
 * message carries back (`messages[i].images[j]`). */
const MESSAGE_PART = /^messages\[\d+\]\.(?:content|images)\[\d+\]$/;

/** Where an object a part carries sits: `messages[i].content[j].image_url` and the like. */
const PART_OBJECT = /^messages\[\d+\]\.(?:content|images)\[\d+\]\.[a-z_]+$/;

/** What a message's `content` and `images` may be on OpenRouter. An object would be one part no
 * part rule sees, since parts are found as the elements of a list. */
const OPENROUTER_MESSAGE_LISTS: Readonly<Record<string, ReadonlySet<JsonKind>>> = {
  content: new Set(["string", "array", "null"]),
  images: new Set(["array", "null"]),
};

/** A JSON kind as a refusal names it. */
function kindName(kind: string): string {
  if (kind === "null") return kind;
  return kind === "object" || kind === "array" ? `an ${kind}` : `a ${kind}`;
}

/** How `members` falls short of `shape`, in words, after `what`: members it does not take,
 * members of the wrong kind (`null` included), and members it needs that are missing. Null when
 * it fits. */
function misfit(members: ReadonlyMap<string, JsonKind>, shape: Shape, what: string): string | null {
  const problems: string[] = [];
  const unknown = [...members.keys()].filter((name) => !Object.hasOwn(shape, name));
  if (unknown.length > 0) {
    problems.push(`takes no ${unknown.map((name) => JSON.stringify(name)).join(", ")}`);
  }
  for (const [name, rule] of Object.entries(shape)) {
    const kind = members.get(name);
    if (kind === undefined) {
      if (rule.required === true) problems.push(`needs ${JSON.stringify(name)}`);
    } else if (kind !== rule.kind) {
      problems.push(
        `${JSON.stringify(name)} must be ${kindName(rule.kind)}, not ${kindName(kind)}`,
      );
    }
  }
  return problems.length === 0 ? null : `${what}: ${problems.join("; ")}`;
}

/** Why an OpenRouter part's payload is not inline bytes, or null when it is (or when it is not a
 * string at all, which the part's shape refuses). `payload` is the payload object's strings. */
function notInline(type: string, payload: ReadonlyMap<string, string> | undefined): string | null {
  const value = (name: string) => {
    const text = payload?.get(name);
    return text === undefined || text === NOT_A_STRING ? null : text;
  };
  switch (type) {
    case "image_url": {
      const url = value("url");
      return url !== null && !isDataUrl(url) ? "an image by URL: send it as a data: URL" : null;
    }
    case "file": {
      // OpenRouter reads `file_data` as a URL to fetch as readily as a data: URL.
      const data = value("file_data");
      return data !== null && !isDataUrl(data)
        ? "a file not sent inline: send it as a data: URL in file_data"
        : null;
    }
    case "input_audio": {
      const data = value("data");
      return data !== null && !isBase64(data)
        ? "audio not sent inline: send it as base64 in data"
        : null;
    }
  }
  return null;
}

/**
 * The plugin the proxy itself adds to an OpenRouter body that carries a file: the file parser,
 * on its free `pdf-text` engine. Left to itself OpenRouter parses a PDF for a model that cannot
 * read one with a paid OCR engine, billed per page on OpenRouter's side and counted by no cap
 * before the bill arrives.
 */
export const OPENROUTER_FILE_PARSER = '[{"id":"file-parser","pdf":{"engine":"pdf-text"}}]';

/** Every top-level field any shape refuses, for the walk that finds them. */
export const REFUSED_TOP_LEVEL_FIELDS: readonly string[] = [
  ...new Set([...Object.values(REFUSED_TOP_LEVEL).flat(), ...OPENROUTER_REFUSED_FIELDS]),
];

/** Anthropic media sources that carry their content inline. `url` has the provider fetch it,
 * `file` reads the Files API. */
const INLINE_SOURCES = new Set(["base64", "text", "content"]);

/** Content and input items that only exist to reference what a provider stores: a stored
 * response item, a file uploaded to a code-execution container. */
const REFUSED_ITEM_TYPES = new Set(["item_reference", "container_upload"]);

const WATCH = {
  strings: new Set(["type", "image_url", "url", "file_id", "file_url", "file_data", "data"]),
  children: new Set(["source", "image_url", "file", "definition", "input_audio"]),
};

/** Whether a URL, as a prefix, is a `data:` URL: the only kind that carries its bytes along. A
 * URL parser drops leading spaces and control characters and reads the scheme in any case. */
function isDataUrl(prefix: string): boolean {
  let i = 0;
  while (i < prefix.length && prefix.charCodeAt(i) <= 0x20) i++;
  return prefix.slice(i, i + 5).toLowerCase() === "data:";
}

/** Whether a string, as a prefix, is bare base64: no scheme, so nothing a provider would fetch. */
function isBase64(prefix: string): boolean {
  return /^[A-Za-z0-9+/=\s]*$/.test(prefix);
}

/** What a body was found to carry, beside what it may not. */
export interface BodyVetting {
  refused: string[];
  /** Whether a message carries a `file` part (Chat Completions). */
  carriesFile: boolean;
}

/** How a body is vetted beyond its shape. */
export interface VetOptions {
  /** Holds it to OpenRouter's rules as well. */
  openRouter?: boolean;
  /** Every top-level member name the body carries, `null`-valued ones included: what
   * OpenRouter's own refusals key on. `topLevel` when not given. */
  named?: ReadonlySet<string>;
}

/** `vetBody`'s refusals alone. */
export function refusedInBody(
  bytes: Uint8Array,
  shape: BodyShape,
  topLevel: ReadonlySet<string>,
  opts: VetOptions = {},
): string[] {
  return vetBody(bytes, shape, topLevel, opts).refused;
}

/**
 * What a model call's body asks for that the proxy does not forward, each named with where it
 * is (empty when nothing), and whether it carries a file. `topLevel` is the set of top-level
 * member names the body carries with a non-null value. `openRouter` holds it to OpenRouter's
 * rules as well: its own top-level fields (by name, see `opts.named`), and only the content parts
 * it reads, inline.
 */
export function vetBody(
  bytes: Uint8Array,
  shape: BodyShape,
  topLevel: ReadonlySet<string>,
  opts: VetOptions = {},
): BodyVetting {
  const refused: string[] = [];
  let carriesFile = false;
  for (const field of REFUSED_TOP_LEVEL[shape]) {
    if (topLevel.has(field)) refused.push(`${field} (stored or provider-side state)`);
  }
  if (opts.openRouter === true) {
    const named = opts.named ?? topLevel;
    for (const field of OPENROUTER_REFUSED_FIELDS) {
      if (named.has(field)) refused.push(`${field} (${OPENROUTER_REFUSED[field]})`);
    }
  }
  const clientTools = CLIENT_TOOL_TYPES[shape];
  const refuse = (seen: ObjectSeen, what: string) => {
    if (refused.length < MAX_NAMED) refused.push(`${seen.path() || "the body"}: ${what}`);
  };
  const ok = visitObjects(bytes, WATCH, MAX_BODY_DEPTH, (seen) => {
    const type = seen.strings.get("type");
    // A tool definition, wherever a tool list stands: top-level `tools`, an `additional_tools`
    // or `tool_search_output` item's, a namespace's.
    if (seen.inArray && seen.key === "tools" && !clientTools.has(type ?? ABSENT)) {
      refuse(seen, `tool type ${JSON.stringify(type ?? null)} runs on the provider's side`);
    }
    if (opts.openRouter === true) {
      if (seen.inArray && seen.key === "messages" && MESSAGE.test(seen.path())) {
        for (const [member, allowed] of Object.entries(OPENROUTER_MESSAGE_LISTS)) {
          const kind = seen.members.get(member);
          if (kind !== undefined && !allowed.has(kind)) {
            refuse(seen, `${member} that is ${kindName(kind)}, not one ryph forwards`);
          }
          // A list holds parts and nothing else: a list in a list, or a bare string, is a part no
          // rule below would see.
          const others = [...(seen.elements.get(member) ?? [])].filter((k) => k !== "object");
          if (kind === "array" && others.length > 0) {
            refuse(seen, `${member} holding ${others.map(kindName).join(" and ")}, not only parts`);
          }
        }
        return;
      }
      if (
        seen.inArray && (seen.key === "content" || seen.key === "images") &&
        MESSAGE_PART.test(seen.path())
      ) {
        const shape = type !== undefined && Object.hasOwn(OPENROUTER_PARTS, type)
          ? OPENROUTER_PARTS[type]
          : undefined;
        if (shape === undefined) {
          refuse(
            seen,
            `a content part of type ${JSON.stringify(type ?? null)}, not one ryph forwards`,
          );
          return;
        }
        const wrong = misfit(seen.members, shape, `a part of type ${JSON.stringify(type)}`);
        if (wrong !== null) refuse(seen, wrong);
        if (type === "file") carriesFile = true;
        const inline = notInline(type!, seen.children.get(type!));
        if (inline !== null) refuse(seen, inline);
        return;
      }
      if (
        !seen.inArray && seen.key !== null && Object.hasOwn(OPENROUTER_PART_OBJECTS, seen.key) &&
        PART_OBJECT.test(seen.path())
      ) {
        const wrong = misfit(
          seen.members,
          OPENROUTER_PART_OBJECTS[seen.key],
          `a part's ${seen.key}`,
        );
        if (wrong !== null) refuse(seen, wrong);
        return;
      }
    }
    if (type === undefined) return;
    if (REFUSED_ITEM_TYPES.has(type)) {
      refuse(seen, `${type} references data stored with the provider`);
      return;
    }
    switch (type) {
      // Anthropic's mid-conversation tool change: the definition is a tool like any other.
      case "tool_definition": {
        const defined = seen.children.get("definition")?.get("type") ?? ABSENT;
        if (!clientTools.has(defined)) {
          refuse(seen, `tool type ${JSON.stringify(defined)} runs on the provider's side`);
        }
        return;
      }
      // Anthropic media: inline only.
      case "image":
      case "document": {
        const source = seen.children.get("source");
        const kind = source?.get("type");
        if (source !== undefined && (kind === undefined || !INLINE_SOURCES.has(kind))) {
          refuse(seen, `a ${type} source of type ${JSON.stringify(kind ?? null)}: send it inline`);
        }
        return;
      }
      // Responses media.
      case "input_image":
      case "computer_screenshot": {
        const url = seen.strings.get("image_url");
        if (url !== undefined && (url === NOT_A_STRING || !isDataUrl(url))) {
          refuse(seen, "an image by URL: send it as a data: URL");
        }
        if (seen.strings.has("file_id")) refuse(seen, "an image by file_id: send it inline");
        return;
      }
      case "input_file": {
        if (seen.strings.has("file_url")) refuse(seen, "a file by URL: send it as file_data");
        if (seen.strings.has("file_id")) refuse(seen, "a file by file_id: send it as file_data");
        return;
      }
      // Chat Completions media.
      case "image_url": {
        const child = seen.children.get("image_url")?.get("url");
        const url = child ?? seen.strings.get("image_url");
        if (url !== undefined && (url === NOT_A_STRING || !isDataUrl(url))) {
          refuse(seen, "an image by URL: send it as a data: URL");
        }
        return;
      }
      case "file": {
        carriesFile = true;
        const file = seen.children.get("file");
        if (file?.has("file_id")) refuse(seen, "a file by file_id: send it as file_data");
        return;
      }
    }
  });
  if (!ok) refused.push(`the body nests more than ${MAX_BODY_DEPTH} levels deep`);
  return { refused, carriesFile };
}
