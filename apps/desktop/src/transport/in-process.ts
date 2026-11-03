// In-process transport: the harness core runs inside the page (web target, iOS WKWebView shell).
// Same EegBridge contract the Electron preload exposes, so the React UI is identical.
//   storage      IndexedDB (falls back to memory if unavailable, e.g. some private modes)
//   settings     localStorage
//   credentials  localStorage via KVCredentialStore  <- web TEST build only; iOS: BHKeychain (native.ts)
// Providers: mock (default, offline), Ollama at a configurable URL (LAN IP), any OpenAI-compatible
// server, OpenAI / Anthropic with an API key straight from the browser, and Ollama Cloud
// (https://ollama.com + API key) ONLY when a native fetchImpl is passed: ollama.com has no CORS, so
// a plain PWA reports "needs the native app (no CORS)" instead of failing silently. Subscription sign-in
// (ChatGPT / Claude OAuth) and Claude Code need native code and are reported as unavailable.
import {
  APP_NAME,
  BROWSER_DEFAULT_MODELS,
  DEFAULT_OLLAMA_URL,
  HarnessHost,
  OLLAMA_CLOUD_DEFAULT_MODEL,
  OLLAMA_CLOUD_NO_CORS,
  IndexedDbKV,
  KVCredentialStore,
  KVHarnessStorage,
  LocalStorageKV,
  MemoryKV,
  StudyController,
  type StudySessionRecord,
  scheduleExportFile,
  createBrowserBackend,
  zipFiles,
  detectOllama,
  detectOllamaCloud,
  normalizeOllamaBaseUrl,
  readApiKey,
  type CredentialStoreLike,
  type HarnessStorage,
  type KeyValueStore,
  type ModelBackend,
  type ProviderKind,
  type TopicTagger,
  type TopicTaggerSpec,
  type ExportFile,
  APP_EXTRACTOR_MAX_CALLS,
  DEFAULT_EXTRACTOR_PROMPT_VERSION,
  appTaggerSpec,
  kvCallCounter,
  parsePromptVersion,
  SPIDER_CLOUD_DEFAULT_MODEL,
  SPIDER_CREDENTIAL_ID,
  listSpiderCloudModels,
  normalizeSpiderUrl,
  UploadQueue,
  STUDY_PROTOCOL_VERSION,
  recordingBackend,
  recordPluginRejections,
  type FeedbackReport,
  type FlightRecorder,
} from "@brianharness/core/browser";
import { createFeedbackApi } from "./feedback";
import { saveViaBHExport, shareViaBHExport } from "./bh-export";
import { createAppleAuth, deviceLabelFor, isAppleRecord, type AppleAuth, type AppleAuthView, type BHAppleAuthPlugin } from "./apple-auth";
import type { BHExportPlugin, EegBridge, ExportResult, Info, KeyProvider, ProviderId, ProviderStatus, UploadStatusView } from "./types";

