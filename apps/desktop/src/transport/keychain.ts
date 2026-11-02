// API keys in the iOS Keychain via IOS Dev's BHKeychain Capacitor plugin (Swift; Keychain service
// "com.manny.brianharness.credentials"). Contract:
//   get({ key }) -> { value: string | null }   set({ key, value })   remove({ key })   keys() -> { keys }
// keychainKV adapts it to core's KeyValueStore, so KVCredentialStore (same JSON records and
// "credentials/<provider>" keys as the web build) works unchanged on top.
import { KVCredentialStore, type CredentialStoreLike, type KeyValueStore, type StoredCredential } from "@brianharness/core/browser";

export interface BHKeychainPlugin {
  get(o: { key: string }): Promise<{ value: string | null | undefined }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

export const KEYCHAIN_PREFIX = "credentials/";

export function keychainKV(plugin: BHKeychainPlugin): KeyValueStore {
  return {
    get: async (key) => (await plugin.get({ key }))?.value ?? null,
    set: async (key, value) => void (await plugin.set({ key, value })),
    remove: async (key) => void (await plugin.remove({ key })),
    keys: async (prefix = "") => ((await plugin.keys())?.keys ?? []).filter((k) => k.startsWith(prefix)),
  };
}

export interface MigrationReport {
  migrated: string[];
  /** Keychain already had this provider: local copy dropped, Keychain value kept */
  alreadyInKeychain: string[];
  /** Keychain write/verify failed: local copy KEPT */
  failed: Array<{ providerId: string; error: string }>;
}

/**
 * One-time move of credentials from the old localStorage store into the Keychain. Per provider:
 * write to the Keychain, read it back, and only then delete the local copy. A failed write keeps
 * the local copy (nothing is lost; the next launch retries). Idempotent: an empty local store is a
 * no-op, and a provider already in the Keychain keeps its Keychain value (it is newer).
 */
export async function migrateCredentials(from: CredentialStoreLike, to: CredentialStoreLike): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], alreadyInKeychain: [], failed: [] };
  let local: ReadonlyArray<{ providerId: string }>;
  try {
    local = await from.list();
  } catch {
    return report; // no readable local store (private mode etc.)
  }
  for (const { providerId } of local) {
    try {
      const cred = await from.read(providerId);
      if (!cred) continue;
      const existing = await to.read(providerId);
      if (existing) {
        report.alreadyInKeychain.push(providerId);
      } else {
        await to.modify(providerId, async () => cred as StoredCredential);
        const back = await to.read(providerId);
        if (!back || JSON.stringify(back) !== JSON.stringify(cred)) throw new Error("keychain read-back mismatch");
        report.migrated.push(providerId);
      }
      await from.delete(providerId);
    } catch (err) {
      report.failed.push({ providerId, error: (err as Error).message ?? String(err) });
    }
  }
  return report;
}

/**
 * CredentialStoreLike over BHKeychain that first runs the localStorage migration (once per
 * launch; every method waits for it). `legacy` is the old web store (localStorage
 * "brianharness/credentials/..."). If a provider failed to migrate, reads fall back to its
 * legacy copy so a Keychain hiccup never makes a saved key vanish.
 */
export function createKeychainCredentials(plugin: BHKeychainPlugin, legacy?: CredentialStoreLike, onReport?: (r: MigrationReport) => void): CredentialStoreLike & { migration: Promise<MigrationReport> } {
  const kc = new KVCredentialStore(keychainKV(plugin), KEYCHAIN_PREFIX);
  const empty: MigrationReport = { migrated: [], alreadyInKeychain: [], failed: [] };
  const migration = legacy
    ? migrateCredentials(legacy, kc).then(
        (r) => (onReport?.(r), r),
        () => empty,
      )
    : Promise.resolve(empty);
  const failed = async () => new Set((await migration).failed.map((f) => f.providerId));
  return {
    migration,
    async read(id) {
      await migration;
      const v = await kc.read(id);
      if (v || !legacy || !(await failed()).has(id)) return v;
      return legacy.read(id);
    },
    async list() {
      await migration;
      const out = [...(await kc.list())];
      if (legacy && (await failed()).size) for (const c of await legacy.list()) if (!out.some((o) => o.providerId === c.providerId)) out.push(c);
      return out;
    },
    async modify(id, fn) {
      await migration;
      return kc.modify(id, fn);
    },
    async delete(id) {
      await migration;
      await kc.delete(id);
      if (legacy && (await failed()).has(id)) await legacy.delete(id).catch(() => undefined);
    },
  };
}
