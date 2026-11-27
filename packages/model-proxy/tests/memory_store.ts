// A test fixture, not a deployment option. It used to be both: `RYPH_DB=memory` ran this as
// a second implementation of every store port, free to drift from the drizzle one without any
// test noticing. `pglite:memory://` replaced that — it is the real driver over real PostgreSQL,
// so throwaway databases now exercise the production path.
//
// What is left here is a fast double for tests that care about behaviour ABOVE the store and
// want no database at all. Anything asserting on SQL belongs on makeTestDb() instead.

import type {
  CustomProvider,
  PlanSignIn,
  PlatformModelPolicy,
  ProviderKey,
  UsageRecord,
  VirtualKey,
} from "../src/core/types.ts";
import { PLATFORM_PRINCIPAL_PREFIX } from "../src/core/types.ts";
import { customProviderSpec, endpointShape } from "../src/core/registry.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { UsageAggregateRow, UsageDimension } from "../src/core/usage_report.ts";
import {
  MISSES_BEFORE_UNLISTED,
  type OpenRouterModel,
  type OpenRouterSync,
} from "../src/core/openrouter.ts";

export function memoryKeyStore(): KeyStore {
  const providerKeys = new Map<string, ProviderKey>();
  const customProviders = new Map<string, CustomProvider>();
  const virtualKeys = new Map<string, VirtualKey>();
  const usage: UsageRecord[] = [];
  let platformPolicy: PlatformModelPolicy | null = null;
  const signIns = new Map<string, PlanSignIn>();
  let agentHostId: string | null = null;
  const openRouterModels = new Map<string, OpenRouterModel>();
  let openRouterSync: OpenRouterSync | null = null;
  const openRouterRows = () =>
    structuredClone(
      [...openRouterModels.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  return {
    createProviderKey(key) {
      providerKeys.set(key.id, structuredClone(key));
      return Promise.resolve();
    },
    getProviderKey(id) {
      const key = providerKeys.get(id);
      return Promise.resolve(key ? structuredClone(key) : null);
    },
    listProviderKeys() {
      const keys = [...providerKeys.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
      );
      return Promise.resolve(structuredClone(keys));
    },
    saveProviderKey(key) {
      providerKeys.set(key.id, structuredClone(key));
      return Promise.resolve();
    },
    updateProviderKey(id, patch) {
      const key = providerKeys.get(id);
      if (key === undefined) return Promise.resolve(null);
      const updated = { ...key };
      for (const [field, value] of Object.entries(patch)) {
        if (value !== undefined) Object.assign(updated, { [field]: value });
      }
      providerKeys.set(id, structuredClone(updated));
      return Promise.resolve(structuredClone(updated));
    },
    // One process, so the lock is the caller's own per-key queue; nothing else to hold.
    withProviderKeyLock(_id, fn) {
      return fn();
    },
    replaceProviderKeySecret(id, expected, next, at) {
      const key = providerKeys.get(id);
      if (key === undefined || key.encryptedSecret !== expected) return Promise.resolve(false);
      providerKeys.set(id, { ...key, encryptedSecret: next, updatedAt: at });
      return Promise.resolve(true);
    },
    markPlanNeedsReauth(id, expected, at) {
      const key = providerKeys.get(id);
      if (key === undefined || key.encryptedSecret !== expected) return Promise.resolve(false);
      providerKeys.set(id, { ...key, planStatus: "needs_reauth", updatedAt: at });
      return Promise.resolve(true);
    },
    markPlanLimited(id, at) {
      const key = providerKeys.get(id);
      if (key === undefined || key.planStatus === "needs_reauth") return Promise.resolve(false);
      providerKeys.set(id, { ...key, planStatus: "limited", planLimitedAt: at, updatedAt: at });
      return Promise.resolve(true);
    },
    clearPlanLimited(id, at) {
      const key = providerKeys.get(id);
      if (key === undefined || key.planStatus !== "limited") return Promise.resolve(false);
      providerKeys.set(id, { ...key, planStatus: "active", planLimitedAt: null, updatedAt: at });
      return Promise.resolve(true);
    },

    claimAgentHostId(candidate) {
      agentHostId ??= candidate;
      return Promise.resolve(agentHostId);
    },
    createSignIn(row) {
      signIns.set(row.id, structuredClone(row));
      return Promise.resolve();
    },
    getSignIn(id) {
      const row = signIns.get(id);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    getSignInByState(state) {
      const row = [...signIns.values()].find((s) => s.state === state);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    claimSignIn(id, nowIso) {
      const row = signIns.get(id);
      if (row === undefined || row.status !== "pending" || row.expiresAt <= nowIso) {
        return Promise.resolve(null);
      }
      row.status = "exchanging";
      row.updatedAt = nowIso;
      return Promise.resolve(structuredClone(row));
    },
    finishSignIn(id, outcome) {
      const row = signIns.get(id);
      if (row !== undefined) {
        row.status = outcome.status;
        row.error = outcome.error;
        row.resultKeyId = outcome.resultKeyId;
        row.updatedAt = outcome.at;
      }
      return Promise.resolve();
    },
    pruneSignIns(before) {
      for (const [id, row] of signIns) if (row.expiresAt < before) signIns.delete(id);
      return Promise.resolve();
    },

    listCustomProviders() {
      // Insertion order is creation order here; the drizzle store sorts by createdAt, id.
      const rows = [...customProviders.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
      return Promise.resolve(structuredClone(rows));
    },
    getCustomProvider(id) {
      const row = customProviders.get(id);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    createCustomProvider(row) {
      customProviders.set(row.id, structuredClone(row));
      return Promise.resolve();
    },
    updateCustomProvider(id, patch) {
      const row = customProviders.get(id);
      if (row === undefined) return Promise.resolve(null);
      // Mirrors the drizzle store's partial UPDATE … RETURNING: only the keys present are set.
      const updated = { ...row };
      for (const [field, value] of Object.entries(patch)) {
        if (value !== undefined) Object.assign(updated, { [field]: value });
      }
      customProviders.set(id, updated);
      // And its transaction: a changed request shape drops every secret sealed for the old one.
      let keysCleared = 0;
      if (endpointShape(customProviderSpec(updated)) !== endpointShape(customProviderSpec(row))) {
        for (const key of providerKeys.values()) {
          if (key.provider === id && key.encryptedSecret !== "") {
            providerKeys.set(key.id, { ...key, encryptedSecret: "", updatedAt: patch.updatedAt });
            if (key.archivedAt === null && key.encryptedSecret.startsWith("v2.")) keysCleared++;
          }
        }
      }
      return Promise.resolve({ provider: structuredClone(updated), keysCleared });
    },
    writeProviderKeySealedFor(sealedFor, write) {
      // One synchronous step, as the drizzle store's transaction is one serialised one.
      const endpoint = customProviders.get(sealedFor.providerId);
      if (
        endpoint === undefined || endpointShape(customProviderSpec(endpoint)) !== sealedFor.shape
      ) {
        return Promise.resolve({ moved: true as const });
      }
      if ("create" in write) {
        providerKeys.set(write.create.id, structuredClone(write.create));
        return Promise.resolve({ moved: false as const, key: structuredClone(write.create) });
      }
      const key = providerKeys.get(write.id);
      if (key === undefined) return Promise.resolve({ moved: false as const, key: null });
      const updated = { ...key };
      for (const [field, value] of Object.entries(write.patch)) {
        if (value !== undefined) Object.assign(updated, { [field]: value });
      }
      providerKeys.set(write.id, updated);
      return Promise.resolve({ moved: false as const, key: structuredClone(updated) });
    },
    archiveCustomProvider(id, at) {
      // Mirrors the drizzle store's `where archived_at is null`: the first archiving counts.
      const row = customProviders.get(id);
      if (row !== undefined && row.archivedAt === null) {
        customProviders.set(id, { ...row, archivedAt: at, updatedAt: at });
      }
      return Promise.resolve();
    },

    createVirtualKey(key) {
      virtualKeys.set(key.id, structuredClone(key));
      return Promise.resolve();
    },
    getVirtualKeyByTokenHash(tokenHash) {
      const key = [...virtualKeys.values()].find((k) => k.tokenHash === tokenHash);
      return Promise.resolve(key ? structuredClone(key) : null);
    },
    revokeVirtualKeysForRun(runId, at) {
      for (const key of virtualKeys.values()) {
        if (key.runId === runId && key.revokedAt === null) key.revokedAt = at;
      }
      return Promise.resolve();
    },
    revokePlatformVirtualKeys(at) {
      // Mirrors the drizzle store's LIKE 'platform:%' AND revoked_at IS NULL.
      for (const key of virtualKeys.values()) {
        if (key.runId.startsWith(PLATFORM_PRINCIPAL_PREFIX) && key.revokedAt === null) {
          key.revokedAt = at;
        }
      }
      return Promise.resolve();
    },

    getPlatformPolicy() {
      return Promise.resolve(platformPolicy === null ? null : structuredClone(platformPolicy));
    },
    savePlatformPolicy(policy) {
      platformPolicy = structuredClone(policy);
      return Promise.resolve();
    },
    clearPlatformPolicy() {
      platformPolicy = null;
      return Promise.resolve();
    },

    upsertOpenRouterCatalogue(models, at) {
      // Mirrors the drizzle store's one transaction: upserted, listed and its misses cleared,
      // `enabled` kept; every listed row the sync left out one miss more, and unlisted unless it
      // is enabled and short of MISSES_BEFORE_UNLISTED.
      const ids = new Set(models.map((m) => m.id));
      for (const [id, row] of openRouterModels) {
        if (!ids.has(id) && row.listed) {
          const missedSyncs = row.missedSyncs + 1;
          openRouterModels.set(id, {
            ...row,
            missedSyncs,
            listed: row.enabled && missedSyncs < MISSES_BEFORE_UNLISTED,
            updatedAt: at,
          });
        }
      }
      for (const model of models) {
        const enabled = openRouterModels.get(model.id)?.enabled ?? false;
        openRouterModels.set(
          model.id,
          structuredClone({ ...model, listed: true, missedSyncs: 0, enabled, updatedAt: at }),
        );
      }
      return Promise.resolve();
    },
    countListedOpenRouterModels() {
      return Promise.resolve([...openRouterModels.values()].filter((m) => m.listed).length);
    },
    listOpenRouterModels() {
      return Promise.resolve(openRouterRows());
    },
    listUsableOpenRouterModels() {
      return Promise.resolve(openRouterRows().filter((m) => m.enabled && m.listed && m.tools));
    },
    listOpenRouterPrices() {
      return Promise.resolve(
        openRouterRows().flatMap(({ id, price }) => price === null ? [] : [{ id, price }]),
      );
    },
    setOpenRouterEnabled(ids, at) {
      const wanted = new Set(ids);
      for (const [id, row] of openRouterModels) {
        if (row.enabled !== wanted.has(id)) {
          openRouterModels.set(id, { ...row, enabled: wanted.has(id), updatedAt: at });
        }
      }
      return Promise.resolve();
    },
    getOpenRouterSync() {
      return Promise.resolve(openRouterSync === null ? null : { ...openRouterSync });
    },
    putOpenRouterSync({ syncedAt, attemptedAt, error, errorCode }) {
      openRouterSync = {
        syncedAt,
        attemptedAt,
        error,
        errorCode,
        startedAt: openRouterSync?.startedAt ?? null,
      };
      return Promise.resolve();
    },
    markOpenRouterSyncStarted(at) {
      openRouterSync = {
        syncedAt: null,
        attemptedAt: null,
        error: null,
        errorCode: null,
        ...openRouterSync,
        startedAt: at,
      };
      return Promise.resolve();
    },

    recordUsage(record) {
      usage.push(structuredClone(record));
      return Promise.resolve();
    },
    listUsageForRun(runId) {
      return Promise.resolve(structuredClone(usage.filter((u) => u.runId === runId)));
    },
    aggregateUsage(query) {
      // Mirrors the drizzle store's GROUP BY key, provider, model, tier bucket, cost reported —
      // and its ONE snapshot for every dimension asked, so a row written while a report runs
      // belongs to none of its breakdowns rather than to some of them.
      const snapshot = usage.filter((u) => {
        if (query.runId !== undefined && u.runId !== query.runId) return false;
        if (query.from !== undefined && u.at < query.from) return false;
        if (query.to !== undefined && u.at >= query.to) return false;
        return true;
      });
      const thresholds = query.tierThresholds.filter((t) => t > 0).toSorted((a, b) => b - a);
      const keyOf = (u: UsageRecord, by: UsageDimension): string | null => {
        switch (by) {
          case "model":
            return null;
          case "agent":
            return u.agentId ?? (u.runId.startsWith(PLATFORM_PRINCIPAL_PREFIX) ? u.runId : null);
          case "providerKey":
            return u.providerKeyId;
          case "day":
            return u.at.slice(0, 10);
          case "task":
            return u.taskId;
        }
      };
      const group = (by: UsageDimension): UsageAggregateRow[] => {
        const groups = new Map<string, UsageAggregateRow>();
        for (const u of snapshot) {
          const totalInput = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) +
            (u.cacheWriteTokens ?? 0);
          const tierFloor = thresholds.find((t) => totalInput > t) ?? 0;
          const key = keyOf(u, by);
          const costReported = u.costUsd !== null;
          const id = JSON.stringify([key, u.provider, u.model, tierFloor, costReported]);
          let row = groups.get(id);
          if (row === undefined) {
            row = {
              key,
              provider: u.provider,
              model: u.model,
              tierFloor,
              requests: 0,
              failedRequests: 0,
              meteredRequests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cacheWrite1hTokens: 0,
              reasoningTokens: 0,
              costReported,
              reportedCostUsd: 0,
            };
            groups.set(id, row);
          }
          row.requests += 1;
          if (u.status >= 400) row.failedRequests += 1;
          if (u.inputTokens !== null) row.meteredRequests += 1;
          row.inputTokens += u.inputTokens ?? 0;
          row.outputTokens += u.outputTokens ?? 0;
          row.cacheReadTokens += u.cacheReadTokens ?? 0;
          row.cacheWriteTokens += u.cacheWriteTokens ?? 0;
          row.cacheWrite1hTokens += u.cacheWrite1hTokens ?? 0;
          row.reasoningTokens += u.reasoningTokens ?? 0;
          row.reportedCostUsd += u.costUsd ?? 0;
        }
        return [...groups.values()];
      };
      return Promise.resolve(query.by.map(group));
    },
    async close() {},
  };
}
