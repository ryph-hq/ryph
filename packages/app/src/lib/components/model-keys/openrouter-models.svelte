<script lang="ts">
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { invalidate } from "$app/navigation";
import { toast } from "svelte-sonner";
import {
  enableRefusal,
  getOpenRouterCatalogue,
  type OpenRouterCatalogue,
  setOpenRouterEnabled,
  syncOpenRouter,
} from "#lib/api/openrouter.ts";
import * as Alert from "#lib/components/ui/alert/index.ts";
import { Badge } from "#lib/components/ui/badge/index.ts";
import { TONES } from "#lib/components/ui/badge/tones.ts";
import { Button } from "#lib/components/ui/button/index.ts";
import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
import * as InputGroup from "#lib/components/ui/input-group/index.ts";
import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
import { Spinner } from "#lib/components/ui/spinner/index.ts";
import * as ToggleGroup from "#lib/components/ui/toggle-group/index.ts";
import { PRICE_HINT } from "#lib/components/model-picker/models.ts";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import SearchIcon from "@lucide/svelte/icons/search";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import {
  changeCount,
  enabledIds,
  formatContext,
  formatModelPrice,
  idsToSave,
  type ModelFilter,
  offeredModels,
  PAGE_SIZE,
  refusalLines,
  syncLine,
  visibleModels,
} from "./openrouter-models.ts";

/** How often the list is read again while a sync runs. */
const SYNC_POLL_MS = 3_000;

let catalogue = $state.raw<OpenRouterCatalogue | null>(null);
let loadError = $state<string | null>(null);

/** The models ticked, saved or not. Saving sends it; the saved set is `saved`. */
const draft = new SvelteSet<string>();
const saved = $derived(catalogue === null ? new Set<string>() : enabledIds(catalogue.models));
const changes = $derived(changeCount(draft, saved));

let query = $state("");
let filter = $state<ModelFilter>("all");
let limit = $state(PAGE_SIZE);

const offered = $derived(catalogue === null ? [] : offeredModels(catalogue.models));
const rows = $derived(
  catalogue === null ? [] : visibleModels(catalogue.models, { query, filter, saved, draft }),
);
const shown = $derived(rows.slice(0, limit));

let saving = $state(false);
let syncing = $state(false);
/** Why the last save was refused, one line per kind of problem. */
let refusal = $state<string[] | null>(null);

const status = $derived(catalogue === null ? null : syncLine(catalogue.sync));

/** Takes a fresh catalogue. The choice follows it unless there are unsaved changes to keep. */
function apply(next: OpenRouterCatalogue, resetChoice: boolean) {
  catalogue = next;
  if (!resetChoice) return;
  draft.clear();
  for (const id of enabledIds(next.models)) draft.add(id);
}

async function load() {
  try {
    apply(await getOpenRouterCatalogue(fetch), changes === 0);
    loadError = null;
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Couldn't read OpenRouter's models";
  }
}

onMount(() => {
  void load();
});

// Opening the page can start a sync in the background: read again until it is done.
$effect(() => {
  if (!catalogue?.sync.syncing) return;
  const timer = setTimeout(load, SYNC_POLL_MS);
  return () => clearTimeout(timer);
});

function toggle(id: string, on: boolean) {
  if (on) draft.add(id);
  else draft.delete(id);
  refusal = null;
}

function discard() {
  draft.clear();
  for (const id of saved) draft.add(id);
  refusal = null;
}

async function save() {
  if (catalogue === null) return;
  const models = catalogue.models;
  saving = true;
  refusal = null;
  try {
    apply(await setOpenRouterEnabled(fetch, idsToSave(draft, models)), true);
    toast.success("Saved the models agents can use");
    // The pickers on this page read the enabled models through the provider list.
    await invalidate("app:model-keys");
  } catch (e) {
    const refused = enableRefusal(e);
    if (refused) refusal = refusalLines(refused, models);
    else toast.error(e instanceof Error ? e.message : "Couldn't save the models");
  } finally {
    saving = false;
  }
}

