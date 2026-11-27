<script lang="ts">
import { invalidate } from "$app/navigation";
import { toast } from "svelte-sonner";
import {
  enableRefusal,
  type OpenRouterModel,
  type OpenRouterSync,
  setOpenRouterEnabled,
  syncOpenRouter,
  syncShrunk,
} from "#lib/api/openrouter.ts";
import * as Alert from "#lib/components/ui/alert/index.ts";
import { Badge } from "#lib/components/ui/badge/index.ts";
import { TONES } from "#lib/components/ui/badge/tones.ts";
import { Button } from "#lib/components/ui/button/index.ts";
import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
import * as Dialog from "#lib/components/ui/dialog/index.ts";
import * as InputGroup from "#lib/components/ui/input-group/index.ts";
import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
import { Spinner } from "#lib/components/ui/spinner/index.ts";
import * as ToggleGroup from "#lib/components/ui/toggle-group/index.ts";
import * as Tooltip from "#lib/components/ui/tooltip/index.ts";
import { PRICE_HINT } from "#lib/components/model-picker/models.ts";
import { liveClock } from "#lib/utils/live-clock.svelte.ts";
import { refreshWhileLive } from "#lib/utils/live-refresh.svelte.ts";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import SearchIcon from "@lucide/svelte/icons/search";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import {
  type CatalogueRead,
  changeCount,
  draftInCatalogue,
  enabledIds,
  formatContext,
  formatModelPrice,
  idsToSave,
  type ModelFilter,
  offeredModels,
  openRouterErrorText,
  PAGE_SIZE,
  refusalLines,
  syncLine,
  visibleModels,
} from "./openrouter-models.ts";

let {
  read,
  dependency,
  description = "Pick which OpenRouter models agents can use.",
  placement = "inline",
  doneLabel = "Done",
  ondone,
}: {
  /** The catalogue as the page's load read it. */
  read: CatalogueRead;
  /** The load's `depends` key: invalidated to read the catalogue again. */
  dependency: string;
  description?: string;
  /**
   * Where the picker sits. `inline` is a page section with a save bar that sticks while the page
   * scrolls; `dialog` fills a `Dialog.Content`: its own header, a list that scrolls inside it, and
   * the save bar as the footer.
   */
  placement?: "inline" | "dialog";
  /** The dialog footer's action while nothing is unsaved: "Done", "Skip for now". */
  doneLabel?: string;
  /** In a dialog: the footer's done action, and a save that worked. */
  ondone?: () => void;
} = $props();

const catalogue = $derived(read.catalogue);

/** The ids enabled as saved. */
const saved = $derived(catalogue === null ? new Set<string>() : enabledIds(catalogue.models));
/**
 * The unsaved choice, or null while there is none and the ticks follow what is saved. It lives
 * here, apart from the load's data, so a refresh of the catalogue keeps it.
 */
let edits = $state.raw<ReadonlySet<string> | null>(null);
const choice = $derived(
  edits === null || catalogue === null ? saved : draftInCatalogue(edits, catalogue.models),
);
const changes = $derived(changeCount(choice, saved));

let query = $state("");
let filter = $state<ModelFilter>("all");
let limit = $state(PAGE_SIZE);

const offered = $derived(catalogue === null ? [] : offeredModels(catalogue.models));
const rows = $derived(
  catalogue === null
    ? []
    : visibleModels(catalogue.models, { query, filter, saved, draft: choice }),
);
const shown = $derived(rows.slice(0, limit));

let saving = $state(false);
let syncing = $state(false);
let retrying = $state(false);
/** Why the last save was refused, one line per kind of problem. */
let refusal = $state<string[] | null>(null);

/**
 * The last sync this page ran, for its failure's code: a server that predates the code on the
 * catalogue still sends it on the sync's 502. It applies only while that attempt is the last.
 */
let ranSync = $state.raw<OpenRouterSync | null>(null);
const sync = $derived.by(() => {
  const current = catalogue?.sync;
  if (!current) return null;
  if (
    current.errorCode === null && ranSync !== null &&
    ranSync.attemptedAt === current.attemptedAt
  ) {
    return { ...current, errorCode: ranSync.errorCode };
  }
  return current;
});
const busy = $derived(syncing || sync?.syncing === true);
const failure = $derived(sync !== null && !busy ? sync.error : null);
const forceable = $derived(sync !== null && !busy && syncShrunk(sync));

// Opening the page can start a sync in the background: read again until it is done. The key is
// the page's own and never changes.
// svelte-ignore state_referenced_locally
refreshWhileLive(dependency, () => catalogue?.sync.syncing === true);
const clock = liveClock(() => sync !== null && !busy && sync.syncedAt !== null);
const status = $derived(sync === null ? null : syncLine(sync, clock.now));

