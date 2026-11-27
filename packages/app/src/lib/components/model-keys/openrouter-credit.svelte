<script lang="ts">
import { browser } from "$app/env";
import { getOpenRouterKeyInfo } from "#lib/api/openrouter.ts";
import * as Card from "#lib/components/ui/card/index.ts";
import { creditFailureLine, creditLine } from "./openrouter-models.ts";

let { keyId }: { keyId: string } = $props();

// Read live from OpenRouter with the key itself. A failed read says so only when OpenRouter
// refused the key: otherwise the key may still work, and the card already says when its secret
// is missing.
const line = $derived(
  browser
    ? getOpenRouterKeyInfo(fetch, keyId).then(creditLine, creditFailureLine)
    : Promise.resolve(null),
);
</script>

{#await line then credit}
  {#if credit}
    <Card.Description class={["text-xs", credit.problem && "text-destructive"]}>
      {credit.text}
    </Card.Description>
  {/if}
{/await}