async function syncNow() {
  syncing = true;
  try {
    const { catalogue: next, error } = await syncOpenRouter(fetch);
    apply(next, changes === 0);
    if (error) toast.error(error);
    else {
      const listed = next.models.filter((m) => m.listed).length;
      toast.success(`Synced ${listed} models`);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't sync OpenRouter's models");
  } finally {
    syncing = false;
  }
}
</script>

<section class="flex flex-col gap-3" aria-labelledby="openrouter-models-title">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="flex flex-col gap-1">
      <h2 id="openrouter-models-title" class="text-base font-medium">OpenRouter models</h2>
      <p class="text-muted-foreground text-sm">Pick which OpenRouter models agents can use.</p>
    </div>
    <div class="flex min-w-0 items-center gap-3">
      {#if status}
        <span
          class={[
            "max-w-72 truncate text-xs",
            status.failed ? "text-destructive" : "text-muted-foreground",
          ]}
          title={status.text}
          aria-live="polite"
        >
          {status.text}
        </span>
      {/if}
      <Button
        variant="outline"
        size="sm"
        disabled={syncing || catalogue === null || catalogue.sync.syncing}
        onclick={syncNow}
      >
        {#if syncing || catalogue?.sync.syncing}
          <Spinner data-icon="inline-start" />
        {:else}
          <RefreshCwIcon data-icon="inline-start" />
        {/if}
        Sync now
      </Button>
    </div>
  </div>

  {#if loadError !== null && catalogue === null}
    <Alert.Root variant="destructive">
      <CircleAlertIcon />
      <Alert.Title>Couldn't read OpenRouter's models</Alert.Title>
      <Alert.Description>
        <span>
          {loadError}.
          <button type="button" class="underline underline-offset-4" onclick={load}>
            Try again
          </button>
        </span>
      </Alert.Description>
    </Alert.Root>
  {:else if catalogue === null}
    <div class="flex flex-col gap-2 rounded-lg border p-3" aria-busy="true">
      {#each [0, 1, 2, 3] as row (row)}
        <Skeleton class="h-9 w-full" />
      {/each}
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <InputGroup.Root class="w-full sm:w-72" role="search">
        <InputGroup.Addon>
          <SearchIcon />
        </InputGroup.Addon>
        <InputGroup.Input
          type="search"
          placeholder="Search models"
          aria-label="Search OpenRouter models"
          bind:value={query}
          oninput={() => (limit = PAGE_SIZE)}
        />
      </InputGroup.Root>
      <ToggleGroup.Root
        type="single"
        variant="outline"
        size="sm"
        aria-label="Which models to show"
        value={filter}
        onValueChange={(value: string) => {
          // A second click on the pressed item would clear it; keep a filter chosen.
          if (value === "all" || value === "enabled") filter = value;
          limit = PAGE_SIZE;
        }}
      >
        <ToggleGroup.Item value="all">All</ToggleGroup.Item>
        <ToggleGroup.Item value="enabled">Enabled</ToggleGroup.Item>
      </ToggleGroup.Root>
      <span class="text-muted-foreground text-xs tabular-nums">
        {draft.size} of {offered.length} enabled
      </span>
    </div>

    {#if refusal}
      <Alert.Root variant="destructive">
        <CircleAlertIcon />
        <Alert.Title>Some models can't be enabled</Alert.Title>
        <Alert.Description>
          <ul class="flex flex-col gap-1">
            {#each refusal as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if rows.length === 0}
      <p class="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
        {#if offered.length === 0}
          No models yet. Sync to fetch OpenRouter's list.
        {:else if filter === "enabled" && query.trim() === ""}
          No models enabled yet.
        {:else}
          No models match "{query.trim()}".
        {/if}
      </p>
    {:else}
      <ul class="divide-y rounded-lg border text-sm" aria-label="OpenRouter models">
        {#each shown as model (model.id)}
          {@const checked = draft.has(model.id)}
          {@const price = formatModelPrice(model.price)}
          {@const inputId = `openrouter-model-${model.id}`}
          <li
            class={[
              "has-[button:focus-visible]:bg-muted/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5",
              checked && "bg-muted/30",
            ]}
          >
            <Checkbox
              id={inputId}
              {checked}
              disabled={!model.listed && !checked}
              onCheckedChange={(on) => toggle(model.id, on === true)}
            />
            <label for={inputId} class="flex min-w-0 flex-1 cursor-pointer flex-col">
              <span class="truncate font-medium" title={model.label}>{model.label}</span>
              <span class="text-muted-foreground truncate font-mono text-xs" title={model.id}>
                {model.id}
              </span>
            </label>
            <div class="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
              {#if !model.listed}
                <Badge variant="destructive">No longer listed</Badge>
              {/if}
              {#if model.vision}
                <Badge variant="outline">Vision</Badge>
              {/if}
              {#if model.reasoning}
                <Badge variant="outline">Reasoning</Badge>
              {/if}
              <span
                class="text-muted-foreground w-14 text-right text-xs tabular-nums"
                title="Context window, in tokens"
              >
                {formatContext(model.contextLength)}
              </span>
              {#if price === null}
                <span class="flex w-28 justify-end">
                  <Badge class={TONES.warning} title="Runs with a spend cap can't use this model.">
                    <TriangleAlertIcon data-icon="inline-start" />
                    No price
                  </Badge>
                </span>
              {:else}
                <span class="w-28 text-right text-xs tabular-nums" title={PRICE_HINT}>{price}</span>
              {/if}
            </div>
            {#if !model.listed}
              <p class="text-muted-foreground w-full pl-7 text-xs">
                Agents can't use it. Saving turns it off.
              </p>
            {/if}
          </li>
        {/each}
      </ul>
      {#if rows.length > shown.length}
        <Button
          variant="ghost"
          size="sm"
          class="self-center"
          onclick={() => (limit += PAGE_SIZE)}
        >
          Show {Math.min(PAGE_SIZE, rows.length - shown.length)} more of {rows.length - shown.length}
        </Button>
      {/if}
    {/if}

    {#if changes > 0}
      <!-- Stays in view while the list scrolls, so the choice can be saved from anywhere in it. -->
      <div
        class="bg-background sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 shadow-sm"
      >
        <span class="text-sm">
          {changes}
          {changes === 1 ? "unsaved change" : "unsaved changes"}
        </span>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onclick={discard}>Discard</Button>
          <Button size="sm" disabled={saving} onclick={save}>
            {#if saving}
              <Spinner data-icon="inline-start" />
            {/if}
            Save
          </Button>
        </div>
      </div>
    {/if}
  {/if}
</section>