/** Whether there are ticks not yet saved: a dialog asks before closing over them. */
export function hasChanges(): boolean {
  return changes > 0;
}

function toggle(id: string, on: boolean) {
  const next = new Set(choice);
  if (on) next.add(id);
  else next.delete(id);
  edits = changeCount(next, saved) === 0 ? null : next;
  refusal = null;
}

function discard() {
  edits = null;
  refusal = null;
}

async function save() {
  if (catalogue === null) return;
  const models = catalogue.models;
  saving = true;
  refusal = null;
  try {
    await setOpenRouterEnabled(fetch, idsToSave(choice, models));
    // The ticks follow the saved set once the page holds it, so they never show the old one.
    await invalidate(dependency);
    edits = null;
    toast.success("Models saved");
    ondone?.();
  } catch (e) {
    const refused = enableRefusal(e);
    if (refused) refusal = refusalLines(refused, models);
    else toast.error(openRouterErrorText(e, "Couldn't save the models"));
  } finally {
    saving = false;
  }
}

async function syncNow(force = false) {
  syncing = true;
  try {
    const { catalogue: next, failed } = await syncOpenRouter(fetch, { force });
    ranSync = next.sync;
    await invalidate(dependency);
    // A failure shows in full under the header.
    if (!failed) toast.success(`Synced ${next.models.filter((m) => m.listed).length} models`);
  } catch (e) {
    toast.error(openRouterErrorText(e, "Couldn't sync OpenRouter's models"));
  } finally {
    syncing = false;
  }
}

async function retry() {
  retrying = true;
  try {
    await invalidate(dependency);
  } finally {
    retrying = false;
  }
}

/** Enter in the search must not submit a form the list sits in. */
function holdEnter(event: KeyboardEvent) {
  if (event.key === "Enter") event.preventDefault();
}
</script>


