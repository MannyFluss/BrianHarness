// Capacitor detection for the web entry. In the native iOS app (Capacitor 8, CapacitorHttp enabled
// globally) window.fetch is a native request: no WebView CORS, so Ollama Cloud can be enabled.
// IOS Dev's Swift plugins upgrade that when present (feature-detected via window.Capacitor, no
// @capacitor/core dependency):
//   BHStream    real streaming fetch (nativeStreamFetch) -> backends use stream:true, tokens stream
//   BHKeychain  API keys in the iOS Keychain (one-time migration out of localStorage)
// Missing plugin -> the previous behaviour (CapacitorHttp buffered fetch, stream:false; localStorage).
// In a plain browser / PWA there is no Capacitor object and nothing changes.
import { KVCredentialStore, type CredentialStoreLike } from "@brianharness/core/browser";
import { safeLocalKV, type InProcessOptions } from "./in-process";
import { capacitorPlugin, createNativeStreamFetch, type BHStreamPlugin } from "./native-stream";
import { createKeychainCredentials, keychainKV, type BHKeychainPlugin, type MigrationReport } from "./keychain";
import type { BHExportPlugin } from "./types";
import type { BHAppleAuthPlugin } from "./apple-auth";
import type { KeyValueStore } from "@brianharness/core/browser";
import { scrubSecrets } from "../secrets";

export { createNativeStreamFetch, type BHStreamPlugin, type BHStreamEvent } from "./native-stream";
export { createKeychainCredentials, migrateCredentials, keychainKV, keychainStatus, isMissingEntitlement, KEYCHAIN_UNAVAILABLE_NOTE, type BHKeychainPlugin } from "./keychain";

type CapWindow = { Capacitor?: { isNativePlatform?: () => boolean }; fetch: typeof fetch };

export function isNativeCapacitor(win: unknown = globalThis): boolean {
  try {
    return !!(win as CapWindow).Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

const unimplemented = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "UNIMPLEMENTED" || e?.code === "UNAVAILABLE" || /not implemented|unimplemented|plugin is not available/i.test(e?.message ?? "");
};

/**
 * Streaming fetch over BHStream; if the plugin turns out unimplemented at call time, that request
 * falls back to the buffered fetch (the parsers accept SSE/NDJSON from a buffered body too).
 */
export function nativeStreamFetch(plugin: BHStreamPlugin, fallback: typeof fetch): typeof fetch {
  const streamFetch = createNativeStreamFetch(plugin);
  let broken = false;
  return async (input, init) => {
    if (broken) return fallback(input, init);
    try {
      return await streamFetch(input, init);
    } catch (err) {
      if (!unimplemented(err)) throw err;
      broken = true;
      return fallback(input, init);
    }
  };
}

export const KEYCHAIN_NOTE = "Stored in the iOS Keychain on this device (BHKeychain).";

/**
 * Options for createInProcessTransport from the current window. Native: nativeFetch on and a
 * late-bound fetchImpl (always calls the CURRENT window.fetch, i.e. CapacitorHttp's patch), or
 * BHStream's streaming fetch when installed (streaming: true). BHKeychain, when installed, holds
 * the API keys; existing localStorage keys are migrated on first use.
 */
export function nativeTransportOptions(
  win: unknown = globalThis,
  hooks: { onMigration?: (r: MigrationReport) => void; /** old store to migrate (default: localStorage "brianharness/") */ legacyCredentials?: CredentialStoreLike } = {},
): Pick<InProcessOptions, "nativeFetch" | "fetchImpl" | "streaming" | "credentials" | "credentialNote" | "secretKV" | "bhExport" | "uploadKV" | "appVersion" | "build" | "appleAuth"> {
  if (!isNativeCapacitor(win)) return {};
  const w = win as CapWindow;
  const buffered: typeof fetch = (input, init) => w.fetch(input, init);
  const out: ReturnType<typeof nativeTransportOptions> = { nativeFetch: true, fetchImpl: buffered, streaming: false };
  const stream = capacitorPlugin<BHStreamPlugin>(win, "BHStream");
  if (stream) {
    out.fetchImpl = nativeStreamFetch(stream, buffered);
    out.streaming = true;
  }
  const keychain = capacitorPlugin<BHKeychainPlugin>(win, "BHKeychain");
  if (keychain) {
    const legacy = hooks.legacyCredentials ?? new KVCredentialStore(safeLocalKV("brianharness/")); // the web build's store
    out.credentials = createKeychainCredentials(keychain, legacy, (r) => {
      if (r.failed.length) console.warn("[brianharness] keychain migration kept local copies for:", scrubSecrets(r.failed.map((f) => `${f.providerId} (${f.error})`).join(", ")));
      hooks.onMigration?.(r);
    });
    const store = out.credentials as ReturnType<typeof createKeychainCredentials>;
    out.credentialNote = () => store.note(); // switches to the -34018 explanation if the Keychain is unavailable
    out.secretKV = keychainKV(keychain); // Phase D schedule: Keychain key study/phaseD/schedule
  }
  const exporter = capacitorPlugin<BHExportPlugin>(win, "BHExport");
  if (exporter) {
    out.bhExport = exporter;
    // upload queue in Documents/pending-uploads (survives WKWebView storage eviction); older shells: IndexedDB
    if (typeof (exporter as BHExportKV).kvGet === "function") out.uploadKV = bhExportKV(exporter as BHExportKV);
  }
  // Sign in with Apple (brianharness-ios `siwa`); absent on older shells -> no sign-in UI, pasted token only
  const appleAuth = capacitorPlugin<BHAppleAuthPlugin>(win, "BHAppleAuth");
  if (appleAuth) out.appleAuth = appleAuth;
  // CFBundleShortVersionString / CFBundleVersion, injected by the iOS shell at document start
  // (build may arrive as a number from the plist; normalised to a string)
  const info = (win as { __BH_APP_INFO__?: { appVersion?: string | number; build?: string | number } }).__BH_APP_INFO__;
  if (info?.appVersion !== undefined && info.appVersion !== null && String(info.appVersion)) out.appVersion = String(info.appVersion);
  if (info?.build !== undefined && info.build !== null && String(info.build)) out.build = String(info.build);
  return out;
}

/** BHExport's pending-uploads store (Documents/pending-uploads, one file per encodeURIComponent(key)) */
export type BHExportKV = BHExportPlugin & {
  kvGet(o: { key: string }): Promise<{ value: string | null }>;
  kvSet(o: { key: string; value: string }): Promise<void>;
  kvRemove(o: { key: string }): Promise<void>;
  kvKeys(o: { prefix?: string }): Promise<{ keys: string[] }>;
};
export function bhExportKV(plugin: BHExportKV): KeyValueStore {
  return {
    get: async (key) => (await plugin.kvGet({ key }))?.value ?? null,
    set: async (key, value) => void (await plugin.kvSet({ key, value })),
    remove: async (key) => void (await plugin.kvRemove({ key })),
    keys: async (prefix = "") => ((await plugin.kvKeys({ prefix }))?.keys ?? []).filter((k) => k.startsWith(prefix)),
  };
}
