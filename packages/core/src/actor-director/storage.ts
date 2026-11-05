/**
 * E1: actor-director mode storage. Its own namespaces in the shared KeyValueStore, disjoint from protocol 4's
 * (sessions/, saves/, study/...): ad/visible/<id> (tab_visible logs), ad/blinded/<id> (blinded MAIN logs, redacted)
 * and ad/sealed/<id> (the sealed companion of a blinded session; uploaded as "<id>.sealed", never shown in the app).
 * Same sync-cache-over-async-KV design as KVHarnessStorage: reads are sync, writes are queued; flush() awaits them.
 */
import type { KeyValueStore } from "../platform/kv.js";

export const AD_PROFILE = "actor-director" as const;
export const AD_KV_PREFIX = "ad/" as const;
export const AD_NAMESPACES = ["visible", "blinded", "sealed"] as const;
export type AdNamespace = (typeof AD_NAMESPACES)[number];

export class AdStorage {
  private cache = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private failures: unknown[] = [];
  private constructor(private kv: KeyValueStore) {}

  static async open(kv: KeyValueStore): Promise<AdStorage> {
    const s = new AdStorage(kv);
    for (const k of await kv.keys(AD_KV_PREFIX)) {
      const v = await kv.get(k);
      if (v !== null) s.cache.set(k, v);
    }
    return s;
  }
  private key(ns: AdNamespace, id: string) { return `${AD_KV_PREFIX}${ns}/${id}`; }
  private write(k: string) {
    const v = this.cache.get(k) ?? "";
    this.queue = this.queue.then(() => this.kv.set(k, v)).catch((e) => { this.failures.push(e); });
  }
  appendLine(ns: AdNamespace, id: string, line: string): void {
    if (line.includes("\n")) throw new Error("one JSON line at a time");
    const k = this.key(ns, id);
    this.cache.set(k, (this.cache.get(k) ?? "") + line + "\n");
    this.write(k);
  }
  read(ns: AdNamespace, id: string): string | null { return this.cache.get(this.key(ns, id)) ?? null; }
  /** session ids in a namespace (the app lists visible + blinded; sealed is for upload only) */
  list(ns: AdNamespace): string[] {
    const p = `${AD_KV_PREFIX}${ns}/`;
    return [...this.cache.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)).sort();
  }
  remove(ns: AdNamespace, id: string): void {
    const k = this.key(ns, id);
    this.cache.delete(k);
    this.queue = this.queue.then(() => this.kv.remove(k)).catch((e) => { this.failures.push(e); });
  }
  /** E6: small mode-local records (calibrations per orientation) under ad/meta/<key>; never part of a session log */
  setMeta(key: string, value: string): void { const k = `${AD_KV_PREFIX}meta/${key}`; this.cache.set(k, value); this.write(k); }
  getMeta(key: string): string | null { return this.cache.get(`${AD_KV_PREFIX}meta/${key}`) ?? null; }
  metaKeys(prefix = ""): string[] { const p = `${AD_KV_PREFIX}meta/${prefix}`; return [...this.cache.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(`${AD_KV_PREFIX}meta/`.length)).sort(); }
  removeMeta(key: string): void { const k = `${AD_KV_PREFIX}meta/${key}`; this.cache.delete(k); this.queue = this.queue.then(() => this.kv.remove(k)).catch((e) => { this.failures.push(e); }); }
  /** await queued writes; throws the first write failure */
  async flush(): Promise<void> {
    await this.queue;
    if (this.failures.length) { const e = this.failures[0]; this.failures = []; throw e; }
  }
}