{#snippet syncControls()}
  <div class="flex min-w-0 items-center gap-3">
    {#if status}
      <span class="text-muted-foreground max-w-72 truncate text-xs" aria-live="polite">
        {status}
      </span>
    {/if}
    <Button
      variant="outline"
      size="sm"
      disabled={busy || catalogue === null}
      onclick={() => syncNow()}
    >
      {#if busy}
        <Spinner data-icon="inline-start" />
      {:else}
        <RefreshCwIcon data-icon="inline-start" />
      {/if}
      Sync now
    </Button>
  </div>
{/snippet}

{#snippet syncFailure()}
  {#if failure !== null}
    <Alert.Root variant="destructive">
  <CircleAlertIcon />
  <Alert.Title>Sync failed</Alert.Title>
  <Alert.Description class="flex flex-col items-start gap-2">
        <span>{failure}</span>
        {#if forceable}
          <Button variant="outline" size="sm" onclick={() => syncNow(true)}>
            Use this list anyway
          </Button>
        {/if}
      </Alert.Description>
</Alert.Root>
  {/if}
{/snippet}

{#snippet unread()}
  {#if read.error !== null}
    <Alert.Root variant="destructive">
  <CircleAlertIcon />
  <Alert.Title>Couldn't load OpenRouter's models</Alert.Title>
  <Alert.Description class="flex flex-col items-start gap-2">
    <span>{read.error}</span>
    <Button variant="outline" size="sm" disabled={retrying} onclick={retry}>
          {#if retrying}
            <Spinner data-icon="inline-start" />
          {/if}
          Try again
        </Button>
  </Alert.Description>
</Alert.Root>
  {:else}
    <div class="flex flex-col gap-2 rounded-lg border p-3" aria-busy="true">
      {#each [0, 1, 2, 3] as row (row)}
        <Skeleton class="h-9 w-full" />
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet filters()}
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
    onkeydown={holdEnter}
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
{/snippet}

{#snippet selectedCount()}
  <span class="text-muted-foreground text-xs tabular-nums">
    {choice.size} of {offered.length} selected
  </span>
{/snippet}

{#snippet refused()}
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
{/snippet}

{#snippet list(listClass: string)}
  {#if rows.length === 0}
    <p class="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
      {#if offered.length === 0 && busy}
        Syncing OpenRouter's models…
      {:else if offered.length === 0}
        No models yet. Sync to load them.
      {:else if filter === "enabled" && query.trim() === ""}
        No models enabled yet.
      {:else}
        No models match "{query.trim()}".
      {/if}
    </p>
  {:else}
    <!-- Its own provider: the list also sits in flows outside the app's sidebar, which holds one. -->
    <Tooltip.Provider>
  <ul class={["divide-y text-sm", listClass]} aria-label="OpenRouter models">
        {#each shown as model (model.id)}
          {@render row(model)}
        {/each}
      </ul>
</Tooltip.Provider>
    {#if rows.length > shown.length}
      <Button
  variant="ghost"
  size="sm"
  class="self-center"
  onclick={() => (limit += PAGE_SIZE)}
>
        Show {Math.min(PAGE_SIZE, rows.length - shown.length)} more
      </Button>
    {/if}
  {/if}
{/snippet}

{#snippet row(model: OpenRouterModel)}
    {@const checked = choice.has(model.id)}
    {@const price = formatModelPrice(model.price)}
    {@const inputId = `openrouter-model-${model.id}`}
    {@const noteId = `openrouter-model-note-${model.id}`}
    {@const usable = model.listed && model.tools}
    <li
  class={[
        "has-[button:focus-visible]:bg-muted/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5",
        checked && "bg-muted/30",
      ]}
>
      <Checkbox
        id={inputId}
        {checked}
        disabled={saving || (!usable && !checked)}
        aria-describedby={usable ? undefined : noteId}
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
        {:else if !model.tools}
          <Badge variant="destructive">Can't use tools</Badge>
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
          <span class="sr-only">tokens of context</span>
        </span>
        {#if price === null}
          <span class="flex w-28 justify-end">
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <span {...props} class="rounded-md">
                    <Badge class={TONES.warning}>
                      <TriangleAlertIcon data-icon="inline-start" />
                      No price
                    </Badge>
                  </span>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Not usable in runs with a spend cap</Tooltip.Content>
            </Tooltip.Root>
          </span>
        {:else}
          <span class="w-28 text-right text-xs tabular-nums" title={PRICE_HINT}>
            {price}
            {#if price !== "Free"}
              <span class="sr-only">{PRICE_HINT}</span>
            {/if}
          </span>
        {/if}
      </div>
      {#if !model.listed}
        <p id={noteId} class="text-muted-foreground w-full pl-7 text-xs">
          OpenRouter dropped this model. Saving turns it off.
        </p>
      {:else if !model.tools}
        <p id={noteId} class="text-muted-foreground w-full pl-7 text-xs">
          OpenRouter says this model can't use tools now, so agents can't use it.
        </p>
      {/if}
    </li>
{/snippet}

{#snippet changesCount()}
  <span class="text-sm">
    {changes}
    {changes === 1 ? "unsaved change" : "unsaved changes"}
  </span>
{/snippet}

{#snippet saveActions()}
  <div class="flex items-center gap-2">
  <Button variant="ghost" size="sm" disabled={saving} onclick={discard}>Discard</Button>
  <Button size="sm" disabled={saving} onclick={save}>
      {#if saving}
        <Spinner data-icon="inline-start" />
      {/if}
      Save
    </Button>
</div>
{/snippet}

{#if placement === "dialog"}
  <Dialog.Header class="pr-8">
  <Dialog.Title>OpenRouter models</Dialog.Title>
  <Dialog.Description>{description}</Dialog.Description>
</Dialog.Header>

  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3">
      {#if catalogue !== null}
        {@render filters()}
      {/if}
      <div class="ml-auto">{@render syncControls()}</div>
    </div>
    {@render syncFailure()}
    {#if catalogue === null}
      {@render unread()}
    {:else}
      {@render refused()}
      <!-- The list scrolls inside the dialog, so its header and footer stay in view. -->
      <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {@render list("rounded-lg border")}
      </div>
    {/if}
  </div>

  <Dialog.Footer class="flex-row flex-wrap items-center justify-between sm:justify-between">
    {#if changes > 0}
      {@render changesCount()}
      {@render saveActions()}
    {:else}
      {#if catalogue !== null}
        {@render selectedCount()}
      {:else}
        <span></span>
      {/if}
      <Button size="sm" variant="outline" onclick={() => ondone?.()}>{doneLabel}</Button>
    {/if}
  </Dialog.Footer>
{:else}
  <section class="flex flex-col gap-3" aria-labelledby="openrouter-models-title">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-1">
        <h2 id="openrouter-models-title" class="text-base font-medium">OpenRouter models</h2>
        <p class="text-muted-foreground text-sm">{description}</p>
      </div>
      {@render syncControls()}
    </div>

    {@render syncFailure()}

    {#if catalogue === null}
      {@render unread()}
    {:else}
      <div class="flex flex-wrap items-center gap-3">
        {@render filters()}
        {@render selectedCount()}
      </div>

      {@render refused()}
      {@render list("rounded-lg border")}

      {#if changes > 0}
        <!-- Stays in view while the page scrolls, so the choice can be saved from anywhere in it. -->
        <div
          class="bg-background sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 shadow-sm"
        >
          {@render changesCount()}
          {@render saveActions()}
        </div>
      {/if}
    {/if}
  </section>
{/if}
