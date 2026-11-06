// How the token form talks about capabilities: two presets most tokens fit, and the full list
// grouped by what each capability acts on, for the rest.

/** A capability that only lets its holder look: `tasks:read`, `tasks:read-all`, `usage:read-all`. */
export function isReadCapability(capability: string): boolean {
  const verb = capability.split(":")[1] ?? "";
  return verb === "read" || verb === "read-all";
}

export type AccessPreset = "read" | "all" | "custom";

/** The caps a preset grants, out of those the person may grant. Custom grants nothing by itself. */
export function presetCaps(preset: AccessPreset, grantable: readonly string[]): string[] {
  if (preset === "all") return [...grantable];
  if (preset === "read") return grantable.filter(isReadCapability);
  return [];
}

export type CapabilityGroup = {
  /** The part before the colon, as the catalogue spells it. */
  resource: string;
  label: string;
  caps: { capability: string; verb: string }[];
};

/** The caps grouped by resource, in catalogue order. */
export function groupCapabilities(caps: readonly string[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const capability of caps) {
    const [resource, verb = ""] = capability.split(":");
    let group = groups.get(resource);
    if (!group) {
      group = { resource, label: resource.charAt(0).toUpperCase() + resource.slice(1), caps: [] };
      groups.set(resource, group);
    }
    group.caps.push({ capability, verb });
  }
  return [...groups.values()];
}

/** What a minted token carries, in a word: read-only, or a count of everything it may do. */
export function describeTokenCaps(caps: readonly string[]): string {
  const count = `${caps.length} ${caps.length === 1 ? "capability" : "capabilities"}`;
  return caps.every(isReadCapability) ? `Read only, ${count}` : count;
}
