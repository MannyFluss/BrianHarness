/**
 * Credentials behind one interface (the same shape pi-ai's CredentialStore uses), so platforms
 * swap the backing store, not the callers:
 *  - Desktop (Node): FileCredentialStore (providers/credential-store.ts), 0600 file in the
 *    user-data dir, encrypted with Electron safeStorage (macOS Keychain key) when available.
 *  - Web/PWA test build: KVCredentialStore over LocalStorageKV. Plain text in localStorage;
 *    acceptable ONLY for the LAN test build with throwaway keys.
 *  - iOS app: KVCredentialStore over a Keychain-backed KeyValueStore (IOS Dev's Capacitor adapter).
 */
import type { KeyValueStore } from "./kv.js";

export type StoredCredential = { type: "api_key"; key: string } | { type: "oauth"; [k: string]: unknown } | { type: string; [k: string]: unknown };

export interface CredentialStoreLike {
  read(providerId: string): Promise<StoredCredential | undefined>;
  list(): Promise<ReadonlyArray<{ providerId: string; type: string }>>;
  modify(providerId: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>): Promise<StoredCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

export class KVCredentialStore implements CredentialStoreLike {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private kv: KeyValueStore, private prefix = "credentials/") {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async read(id: string) {
    const v = await this.kv.get(this.prefix + id);
    return v ? (JSON.parse(v) as StoredCredential) : undefined;
  }
  async list() {
    const out: Array<{ providerId: string; type: string }> = [];
    for (const k of await this.kv.keys(this.prefix)) {
      const c = await this.read(k.slice(this.prefix.length));
      if (c) out.push({ providerId: k.slice(this.prefix.length), type: c.type });
    }
    return out;
  }
  modify(id: string, fn: (c: StoredCredential | undefined) => Promise<StoredCredential | undefined>) {
    return this.serial(async () => {
      const cur = await this.read(id);
      const next = await fn(cur);
      if (next === undefined) return cur;
      await this.kv.set(this.prefix + id, JSON.stringify(next));
      return next;
    });
  }
  delete(id: string) {
    return this.serial(() => this.kv.remove(this.prefix + id));
  }
}

/** API key for a provider, if one is stored. */
export async function readApiKey(store: CredentialStoreLike, providerId: string): Promise<string | undefined> {
  const c = await store.read(providerId);
  return c?.type === "api_key" && typeof (c as { key?: unknown }).key === "string" ? (c as { key: string }).key : undefined;
}
