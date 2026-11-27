// The proxy's cache of OpenRouter's usable models: trusted for a minute, dropped by a change made
// in this process, and never filled by a read that may predate that change.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  makeUsableOpenRouterModels,
  REREAD_EVERY_MS,
  USABLE_TTL_MS,
} from "../src/core/openrouter_usable.ts";
import type { OpenRouterModel } from "../src/core/openrouter.ts";
import { memoryKeyStore } from "./memory_store.ts";

const T0 = Date.parse("2026-11-27T12:00:00.000Z");

/** A store whose usable-set reads are counted, and can be held. */
function countingStore() {
  const store = memoryKeyStore();
  let reads = 0;
  let hold: Promise<void> | null = null;
  let answer: OpenRouterModel[] = [];
  store.listUsableOpenRouterModels = async () => {
    reads += 1;
    const now = answer;
    if (hold !== null) await hold;
    return now;
  };
  return {
    store,
    reads: () => reads,
    set(models: string[]) {
      answer = models.map((id) => ({ id }) as OpenRouterModel);
    },
    holdReads() {
      let release = () => {};
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

test("one read serves for a minute; an invalidation drops it at once", async () => {
  const s = countingStore();
  let now = T0;
  const usable = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(now) });
  s.set(["a/one"]);
  assertEquals((await usable.get()).map((m) => m.id), ["a/one"]);
  s.set(["b/two"]);
  assertEquals((await usable.get()).map((m) => m.id), ["a/one"]);
  assertEquals(s.reads(), 1);

  now = T0 + USABLE_TTL_MS;
  assertEquals((await usable.get()).map((m) => m.id), ["b/two"]);
  assertEquals(s.reads(), 2);

  s.set([]);
  usable.invalidate();
  assertEquals(await usable.get(), []);
  assertEquals(s.reads(), 3);
});

test("a read that began before an invalidation is not cached", async () => {
  const s = countingStore();
  const usable = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(T0) });
  s.set(["a/one"]);
  const release = s.holdReads();
  const stale = usable.get();
  // The admin turns the model off while that read is out.
  s.set([]);
  usable.invalidate();
  release();
  assertEquals((await stale).map((m) => m.id), ["a/one"]);
  assertEquals(await usable.get(), [], "the next call reads again");
  assertEquals(s.reads(), 2);
});

test("two caches over one store: a reread sees what the other's process enabled", async () => {
  const s = countingStore();
  const here = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(T0) });
  const there = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(T0) });
  s.set(["a/one"]);
  assertEquals((await here.get()).map((m) => m.id), ["a/one"]);

  s.set(["a/one", "b/two"]);
  there.invalidate();
  assertEquals((await there.get()).map((m) => m.id), ["a/one", "b/two"]);
  // Nothing told this cache, so its minute still holds; a reread reads the store, and keeps it.
  assertEquals((await here.get()).map((m) => m.id), ["a/one"]);
  assertEquals((await here.reread()).map((m) => m.id), ["a/one", "b/two"]);
  assertEquals((await here.get()).map((m) => m.id), ["a/one", "b/two"]);
  assertEquals(s.reads(), 3);
});

test("a reread never drops the cache, shares the one in flight, and starts once a second", async () => {
  const s = countingStore();
  let now = T0;
  const usable = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(now) });
  s.set(["a/one"]);
  assertEquals((await usable.get()).map((m) => m.id), ["a/one"]);
  assertEquals(s.reads(), 1);

  // A run loops on a model that is off. Its rereads, all at once, are one read of the store, and
  // while it is out every other caller is served from the cache.
  const release = s.holdReads();
  const rereads = Array.from({ length: 50 }, () => usable.reread());
  assertEquals((await usable.get()).map((m) => m.id), ["a/one"], "the cache stands meanwhile");
  release();
  await Promise.all(rereads);
  assertEquals(s.reads(), 2);

  // More refusals inside the same second read nothing.
  for (let i = 0; i < 50; i++) await usable.reread();
  assertEquals(s.reads(), 2);

  // A model another process enabled is served after the next refusal a second on, and cached.
  s.set(["a/one", "b/two"]);
  assertEquals((await usable.reread()).map((m) => m.id), ["a/one"], "within the second");
  now = T0 + REREAD_EVERY_MS;
  assertEquals((await usable.reread()).map((m) => m.id), ["a/one", "b/two"]);
  assertEquals((await usable.get()).map((m) => m.id), ["a/one", "b/two"]);
  assertEquals(s.reads(), 3);
});

test("a reread out when the cache is invalidated does not fill it", async () => {
  const s = countingStore();
  const usable = makeUsableOpenRouterModels({ store: s.store, now: () => new Date(T0) });
  s.set(["a/one"]);
  const release = s.holdReads();
  const out = usable.reread();
  s.set([]);
  usable.invalidate();
  release();
  assertEquals((await out).map((m) => m.id), ["a/one"]);
  assertEquals(await usable.get(), [], "the next call reads again");
});
