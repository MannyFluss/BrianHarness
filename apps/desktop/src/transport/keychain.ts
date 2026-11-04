// API keys in the iOS Keychain via IOS Dev's BHKeychain Capacitor plugin (Swift; Keychain service
// "com.manny.brianharness.credentials"). Contract:
//   get({ key }) -> { value: string | null }   set({ key, value })   remove({ key })   keys() -> { keys }
// keychainKV adapts it to core's KeyValueStore, so KVCredentialStore (same JSON records and
// "credentials/<provider>" keys as the web build) works unchanged on top.
import { KVCredentialStore, MemoryKV, type CredentialStoreLike, type KeyValueStore, type StoredCredential } from "@brianharness/core/browser";
import { scrubSecrets } from "../secrets";

export interface BHKeychainPlugin {
  get(o: { key: string }): Promise<{ value: string | null | undefined }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

export const KEYCHAIN_PREFIX = "credentials/";

/** OSStatus from a BHKeychain rejection (Capacitor `code`, `data.status`, or a number in the message). */
export function keychainStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; data?: { status?: unknown; code?: unknown }; message?: unknown };
  for (const c of [e?.data?.status, e?.status, e?.data?.code, e?.code]) {
    const n = typeof c === "number" ? c : typeof c === "string" && /^-?\d+$/.test(c.trim()) ? Number(c) : NaN;
    if (Number.isFinite(n) && n !== 0) return n;
  }
  const m = /(-\d{4,5})\b/.exec(String(e?.message ?? err ?? ""));
  return m ? Number(m[1]) : undefined;
}
/**
 * BHKeychain rejects a missing/invalid argument with code "EINVAL" and no data: that is a bug in
 * OUR call, not a Keychain condition, so it is rethrown and never triggers the degraded fallback.
 */
export const isKeychainProgrammingError = (err: unknown) => (err as { code?: unknown })?.code === "EINVAL";
/** -34018 errSecMissingEntitlement: unsigned simulator / missing keychain-access-groups entitlement */
export const isMissingEntitlement = (err: unknown) => keychainStatus(err) === -34018 || /errSecMissingEntitlement|missing entitlement/i.test(String((err as Error)?.message ?? err));

export const KEYCHAIN_UNAVAILABLE_NOTE =
  "iOS Keychain unavailable on this build (OSStatus -34018 errSecMissingEntitlement, e.g. an unsigned simulator build). Keys you add are kept in memory for this launch only; keys saved earlier on this device still work.";

export function keychainErrorMessage(op: string, err: unknown): string {
  return scrubSecrets(keychainErrorMessageRaw(op, err));
}
function keychainErrorMessageRaw(op: string, err: unknown): string {
  const st = keychainStatus(err);
  if (isKeychainProgrammingError(err)) return `iOS Keychain ${op}: invalid argument (EINVAL, a bug in the app's call): ${String((err as Error)?.message ?? err)}`;
  if (isMissingEntitlement(err)) return `iOS Keychain ${op} failed: OSStatus -34018 errSecMissingEntitlement (this build has no keychain entitlement, e.g. an unsigned simulator build)`;
  return `iOS Keychain ${op} failed${st !== undefined ? ` (OSStatus ${st})` : ""}: ${String((err as Error)?.message ?? err)}`;
}

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
      report.failed.push({ providerId, error: keychainErrorMessage("write", err) });
    }
  }
  return report;
}

/**
 * CredentialStoreLike over BHKeychain that first runs the localStorage migration (once per
 * launch; every method waits for it). `legacy` is the old web store (localStorage
 * "brianharness/credentials/..."). If a provider failed to migrate, reads fall back to its
 * legacy copy so a Keychain hiccup never makes a saved key vanish.
 *
 * Degraded mode: when the Keychain answers -34018 (errSecMissingEntitlement, unsigned simulator
 * builds) the store never throws on reads: it serves the legacy copies (never cleared, since
 * migration failed) plus keys added this launch, which are kept IN MEMORY only (not written to
 * localStorage). `unavailable` / `note()` explain why. Other Keychain errors on reads are logged
 * and fall back the same way for that call; a failed save throws a clear message.
 */