/** Web fallback for "Export logs": one zip download (no share sheet in a plain browser). */
export function downloadZip(files: ExportFile[], name: string, doc: Document | undefined = typeof document !== "undefined" ? document : undefined): boolean {
  if (!doc || typeof Blob === "undefined" || typeof URL?.createObjectURL !== "function") return false;
  const blob = new Blob([zipFiles(files) as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export interface InProcessOptions {
  /** platform adapters (IOS Dev: pass Capacitor Preferences / Keychain KVs here) */
  storageKV?: KeyValueStore;
  settingsKV?: KeyValueStore;
  credentials?: CredentialStoreLike;
  /** shown in the key dialog; a function is re-read each time (e.g. Keychain became unavailable) */
  credentialNote?: string | (() => string);
  userId?: string;
  platform?: string;
  /**
   * fetch used by EVERY network path: provider detection (Ollama /api/tags), all model backends
   * (Ollama, OpenAI-compatible, OpenAI, Anthropic) and an Ollama topic tagger. iOS: pass a
   * CapacitorHttp-backed fetch to bypass WebView CORS/CSP. Default: the page's fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * topic tagger override (tests). Default: per session, appTaggerSpec(): llm-extract (prompt v2, rank lead)
   * with a real cloud provider and an Ollama Cloud key, else keyphrase-idf. An Ollama spec gets fetchImpl
   * and the settings' Ollama URL.
   */
  tagger?: TopicTagger | TopicTaggerSpec;
  /**
   * true when fetchImpl bypasses browser CORS (CapacitorHttp). Default: true iff fetchImpl was passed.
   * Gates Ollama Cloud, whose API sends no CORS headers.
   */
  nativeFetch?: boolean;
  /**
   * fetchImpl streams response bodies, so backends may use stream:true and token callbacks
   * reach the UI incrementally. false = buffered stream:false (CapacitorHttp without BHStream).
   * Default: true for the page's own fetch, false when a custom fetchImpl is passed.
   */
  streaming?: boolean;
  /** mock backend's per-word delay when streaming to the UI (ms) */
  mockTokenDelayMs?: number;
  /** Ollama Cloud base URL (tests point this at a fake server). Default https://ollama.com */
  ollamaCloudUrl?: string;
  /**
   * secure store for the Phase D study schedule (iOS: BHKeychain via keychainKV, key
   * study/phaseD/schedule). Default: localStorage (web TEST build only, not secure).
   */
  secretKV?: KeyValueStore;
  /** iOS BHExport plugin: share sheet for "Export logs", saveToDocuments at every session end */
  bhExport?: BHExportPlugin;
  /** web fallback for Export logs (tests); default downloadZip */
  download?: (files: ExportFile[], name: string) => boolean;
  /**
   * upload-queue store (state + queued bodies). iOS: a Capacitor Filesystem KV over Documents/pending-uploads
   * (IOS_DEV_NOTE_phaseD.md); default IndexedDB "brianharness-uploads" (memory if unavailable).
   */
  uploadKV?: KeyValueStore;
  /** upload body metadata (Worker items.app_version / build); default "0.1.0" / null */
  appVersion?: string;
  build?: string | number | null;
  /** auto-upload timer (default true; tests pass false and call uploads.flush()) */
  uploadAutoSchedule?: boolean;
  /** iOS BHAppleAuth plugin (Sign in with Apple -> Worker session token in credentials/spider) */
  appleAuth?: BHAppleAuthPlugin;
  /** in-app bug report flight recorder: chat / backend-state / native-plugin-error events (feedback/recorder.ts) */
  recorder?: FlightRecorder;
}
export const APP_VERSION_DEFAULT = "0.1.0";
/** a session file whose session_start carries the study block */
export function isStudySessionFile(f: ExportFile): boolean {
  for (const line of f.content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { type?: string; study?: unknown };
      if (r.type === "session_start") return !!r.study && typeof r.study === "object";
    } catch { /* skip */ }
  }
  return false;
}

type HostTagger = ConstructorParameters<typeof HarnessHost>[0]["tagger"];
const CLOUD_PROVIDERS: ProviderKind[] = ["ollama-cloud", "openai", "anthropic"];

type WebSettings = {
  provider: ProviderKind; model?: string; ollamaUrl?: string; openaiCompatibleUrl?: string;
  /** llm-extract prompt rollback flag (absent = DEFAULT_EXTRACTOR_PROMPT_VERSION, v2) */
  extractorPromptVersion?: "v1" | "v2";
  /** Spider Cloud Worker origin (advanced settings; default https://api.strangeriver.org) */
  spiderCloudUrl?: string;
  /** set by an explicit picker choice (providers.select); without it the default provider is resolved at load */
  providerChosen?: boolean;
};
const SETTINGS_KEY = "settings";
/**
 * Model for the resolved default (stored token, no picker choice): gpt-oss:20b-cloud, the route verified live
 * (max_tokens 2048, opener cue, composer lock). The picker's model list and SPIDER_CLOUD_DEFAULT_MODEL are unchanged.
 */
export const SPIDER_APP_DEFAULT_MODEL = "gpt-oss:20b-cloud";
export const SPIDER_NO_CORS = "Spider Cloud needs the native app: the Worker sends no CORS headers for browsers.";

function guessPlatform() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPod/.test(ua)) return "ios-phone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return "ios-tablet";
  return "web";
}

