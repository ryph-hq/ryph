import { describe, expect, it } from "vitest";
import type { Provider, ProviderKey } from "#lib/api/types.ts";
import {
  composeModelPolicy,
  defaultModelThinkingLevels,
  editedDefaultThinking,
  editedModelPolicyCheck,
  modelPolicyProblem,
  openRouterChoices,
  policyToFields,
  sameModelPolicy,
  storedModelsWarning,
  usableProviderKeys,
} from "./model-policy";

const KEY: ProviderKey = {
  id: "key-1",
  provider: "anthropic",
  label: "Team",
  last4: "abcd",
  archivedAt: null,
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

describe("composeModelPolicy", () => {
  it("is null without a key, and carries the key's provider with one", () => {
    expect(composeModelPolicy("", "*", "", [KEY])).toBeNull();
    expect(composeModelPolicy("key-1", ["claude-sonnet-5", " "], " claude-sonnet-5 ", [KEY]))
      .toEqual({
        providerKeyId: "key-1",
        provider: "anthropic",
        allowedModels: ["claude-sonnet-5"],
        defaultModel: "claude-sonnet-5",
        defaultThinking: null,
      });
    expect(composeModelPolicy("key-1", "*", "", [KEY], "high")?.defaultThinking).toBe("high");
  });

  it("sends each id once", () => {
    expect(composeModelPolicy("key-1", ["a", "a ", "b"], "", [KEY])?.allowedModels).toEqual([
      "a",
      "b",
    ]);
  });

  it("round-trips through policyToFields", () => {
    const policy = composeModelPolicy("key-1", ["a", "b"], "", [KEY]);
    const fields = policyToFields(policy);
    expect(fields).toEqual({
      providerKeyId: "key-1",
      allowedModels: ["a", "b"],
      defaultModel: "",
      defaultThinking: null,
    });
  });

  it("carries the thinking default both ways, so an edit does not clear it", () => {
    const policy = composeModelPolicy("key-1", "*", "a", [KEY], "xhigh");
    const fields = policyToFields(policy);
    expect(fields.defaultThinking).toBe("xhigh");
    expect(
      composeModelPolicy(
        fields.providerKeyId,
        fields.allowedModels,
        fields.defaultModel,
        [KEY],
        fields.defaultThinking,
      ),
    ).toEqual(policy);
    expect(policyToFields(null).defaultThinking).toBeNull();
  });
});

describe("modelPolicyProblem", () => {
  it("wants a non-empty list, with the default inside it", () => {
    expect(modelPolicyProblem("", [], "")).toBeNull();
    expect(modelPolicyProblem("key-1", "*", "anything")).toBeNull();
    expect(modelPolicyProblem("key-1", [], "")).toMatch(/at least one/);
    expect(modelPolicyProblem("key-1", ["a"], "b")).toMatch(/default/);
    expect(modelPolicyProblem("key-1", ["a"], "a")).toBeNull();
    expect(modelPolicyProblem("key-1", ["a"], "")).toBeNull();
    expect(modelPolicyProblem("key-1", [" "], "")).toMatch(/at least one/);
    expect(modelPolicyProblem("key-1", [" a "], "a")).toBeNull();
  });
});

describe("usableProviderKeys", () => {
  const key = (id: string, provider: string, extra: Partial<ProviderKey> = {}): ProviderKey => ({
    id,
    provider,
    label: id,
    last4: "abcd",
    archivedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    ...extra,
  });
  const provider = (id: string, dialect: string, archivedAt: string | null = null): Provider => ({
    id,
    label: id,
    dialect,
    builtin: false,
    baseUrl: "https://example.test/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    models: [],
    archivedAt,
  });
  const plan = {
    email: null,
    planType: null,
    status: "active" as const,
    limitedAt: null,
    models: [],
  };
  const providers = [
    provider("anthropic", "anthropic-messages"),
    provider("groq", "openai-completions"),
    provider("old", "openai-completions", "2026-01-01T00:00:00Z"),
  ];
  const keys = [
    key("a", "anthropic"),
    key("g", "groq"),
    key("o", "old"),
    key("x", "anthropic", { archivedAt: "2026-01-01T00:00:00Z" }),
    key("u", "unlisted"),
    key("p", "chatgpt-plan", { plan }),
  ];

  it("keeps live keys the harness can drive, and ones whose provider did not answer", () => {
    const usable = usableProviderKeys(keys, providers, { dialects: ["anthropic-messages"] });
    expect(usable.map((k) => k.id)).toEqual(["a", "u"]);
  });

  it("offers every live key on a live provider without a harness", () => {
    expect(usableProviderKeys(keys, providers, undefined).map((k) => k.id)).toEqual([
      "a",
      "g",
      "u",
    ]);
  });
});

describe("defaultModelThinkingLevels", () => {
  const providers = [{
    id: "anthropic",
    builtin: true,
    models: [{ id: "big", thinkingLevels: ["off", "low", "high"] }, { id: "plain" }],
  }, {
    id: "groq",
    builtin: false,
    models: [{ id: "thinks", reasoning: true }, { id: "plain" }],
  }] as unknown as Provider[];
  const CUSTOM_KEY: ProviderKey = { ...KEY, id: "key-2", provider: "groq" };

  it("reads the default model's levels off the key's provider", () => {
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "big")).toEqual([
      "off",
      "low",
      "high",
    ]);
  });

  it("offers every level for no default, an undeclared model or no key", () => {
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "")).toHaveLength(7);
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "plain")).toHaveLength(7);
    expect(defaultModelThinkingLevels(providers, [KEY], "", "big")).toHaveLength(7);
  });

  it("offers what pi gives a custom endpoint's model with no levels named", () => {
    const keys = [KEY, CUSTOM_KEY];
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "thinks")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "plain")).toEqual(["off"]);
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "typed")).toEqual(["off"]);
  });

  it("reads the stored policy's provider for a key the list cannot resolve", () => {
    const stored = {
      providerKeyId: "key-2",
      provider: "groq",
      allowedModels: "*" as const,
      defaultModel: "plain",
      defaultThinking: null,
    };
    expect(defaultModelThinkingLevels(providers, [], "key-2", "plain", stored)).toEqual(["off"]);
    // Only for the key the policy names: another one is not known, and stays open.
    expect(defaultModelThinkingLevels(providers, [], "key-3", "plain", stored)).toHaveLength(7);
  });
});