export function createKeychainCredentials(
  plugin: BHKeychainPlugin,
  legacy?: CredentialStoreLike,
  onReport?: (r: MigrationReport) => void,
): CredentialStoreLike & { migration: Promise<MigrationReport>; readonly unavailable: string | null; note(): string } {
  const kc = new KVCredentialStore(keychainKV(plugin), KEYCHAIN_PREFIX);
  const memory = new KVCredentialStore(new MemoryKV(), KEYCHAIN_PREFIX); // degraded-mode writes, this launch only
  const empty: MigrationReport = { migrated: [], alreadyInKeychain: [], failed: [] };
  let unavailable: string | null = null;
  let warned = false;
  const degrade = (op: string, err: unknown) => {
    if (isKeychainProgrammingError(err)) throw Object.assign(new Error(keychainErrorMessage(op, err)), { code: "EINVAL" });
    const msg = keychainErrorMessage(op, err);
    if (isMissingEntitlement(err)) unavailable = KEYCHAIN_UNAVAILABLE_NOTE;
    if (!warned || !isMissingEntitlement(err)) console.warn(`[brianharness] ${msg}`);
    warned = true;
    return msg;
  };
  const migration = legacy
    ? migrateCredentials(legacy, kc).then(
        (r) => {
          const missing = r.failed.find((f) => /-34018|errSecMissingEntitlement|missing entitlement/i.test(f.error));
          if (missing) degrade("migration", new Error(missing.error));
          onReport?.(r);
          return r;
        },
        () => empty,
      )
    : Promise.resolve(empty);
  const failed = async () => new Set((await migration).failed.map((f) => f.providerId));
  const fallbackRead = async (id: string) => (await memory.read(id)) ?? (legacy ? await legacy.read(id).catch(() => undefined) : undefined);
  return {
    migration,
    get unavailable() {
      return unavailable;
    },
    note: () => unavailable ?? "Stored in the iOS Keychain on this device (BHKeychain).",
    async read(id) {
      await migration;
      if (unavailable) return fallbackRead(id);
      let v: StoredCredential | undefined;
      try {
        v = await kc.read(id);
      } catch (err) {
        degrade("read", err);
        return fallbackRead(id);
      }
      if (v || !legacy || !(await failed()).has(id)) return v;
      return legacy.read(id);
    },
    async list() {
      await migration;
      const out: Array<{ providerId: string; type: string }> = [];
      const add = (xs: ReadonlyArray<{ providerId: string; type: string }>) => {
        for (const c of xs) if (!out.some((o) => o.providerId === c.providerId)) out.push(c);
      };
      if (!unavailable) {
        try {
          add(await kc.list());
        } catch (err) {
          degrade("list", err);
        }
      }
      add(await memory.list());
      if (legacy && (unavailable || (await failed()).size)) add(await legacy.list().catch(() => []));
      return out;
    },
    async modify(id, fn) {
      await migration;
      if (unavailable) return memory.modify(id, async (cur) => fn(cur ?? (await fallbackRead(id))));
      try {
        return await kc.modify(id, fn);
      } catch (err) {
        const msg = degrade("save", err);
        if (unavailable) return memory.modify(id, async (cur) => fn(cur ?? (await fallbackRead(id))));
        throw new Error(msg);
      }
    },
    async delete(id) {
      await migration;
      await memory.delete(id);
      if (!unavailable) {
        try {
          await kc.delete(id);
        } catch (err) {
          const msg = degrade("delete", err);
          if (!unavailable) throw new Error(msg);
        }
      }
      // logout must remove a key that is still only in localStorage (failed migration / degraded)
      if (legacy && (unavailable || (await failed()).has(id))) await legacy.delete(id).catch(() => undefined);
    },
  };
}