export function safeLocalKV(ns: string): KeyValueStore {
  try {
    return new LocalStorageKV(ns);
  } catch {
    return new MemoryKV();
  }
}

export function createInProcessTransport(opts: InProcessOptions = {}): EegBridge {
  const rec = opts.recorder;
  // study session in progress -> the recorder stores study-scrubbed events only (no raw error text, no prompt sizes)
  rec?.setStudyProbe(() => !!host?.hud()?.study);
  // flight recorder: native plugin rejections become `error` events (calls and results unchanged)
  if (rec) opts = { ...opts, ...(opts.bhExport ? { bhExport: recordPluginRejections("BHExport", opts.bhExport, rec) } : {}), ...(opts.appleAuth ? { appleAuth: recordPluginRejections("BHAppleAuth", opts.appleAuth, rec) } : {}) };
  const settingsKV = opts.settingsKV ?? safeLocalKV("brianharness/");
  const credentials = opts.credentials ?? new KVCredentialStore(safeLocalKV("brianharness/"));
  const userId = opts.userId ?? "local-user";
  const platform = opts.platform ?? guessPlatform();
  let storageName = "IndexedDB brianharness";
  // unbound wrapper so a passed-in window.fetch is never invoked with another `this`
  const rawFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // Sign in with Apple: the Worker token sits in credentials/spider like a pasted one; the wrapper only swaps a
  // token rotated by refresh and notices 401 session_expired/invalid_token (requests/bodies otherwise untouched)
  const apple: AppleAuth | null = opts.appleAuth
    ? createAppleAuth({
        plugin: opts.appleAuth,
        credentials,
        fetchImpl: rawFetch,
        baseUrl: async () => normalizeSpiderUrl((await loadSettings()).spiderCloudUrl),
        deviceLabel: deviceLabelFor(platform),
        onTokenSaved: () => {
          void uploadQueue.then((q) => q.flush()).catch(() => {}); // same kick as a pasted token
          void resetDefaultBackend();
        },
      })
    : null;
  const fetchImpl: typeof fetch = apple ? apple.wrapFetch(rawFetch) : rawFetch;
  const nativeFetch = opts.nativeFetch ?? !!opts.fetchImpl;
  const streaming = opts.streaming ?? !opts.fetchImpl;

  const ready: Promise<{ storage: HarnessStorage }> = (async () => {
    let kv = opts.storageKV;
    if (!kv) {
      try {
        kv = await IndexedDbKV.open("brianharness");
      } catch {
        kv = new MemoryKV();
        storageName = "memory (IndexedDB unavailable: nothing is saved)";
      }
    }
    return { storage: await KVHarnessStorage.open(kv) };
  })();

  const loadStoredSettings = async (): Promise<WebSettings> => {
    try {
      const raw = await settingsKV.get(SETTINGS_KEY);
      return { provider: "mock", ...(raw ? (JSON.parse(raw) as Partial<WebSettings>) : {}) };
    } catch {
      return { provider: "mock" };
    }
  };
  /**
   * Demo default (Nov 3 2026, launch/routing only): with no explicit picker choice, a stored Spider Cloud token
   * (pasted or Sign in with Apple) in the native app means Spider Cloud with SPIDER_APP_DEFAULT_MODEL, never Mock.
   * No model-list fetch is involved, so a slow or failing /v1/models can't delay or change the choice.
   */
  const loadSettings = async (): Promise<WebSettings> => {
    const s = await loadStoredSettings();
    if (s.provider !== "mock" || s.providerChosen || !nativeFetch) return s;
    const token = await readApiKey(credentials, SPIDER_CREDENTIAL_ID).catch(() => null);
    return token ? { ...s, provider: "spider-cloud", model: SPIDER_APP_DEFAULT_MODEL } : s;
  };
  /** the Spider token changed: drop a backend built from the resolved default so the next session uses the new one */
  const resetDefaultBackend = async () => {
    const s = await loadStoredSettings();
    if (!s.providerChosen) backend = null;
  };
  const saveSettings = async (s: Partial<WebSettings>) => {
    const next = { ...(await loadStoredSettings()), ...s };
    await settingsKV.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  };

  let backend: ModelBackend | null = null;
  const build = async (s: WebSettings): Promise<ModelBackend> => {
    const b = recordingBackend(await buildRaw(s), rec); // one `chat` flight-recorder event per generate (P0 fields)
    rec?.record("state", { event: "backend", backend: b.id, provider: s.provider });
    return b;
  };
  const buildRaw = async (s: WebSettings): Promise<ModelBackend> => {
    const p = s.provider;
    if (p === "ollama") {
      const baseUrl = normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL);
      let model = s.model;
      if (!model) {
        const d = await detectOllama(baseUrl, 1500, fetchImpl);
        model = (d.models.find((m) => !m.cloud) ?? d.models[0])?.name;
        if (!model) throw new Error(`No Ollama models reachable at ${baseUrl}`);
      }
      return createBrowserBackend({ provider: "ollama", baseUrl, model, fetchImpl, streaming });
    }
    if (p === "ollama-cloud") {
      if (!nativeFetch) throw new Error(OLLAMA_CLOUD_NO_CORS);
      return createBrowserBackend({ provider: p, model: s.model ?? OLLAMA_CLOUD_DEFAULT_MODEL, baseUrl: opts.ollamaCloudUrl, apiKey: await readApiKey(credentials, p), fetchImpl, streaming });
    }
    if (p === "spider-cloud") {
      if (!nativeFetch) throw new Error(SPIDER_NO_CORS);
      return createBrowserBackend({ provider: p, model: s.model ?? SPIDER_CLOUD_DEFAULT_MODEL, baseUrl: normalizeSpiderUrl(s.spiderCloudUrl), apiKey: await readApiKey(credentials, SPIDER_CREDENTIAL_ID), fetchImpl, streaming });
    }
    if (p === "openai-compatible") return createBrowserBackend({ provider: p, baseUrl: s.openaiCompatibleUrl, model: s.model, apiKey: await readApiKey(credentials, p), fetchImpl, streaming });
    if (p === "openai" || p === "anthropic") return createBrowserBackend({ provider: p, model: s.model, apiKey: await readApiKey(credentials, p), fetchImpl, streaming });
    return createBrowserBackend({ provider: "mock", seed: 42, mockTokenDelayMs: opts.mockTokenDelayMs });
  };
  const ensureBackend = async () => {
    if (backend) return backend;
    try {
      backend = await build(await loadSettings());
    } catch (err) {
      console.warn("[brianharness] backend unavailable, using mock:", (err as Error).message);
      rec?.record("state", { event: "mock_fallback", reason: (err as Error).message });
      backend = recordingBackend(createBrowserBackend({ provider: "mock", seed: 42, mockTokenDelayMs: opts.mockTokenDelayMs }), rec);
    }
    return backend;
  };

  let host: HarnessHost | null = null;
  // progress lives next to the schedule in the secure store (Keychain on iOS); settingsKV = legacy location (migrated).
  // recovery sources if the progress is gone: local session logs + the upload ledger (iOS: Documents/pending-uploads)
  const study = new StudyController(opts.secretKV ?? safeLocalKV("brianharness/"), settingsKV, {
    recover: async (): Promise<StudySessionRecord[]> => [...(await getHost()).studyRecords(), ...(await (await uploadQueue).studyRecords().catch(() => []))],
  });
  // launch: discard a schedule sealed under an older study protocol (practice build 1438); sessions + upload queue untouched
  void study.ensureProtocol().then((r) => { if (r.reset) console.warn("[brianharness] study schedule from an older protocol discarded; Start study seals a new one"); }).catch(() => {});
  const getHost = async (): Promise<HarnessHost> => {
    if (host) return host;
    const { storage } = await ready;
    let tagger: HostTagger = opts.tagger;
    if (tagger && !("tag" in tagger) && tagger.kind === "ollama") {
      const s = await loadSettings();
      tagger = { ...tagger, baseUrl: tagger.baseUrl ?? normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL), fetchImpl: tagger.fetchImpl ?? fetchImpl };
    }
    if (!tagger) tagger = async (ctx) => { const c = await chooseTagger(ctx); return { spec: c.spec, fallback: c.fallback }; };
    host = new HarnessHost({
      userId,
      storage,
      backend: ensureBackend,
      logRawEvents: true,
      tagger,
      study,
      // iOS: every ended session's JSONL (ratings included, mode never) lands in Files automatically;
      // a study session's file is also queued for auto-upload (practice sessions never upload)
      onSessionEnd: async (id) => {
        const f = host?.sessionFile(id);
        if (!f) return;
        if (opts.bhExport) await saveViaBHExport(opts.bhExport, [f]).catch(() => {}); // bh-session-<idx>-<start>-<tag>.jsonl
        await enqueueStudySession(f);
      },
    });
    return host;
  };

  // ---- auto-upload (POST /v1/sessions) ----
  const uploadKV: Promise<KeyValueStore> = opts.uploadKV
    ? Promise.resolve(opts.uploadKV)
    : IndexedDbKV.open("brianharness-uploads").catch(() => new MemoryKV() as KeyValueStore);
  const uploadQueue: Promise<UploadQueue> = uploadKV.then((kv) => new UploadQueue(kv, {
    meta: { appVersion: opts.appVersion ?? APP_VERSION_DEFAULT, platform, build: opts.build ?? null },
    fetchImpl,
    autoSchedule: opts.uploadAutoSchedule,
    // the Worker sends no CORS headers: uploads need the native fetch + the Spider Cloud device token
    target: async () => {
      if (!nativeFetch) return null;
      const token = await readApiKey(credentials, SPIDER_CREDENTIAL_ID).catch(() => null);
      if (!token) return null;
      const origin = normalizeSpiderUrl((await loadSettings()).spiderCloudUrl);
      return { url: `${origin}/v1/sessions`, feedbackUrl: `${origin}/v1/feedback`, token };
    },
  }));
  const enqueueStudySession = async (f: ExportFile) => {
    if (!isStudySessionFile(f)) return; // study sessions only
    const q = await uploadQueue;
    await q.enqueueSession(f).catch((e) => console.warn(`[brianharness] upload queue: ${(e as Error).message}`));
    void q.flush().catch(() => {});
  };
  const enqueueStudyStart = async (s: { scheduleHash: string; protocol: number; createdAt: string }) => {
    const q = await uploadQueue;
    await q.enqueueStudyStart({ scheduleHash: s.scheduleHash, nSessions: 10, createdAt: s.createdAt, protocol: s.protocol ?? STUDY_PROTOCOL_VERSION });
    void q.flush().catch(() => {});
  };
  void uploadQueue.then((q) => q.flush()).catch(() => {}); // launch: retry anything left over
  const feedbackApi = createFeedbackApi({ queue: uploadQueue, bhExport: opts.bhExport, download: opts.download, recorder: rec });

  // llm-extract: one persisted call cap shared by every NON-study session (study sessions use a per-session
  // budget, so practice can't use up study calls); answers cached for the app's lifetime
  const extractorCalls = kvCallCounter(settingsKV, APP_EXTRACTOR_MAX_CALLS);
  const extractorCache = new Map<string, string>();
  const chooseTagger = async (ctx: { study?: boolean } = {}) => {
    const s = await loadSettings();
    const ollamaCloudKey = CLOUD_PROVIDERS.includes(s.provider) ? await readApiKey(credentials, "ollama-cloud").catch(() => null) : null;
    return appTaggerSpec({
      provider: s.provider,
      model: s.model,
      ollamaUrl: normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL),
      ollamaCloudKey,
      canReachOllamaCloud: nativeFetch,
      spiderToken: s.provider === "spider-cloud" ? await readApiKey(credentials, SPIDER_CREDENTIAL_ID).catch(() => null) : null,
      spiderUrl: s.spiderCloudUrl,
      canReachSpider: nativeFetch,
      ollamaCloudUrl: opts.ollamaCloudUrl,
      promptVersion: parsePromptVersion(s.extractorPromptVersion),
      counter: extractorCalls,
      study: !!ctx.study,
      cache: { get: (k) => extractorCache.get(k), set: (k, v) => void extractorCache.set(k, v) },
      fetchImpl,
    });
  };

  const info = async (): Promise<Info> => {
    const s = await loadSettings();
    const t = opts.tagger ? "custom" : (await chooseTagger()).reason;
    return {
      backend: backend?.id ?? "…", paid: !!backend?.paid, provider: s.provider, model: s.model ?? null, dataDir: storageName, userId, platform, appName: APP_NAME,
      extractorPromptVersion: parsePromptVersion(s.extractorPromptVersion) ?? DEFAULT_EXTRACTOR_PROMPT_VERSION, tagger: t,
    };
  };

  const status = async (): Promise<ProviderStatus[]> => {
    const s = await loadSettings();
    const ollamaUrl = normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL);
    const spiderUrl = normalizeSpiderUrl(s.spiderCloudUrl);
    const [ollama, oaKey, anKey, ocKey, cloudKey, spiderKey] = await Promise.all([
      detectOllama(ollamaUrl, 1500, fetchImpl),
      readApiKey(credentials, "openai"),
      readApiKey(credentials, "anthropic"),
      readApiKey(credentials, "openai-compatible"),
      readApiKey(credentials, "ollama-cloud"),
      readApiKey(credentials, SPIDER_CREDENTIAL_ID),
    ]);
    const spider = nativeFetch && spiderKey ? await listSpiderCloudModels(spiderUrl, spiderKey, fetchImpl) : null;
    const cloud = nativeFetch && cloudKey ? await detectOllamaCloud(cloudKey, fetchImpl, 4000, opts.ollamaCloudUrl) : null;
    const cloudModels = cloud?.models.length ? cloud.models.map((m) => m.name) : [OLLAMA_CLOUD_DEFAULT_MODEL];
    const isLoopback = /\/\/(localhost|127\.)/.test(ollamaUrl);
    return [
      { id: "mock", label: "Mock (offline)", available: true, signedIn: true, auth: ["none"], models: [{ id: "mock", label: "Template Director", paid: false }], detail: "No model, no network." },
      {
        id: "ollama",
        label: "Ollama (LAN)",
        available: ollama.running && ollama.models.length > 0,
        signedIn: ollama.running,
        auth: ["none"],
        endpoint: ollamaUrl,
        models: ollama.models.map((m) => ({ id: m.name, label: `${m.name}${m.parameterSize ? ` · ${m.parameterSize}` : ""}${m.cloud ? " · cloud" : ""}`, paid: m.cloud })),
        detail: ollama.running
          ? `${ollama.models.length} model(s) at ${ollamaUrl}`
          : `Not reachable at ${ollamaUrl}.${isLoopback ? " On a phone, set your Mac's LAN IP (e.g. http://192.168.1.20:11434)." : ""} The Mac needs OLLAMA_HOST=0.0.0.0 and OLLAMA_ORIGINS set to this page's origin (CORS).`,
      },
      {
        id: "spider-cloud",
        label: "Spider Cloud",
        available: nativeFetch,
        signedIn: nativeFetch && !!spiderKey,
        auth: ["api_key"],
        authSource: nativeFetch && spiderKey ? (isAppleRecord(await credentials.read(SPIDER_CREDENTIAL_ID).catch(() => undefined)) ? "Sign in with Apple (this device)" : "device token (this device)") : undefined,
        endpoint: spiderUrl,
        models: nativeFetch ? (spider?.models ?? [SPIDER_CLOUD_DEFAULT_MODEL]).map((m) => ({ id: m, label: `${m} · Spider Cloud`, paid: false })) : [],
        detail: !nativeFetch
          ? SPIDER_NO_CORS
          : !spiderKey
            ? "Paste your Spider Cloud device token (bhd_…) once. Works after Manny's Worker deploy."
            : spider?.live
              ? `${spider.models.length} model(s) at ${spiderUrl}`
              : `Couldn't list models (${spider?.error ?? "?"}); offering the default list.`,
      },
      {
        id: "ollama-cloud",
        label: "Ollama Cloud (API key)",
        available: nativeFetch,
        signedIn: nativeFetch && !!cloudKey,
        auth: ["api_key"],
        authSource: nativeFetch && cloudKey ? "API key (this device)" : undefined,
        models: nativeFetch ? cloudModels.map((m) => ({ id: m, label: `${m} · cloud`, paid: false })) : [],
        detail: !nativeFetch
          ? OLLAMA_CLOUD_NO_CORS
          : !cloudKey
            ? "Paste an Ollama API key (ollama.com -> Settings -> Keys). Runs on Ollama's servers."
            : cloud?.running
              ? `${cloud.models.length} model(s) on ollama.com`
              : `Couldn't list models (${cloud?.error ?? "?"}); ${OLLAMA_CLOUD_DEFAULT_MODEL} is offered anyway.`,
      },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible server",
        available: !!s.openaiCompatibleUrl,
        signedIn: !!s.openaiCompatibleUrl,
        auth: ["api_key"],
        authSource: ocKey ? "API key (this browser)" : undefined,
        endpoint: s.openaiCompatibleUrl ?? "",
        models: s.openaiCompatibleUrl ? [{ id: s.model && s.provider === "openai-compatible" ? s.model : "local-model", label: s.model && s.provider === "openai-compatible" ? s.model : "server default model", paid: false }] : [],
        detail: s.openaiCompatibleUrl ? s.openaiCompatibleUrl : "LM Studio / llama.cpp / vLLM: set the server URL (…/v1). The server must allow CORS.",
      },
      {
        id: "openai",
        label: "OpenAI (API key)",
        available: true,
        signedIn: !!oaKey,
        auth: ["api_key"],
        authSource: oaKey ? "API key (this browser)" : undefined,
        models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5.4-mini"].map((m) => ({ id: m, label: m, paid: true })),
        detail: oaKey ? undefined : "Paste an API key. ChatGPT subscription sign-in needs the native iOS app.",
      },
      {
        id: "anthropic",
        label: "Claude (API key)",
        available: true,
        signedIn: !!anKey,
        auth: ["api_key"],
        authSource: anKey ? "API key (this browser)" : undefined,
        models: [BROWSER_DEFAULT_MODELS.anthropic!, "claude-haiku-4-5"].map((m) => ({ id: m, label: m, paid: true })),
        detail: anKey ? undefined : "Paste an Anthropic API key (sent with the direct-browser-access header). Claude sign-in needs the native app.",
      },
    ];
  };

  const t: EegBridge = {
    kind: "in-process",
    platform,
    get credentialNote() {
      const n = opts.credentialNote;
      return (typeof n === "function" ? n() : n) ?? "Stored in this browser's localStorage, unencrypted. Web test build only: use a throwaway key. The iOS app keeps keys in the Keychain.";
    },
    async newSession(onToken) {
      return (await getHost()).newSession({ onToken });
    },
    async reply(p, onToken) {
      return (await getHost()).reply(p, { onToken });
    },
    async hud() {
      return (await getHost()).hud();
    },
    async sessions() {
      return (await getHost()).sessions();
    },
    async info() {
      await ensureBackend();
      return info();
    },
    async flush() {
      const { storage } = await ready;
      await storage.flush?.();
    },
    async rate(r) {
      return (await getHost()).rate(r);
    },
    async exportLogs(): Promise<ExportResult> {
      const h = await getHost();
      await (await ready).storage.flush?.();
      const files = h.exportFiles();
      if (!files.length) return { ok: false, files: 0, via: "none", detail: "nothing to export yet" };
      if (opts.bhExport) return shareViaBHExport(opts.bhExport, files);
      const ok = (opts.download ?? downloadZip)(files, `brianharness-logs-${stamp()}.zip`);
      return { ok, files: files.length, via: ok ? "download" : "none" };
    },
    study: {
      status: () => study.status(),
      async enable() {
        try {
          const s = await study.enable();
          void enqueueStudyStart(s).catch(() => {});
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      async disable() {
        await study.disable();
        return { ok: true };
      },
      hash: () => study.hash(),
      unseal: (confirm: string) => study.unseal(confirm),
      /** dev/debug: save the unsealed schedule (exact Keychain string; sha256(file) = scheduleHash) */
      async exportSchedule(confirm: string): Promise<ExportResult> {
        const f = scheduleExportFile(await study.unseal(confirm));
        if (opts.bhExport) return shareViaBHExport(opts.bhExport, [f]);
        const ok = (opts.download ?? downloadZip)([f], `brianharness-schedule-${stamp()}.zip`);
        return { ok, files: 1, via: ok ? "download" : "none" };
      },
      reissue: (n: number, confirm: string, reason?: string) => study.requestReissue(n, confirm, reason),
      setNext: (n: number, confirm: string) => study.setNext(n, confirm),
      async cancelReissue() {
        await study.cancelReissue();
        return { ok: true };
      },
    },
    ...(apple
      ? {
          appleAuth: {
            launch: () => apple.launch(),
            signIn: () => apple.signIn(),
            skip: () => apple.skip(),
            status: () => apple.status(),
            onChange: (cb: (v: AppleAuthView) => void) => apple.onChange(cb),
          },
        }
      : {}),
    feedback: {
      send: (r) => feedbackApi.send(r as FeedbackReport),
      export: (r) => feedbackApi.export(r as FeedbackReport),
      async context() {
        const h = host?.hud() ?? null; // never starts a session or the host
        return { sessionId: h?.sessionId ?? null, study: { inStudy: !!h?.study, index: h?.study?.index ?? null } };
      },
      // synchronous up to the append, so open / sent / closed land in call order
      log: (e) => (host ? host.feedbackEvent(e) : Promise.resolve({ ok: false })),
    },
    uploads: {
      status: async () => (await (await uploadQueue).summary()) as UploadStatusView,
      flush: async () => (await (await uploadQueue).flush({ force: true })) as UploadStatusView,
    },
    providers: {
      async status() {
        return { providers: await status(), current: await info() };
      },
      async select(provider: ProviderId, model?: string | null) {
        const s = await loadSettings();
        const next = await build({ ...s, provider: provider as ProviderKind, model: model ?? undefined }); // throws -> UI shows it
        await saveSettings({ provider: provider as ProviderKind, model: model ?? undefined, providerChosen: true });
        backend = next;
        host?.setBackend(next);
        rec?.record("state", { event: "provider", provider, model: model ?? null });
        return info();
      },
      async setApiKey(provider: KeyProvider, key: string) {
        const k = key.trim();
        if (!k) throw new Error("empty API key");
        await credentials.modify(provider, async () => ({ type: "api_key", key: k }));
        if (provider === SPIDER_CREDENTIAL_ID) void uploadQueue.then((q) => q.flush()).catch(() => {}); // a new token resumes a 401 pause
        if (provider === SPIDER_CREDENTIAL_ID) { apple?.noteSlotChanged(); await resetDefaultBackend(); }
        return { ok: true };
      },
      async setEndpoint(provider, url) {
        const u = url.trim();
        if (u && !/^https?:\/\//.test(u)) throw new Error("URL must start with http:// or https://");
        await saveSettings(provider === "ollama" ? { ollamaUrl: u || undefined } : provider === "spider-cloud" ? { spiderCloudUrl: u || undefined } : { openaiCompatibleUrl: u || undefined });
        return { ok: true };
      },
      async setExtractorPrompt(version) {
        const v = parsePromptVersion(version);
        if (!v) throw new Error("extractor prompt version must be v1 or v2");
        await saveSettings({ extractorPromptVersion: v === DEFAULT_EXTRACTOR_PROMPT_VERSION ? undefined : v });
        return info();
      },
      async logout(provider: KeyProvider) {
        await credentials.delete(provider);
        if (provider === SPIDER_CREDENTIAL_ID) { apple?.noteSlotChanged(); await resetDefaultBackend(); }
        return { ok: true };
      },
      async login() {
        return { ok: false, error: "Subscription sign-in needs the native app (OAuth callback). Use an API key in the web build." };
      },
      async cancelLogin() {
        return true;
      },
      async answer() {
        return false;
      },
      onAuthEvent: () => () => {},
      onAuthPrompt: () => () => {},
      onAuthPromptDone: () => () => {},
    },
  };
  return t;
}
