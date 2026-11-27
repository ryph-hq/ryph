<script lang="ts">
import * as Alert from "#lib/components/ui/alert/index.ts";
import * as Field from "#lib/components/ui/field/index.ts";
import { Label } from "#lib/components/ui/label/index.ts";
import { Switch } from "#lib/components/ui/switch/index.ts";
import EyeIcon from "@lucide/svelte/icons/eye";

let {
  canPublishArtifacts = $bindable(),
  locked = false,
}: {
  /** Whether the agent's runs may publish artifacts. */
  canPublishArtifacts: boolean;
  /** True when the switch is off and only an administrator may turn it on. */
  locked?: boolean;
} = $props();
</script>

<Field.FieldSet>
  <Field.FieldLegend>Artifacts</Field.FieldLegend>
  <Field.FieldDescription>
    The agent can publish pages, like reports and overviews, and share a link to them.
  </Field.FieldDescription>
  <Field.FieldGroup>
    <div class="flex items-center gap-3">
      <Switch id="can-publish-artifacts" bind:checked={canPublishArtifacts} disabled={locked} />
      <Label for="can-publish-artifacts">Let this agent publish artifacts</Label>
    </div>
    {#if locked}
      <Field.FieldDescription>Only an administrator can let an agent publish artifacts.</Field.FieldDescription>
    {/if}
    {#if canPublishArtifacts}
      <Alert.Root>
        <EyeIcon />
        <Alert.Title>Everyone on this instance can see them</Alert.Title>
        <Alert.Description>
          Anything this agent publishes is visible to every member, including what it found in repos
          they can't otherwise see.
        </Alert.Description>
      </Alert.Root>
    {/if}
  </Field.FieldGroup>
</Field.FieldSet>
