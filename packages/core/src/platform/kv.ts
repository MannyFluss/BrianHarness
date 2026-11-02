/**
 * KeyValueStore: the one async storage primitive platform adapters implement. Its shape mirrors
 * Capacitor Preferences (get/set/remove/keys), so the iOS adapter is ~10 lines:
 *
 *   import { Preferences } from "@capacitor/preferences";
 *   export const preferencesKV = (prefix = "bh/"): KeyValueStore => ({
 *     get: async (k) => (await Preferences.get({ key: prefix + k })).value,
 *     set: (k, value) => Preferences.set({ key: prefix + k, value }),
 *     remove: (k) => Preferences.remove({ key: prefix + k }),
 *     keys: async (p = "") => (await Preferences.keys()).keys.filter((k) => k.startsWith(prefix + p)).map((k) => k.slice(prefix.length)),
 *   });
 *
 * A Keychain plugin exposes the same four calls, so it plugs into KVCredentialStore the same way.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** keys starting with prefix (without any adapter-internal namespace) */
  keys(prefix?: string): Promise<string[]>;
}

export class MemoryKV implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
  async remove(k: string) {
    this.data.delete(k);
  }
  async keys(prefix = "") {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

interface WebStorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

/** window.localStorage (web/PWA test build). Sync underneath, async interface. */
export class LocalStorageKV implements KeyValueStore {
  private ls: WebStorageLike;
  constructor(readonly namespace = "brianharness/", storage?: WebStorageLike) {
    const s = storage ?? (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (!s) throw new Error("localStorage is not available in this context");
    this.ls = s;
  }
  async get(k: string) {
    return this.ls.getItem(this.namespace + k);
  }
  async set(k: string, v: string) {
    this.ls.setItem(this.namespace + k, v);
  }
  async remove(k: string) {
    this.ls.removeItem(this.namespace + k);
  }
  async keys(prefix = "") {
    const out: string[] = [];
    for (let i = 0; i < this.ls.length; i++) {
      const k = this.ls.key(i);
      if (k && k.startsWith(this.namespace + prefix)) out.push(k.slice(this.namespace.length));
    }
    return out;
  }
}

// Minimal structural IndexedDB types so core needs no DOM lib.
type IDBReq<T> = { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
type IDBStoreLike = { get(k: string): IDBReq<unknown>; put(v: string, k: string): IDBReq<unknown>; delete(k: string): IDBReq<unknown>; getAllKeys(): IDBReq<unknown[]> };
type IDBDbLike = {
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(n: string): unknown;
  transaction(n: string, mode: "readonly" | "readwrite"): { objectStore(n: string): IDBStoreLike };
};
type IDBFactoryLike = { open(name: string, version?: number): IDBReq<IDBDbLike> & { onupgradeneeded: (() => void) | null } };

const req = <T>(r: IDBReq<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

/** IndexedDB key-value store (web/PWA and WKWebView). One object store, string values. */
export class IndexedDbKV implements KeyValueStore {
  private constructor(private db: IDBDbLike, private store: string) {}
  static async open(dbName = "brianharness", store = "kv", factory?: IDBFactoryLike): Promise<IndexedDbKV> {
    const f = factory ?? (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB;
    if (!f) throw new Error("IndexedDB is not available in this context");
    const r = f.open(dbName, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store);
    };
    return new IndexedDbKV(await req(r), store);
  }
  private os(mode: "readonly" | "readwrite") {
    return this.db.transaction(this.store, mode).objectStore(this.store);
  }
  async get(k: string) {
    const v = await req(this.os("readonly").get(k));
    return typeof v === "string" ? v : null;
  }
  async set(k: string, v: string) {
    await req(this.os("readwrite").put(v, k));
  }
  async remove(k: string) {
    await req(this.os("readwrite").delete(k));
  }
  async keys(prefix = "") {
    const ks = await req(this.os("readonly").getAllKeys());
    return ks.map(String).filter((k) => k.startsWith(prefix));
  }
}