describe("editedDefaultThinking", () => {
  const seeded = { providerKeyId: "key-1", defaultModel: "plain" };

  it("keeps the stored level while the key and default model are as loaded", () => {
    // The model now takes only off, so the pick is hidden: saving must not clear it.
    expect(editedDefaultThinking(seeded, "key-1", "plain", "high", ["off"])).toBe("high");
    expect(editedDefaultThinking(seeded, "key-1", " plain ", "high", ["off"])).toBe("high");
    expect(editedDefaultThinking(seeded, "key-1", "plain", "low", ["off", "low"])).toBe("low");
  });

  it("drops it once the person moves to a model that takes no level", () => {
    expect(editedDefaultThinking(seeded, "key-1", "other", "high", ["off"])).toBeNull();
    expect(editedDefaultThinking(seeded, "key-2", "plain", "high", ["off"])).toBeNull();
    expect(editedDefaultThinking(seeded, "key-1", "other", "high", ["off", "high"])).toBe("high");
  });
});

describe("OpenRouter model fields", () => {
  const OR_KEY: ProviderKey = { ...KEY, id: "or-1", provider: "openrouter" };
  const openrouter = (ids: string[]): Provider => ({
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai-completions",
    builtin: true,
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    models: ids.map((id) => ({ id })),
    archivedAt: null,
  });

  it("reads the enabled models for an OpenRouter key only", () => {
    const providers = [openrouter(["a/x", "b/y"])];
    expect(openRouterChoices(providers, [KEY, OR_KEY], "key-1")).toBeNull();
    expect(openRouterChoices(providers, [KEY, OR_KEY], "")).toBeNull();
    expect(openRouterChoices(providers, [KEY, OR_KEY], "or-1")).toEqual({
      enabled: ["a/x", "b/y"],
    });
    // The list came back without OpenRouter: the models are not known.
    expect(openRouterChoices([], [OR_KEY], "or-1")).toEqual({ enabled: null });
  });

  it("goes by the stored policy for a key the list cannot resolve", () => {
    const stored = {
      providerKeyId: "or-1",
      provider: "openrouter",
      allowedModels: "*" as const,
      defaultModel: "a/x",
      defaultThinking: null,
    };
    expect(openRouterChoices([openrouter(["a/x"])], [], "or-1", stored)).toEqual({
      enabled: ["a/x"],
    });
  });

  it("needs an enabled model, and a default picked from them", () => {
    const choices = { enabled: ["a/x", "b/y"] };
    expect(modelPolicyProblem("or-1", "*", "", { enabled: [] })).toMatch(/Enable an OpenRouter/);
    expect(modelPolicyProblem("or-1", "*", "", choices)).toBe("Pick a default model.");
    expect(modelPolicyProblem("or-1", "*", " ", choices)).toBe("Pick a default model.");
    expect(modelPolicyProblem("or-1", "*", "c/z", choices)).toMatch(/enabled OpenRouter/);
    expect(modelPolicyProblem("or-1", "*", "a/x", choices)).toBeNull();
    expect(modelPolicyProblem("or-1", ["a/x"], "a/x", choices)).toBeNull();
    expect(modelPolicyProblem("or-1", ["a/x"], "b/y", choices)).toMatch(/allowed models/);
    expect(modelPolicyProblem("or-1", [], "", choices)).toMatch(/at least one/);
  });

  it("still needs a default when the enabled models are not known", () => {
    expect(modelPolicyProblem("or-1", "*", "", { enabled: null })).toBe("Pick a default model.");
    expect(modelPolicyProblem("or-1", "*", "c/z", { enabled: null })).toBeNull();
  });

  describe("on an agent being edited", () => {
    const stored = {
      providerKeyId: "or-1",
      provider: "openrouter",
      allowedModels: ["a/x", "b/y"],
      defaultModel: "a/x",
      defaultThinking: null,
    };
    const fields = policyToFields(stored);
    const compose = (over: Partial<typeof fields> = {}) => {
      const f = { ...fields, ...over };
      return composeModelPolicy(f.providerKeyId, f.allowedModels, f.defaultModel, [OR_KEY]);
    };
    // An admin has since disabled the default.
    const now = { enabled: ["b/y"] };

    it("compares policies as the server does", () => {
      expect(sameModelPolicy(compose(), stored)).toBe(true);
      expect(sameModelPolicy({ ...stored, allowedModels: ["b/y", "a/x"] }, stored)).toBe(true);
      expect(
        sameModelPolicy({ ...stored, defaultThinking: undefined } as never, stored),
      ).toBe(true);
      expect(sameModelPolicy({ ...stored, defaultThinking: "high" }, stored)).toBe(false);
      expect(sameModelPolicy({ ...stored, allowedModels: "*" }, stored)).toBe(false);
      expect(sameModelPolicy(null, stored)).toBe(false);
      expect(sameModelPolicy(null, null)).toBe(true);
    });

    it("saves an unchanged policy whose default was disabled, with a warning", () => {
      expect(editedModelPolicyCheck(stored, compose(), fields, now)).toEqual({
        problem: null,
        warning: "This agent's model a/x isn't enabled any more.",
      });
    });

    it("warns about a disabled allowlisted model too", () => {
      expect(editedModelPolicyCheck(stored, compose(), fields, { enabled: ["a/x"] })).toEqual({
        problem: null,
        warning: "This agent's model b/y isn't enabled any more.",
      });
    });

    it("warns about nothing while every model is still enabled or the models aren't known", () => {
      const fine = { problem: null, warning: null };
      expect(editedModelPolicyCheck(stored, compose(), fields, { enabled: ["a/x", "b/y"] }))
        .toEqual(fine);
      expect(editedModelPolicyCheck(stored, compose(), fields, { enabled: null })).toEqual(fine);
    });

    it("holds a moved policy to the OpenRouter rules", () => {
      const moved = { ...fields, allowedModels: ["a/x"] };
      expect(editedModelPolicyCheck(stored, compose(moved), moved, now)).toEqual({
        problem: "Pick one of the enabled OpenRouter models as the default.",
        warning: null,
      });
      const fixed = { ...fields, defaultModel: "b/y" };
      expect(editedModelPolicyCheck(stored, compose(fixed), fixed, now)).toEqual({
        problem: null,
        warning: null,
      });
    });

    it("holds a new policy to the rules", () => {
      const fresh = { providerKeyId: "or-1", allowedModels: "*" as const, defaultModel: "" };
      const composed = composeModelPolicy("or-1", "*", "", [OR_KEY]);
      expect(editedModelPolicyCheck(null, composed, fresh, now).problem)
        .toBe("Pick a default model.");
    });
  });
});

