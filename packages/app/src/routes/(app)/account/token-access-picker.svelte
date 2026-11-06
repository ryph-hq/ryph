<script lang="ts">
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Field from "$lib/components/ui/field";
import { Label } from "$lib/components/ui/label";
import { Toggle } from "$lib/components/ui/toggle";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { untrack } from "svelte";
import { type AccessPreset, groupCapabilities, presetCaps } from "./token-access";

let {
  grantable,
  caps = $bindable(),
}: {
  /** What the signed-in person may put on a token. */
  grantable: readonly string[];
  caps: string[];
} = $props();

// Read only is the default: most tokens are for scripts that look, and it is the safe guess.
// The form remounts this each time it opens, so seeding from the first grantable list is enough.
let preset = $state<AccessPreset>("read");
caps = presetCaps("read", untrack(() => grantable));

const groups = $derived(groupCapabilities(grantable));
const selected = $derived(new Set(caps));

const presets: { value: AccessPreset; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "all", label: "Everything" },
  { value: "custom", label: "Custom" },
];

function choosePreset(value: string) {
  // A single toggle group hands back "" when the pressed item is clicked again; keep the choice.
  if (!value) return;
  preset = value as AccessPreset;
  // Custom starts from whatever the last preset picked, so it is a tweak rather than a blank page.
  if (preset !== "custom") caps = presetCaps(preset, grantable);
}

function setCap(capability: string, on: boolean) {
  caps = on ? [...caps, capability] : caps.filter((c) => c !== capability);
}

function setGroup(groupCaps: readonly string[], on: boolean) {
  const rest = caps.filter((c) => !groupCaps.includes(c));
  caps = on ? [...rest, ...groupCaps] : rest;
}
</script>

<Field.Field>
  <Field.FieldLabel id="token-access-label">Access</Field.FieldLabel>
  <ToggleGroup.Root
    type="single"
    variant="outline"
    value={preset}
    onValueChange={choosePreset}
    aria-labelledby="token-access-label"
    class="w-full"
  >
    {#each presets as option (option.value)}
      <ToggleGroup.Item value={option.value} class="flex-1">{option.label}</ToggleGroup.Item>
    {/each}
  </ToggleGroup.Root>
  <Field.FieldDescription>
    {#if preset === "read"}
      Sees everything you can see. Changes nothing.
    {:else if preset === "all"}
      Does everything you can, apart from managing members, instance settings and tokens.
    {:else}
      {caps.length} of {grantable.length} selected.
    {/if}
  </Field.FieldDescription>
</Field.Field>

{#if preset === "custom"}
  <div
    class="scroll-fade-y -mt-2 flex max-h-72 flex-col overflow-y-auto overscroll-contain rounded-lg border"
  >
    {#each groups as group (group.resource)}
      {@const groupCaps = group.caps.map((c) => c.capability)}
      {@const count = groupCaps.filter((c) => selected.has(c)).length}
      <div class="flex items-start gap-3 border-b px-3 py-2 last:border-b-0">
        <div class="flex w-26 shrink-0 items-center gap-2 pt-1.5">
          <Checkbox
            id="cap-group-{group.resource}"
            checked={count === groupCaps.length}
            indeterminate={count > 0 && count < groupCaps.length}
            onCheckedChange={(on) => setGroup(groupCaps, on === true)}
          />
          <Label for="cap-group-{group.resource}">{group.label}</Label>
        </div>
        <div class="flex flex-wrap gap-1">
          {#each group.caps as { capability, verb } (capability)}
            <Toggle
              size="sm"
              variant="outline"
              class="aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:border-primary h-7 min-w-0 px-1.5 font-mono text-xs"
              aria-label={capability}
              title={capability}
              pressed={selected.has(capability)}
              onPressedChange={(on) => setCap(capability, on)}
            >
              {verb}
            </Toggle>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}