describe("storedModelsWarning", () => {
  const stored = {
    providerKeyId: "or-1",
    provider: "openrouter",
    allowedModels: ["a/x", "b/y", "c/z"],
    defaultModel: "a/x",
    defaultThinking: null,
  };

  it("names every model the policy names that isn't enabled, the default first and each once", () => {
    expect(storedModelsWarning(stored, ["b/y"])).toBe(
      "Some of this agent's models aren't enabled any more: a/x, c/z.",
    );
    expect(storedModelsWarning(stored, [])).toBe(
      "Some of this agent's models aren't enabled any more: a/x, b/y, c/z.",
    );
  });

  it("names a single model on its own", () => {
    expect(storedModelsWarning(stored, ["a/x", "b/y"])).toBe(
      "This agent's model c/z isn't enabled any more.",
    );
  });

  it("checks only the default when every model is allowed", () => {
    const open = { ...stored, allowedModels: "*" as const };
    expect(storedModelsWarning(open, ["a/x"])).toBeNull();
    expect(storedModelsWarning(open, ["b/y"])).toBe(
      "This agent's model a/x isn't enabled any more.",
    );
  });

  it("flags a missing default, and says nothing while the enabled list is unknown", () => {
    expect(storedModelsWarning({ ...stored, defaultModel: null }, ["a/x", "b/y", "c/z"])).toBe(
      "This agent has no default model.",
    );
    expect(storedModelsWarning(stored, null)).toBeNull();
    expect(storedModelsWarning(stored, ["a/x", "b/y", "c/z"])).toBeNull();
  });
});
