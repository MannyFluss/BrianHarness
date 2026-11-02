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
} from "@brianharness/core/browser";
import { saveViaBHExport, shareViaBHExport } from "./bh-export";
import type { BHExportPlugin, EegBridge, ExportResult, Info, KeyProvider, ProviderId, ProviderStatus } from "./types";

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
}

type HostTagger = ConstructorParameters<typeof HarnessHost>[0]["tagger"];
const CLOUD_PROVIDERS: ProviderKind[] = ["ollama-cloud", "openai", "anthropic"];

type WebSettings = {
  provider: ProviderKind; model?: string; ollamaUrl?: string; openaiCompatibleUrl?: string;
  /** llm-extract prompt rollback flag (absent = DEFAULT_EXTRACTOR_PROMPT_VERSION, v2) */
  extractorPromptVersion?: "v1" | "v2";
};
const SETTINGS_KEY = "settings";

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
  const settingsKV = opts.settingsKV ?? safeLocalKV("brianharness/");
  const credentials = opts.credentials ?? new KVCredentialStore(safeLocalKV("brianharness/"));
  const userId = opts.userId ?? "local-user";
  const platform = opts.platform ?? guessPlatform();
  let storageName = "IndexedDB brianharness";
  // unbound wrapper so a passed-in window.fetch is never invoked with another `this`
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
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

  const loadSettings = async (): Promise<WebSettings> => {
    try {
      const raw = await settingsKV.get(SETTINGS_KEY);
      return { provider: "mock", ...(raw ? (JSON.parse(raw) as Partial<WebSettings>) : {}) };
    } catch {
      return { provider: "mock" };
    }
  };
  const saveSettings = async (s: Partial<WebSettings>) => {
    const next = { ...(await loadSettings()), ...s };
    await settingsKV.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  };

  let backend: ModelBackend | null = null;
  const build = async (s: WebSettings): Promise<ModelBackend> => {
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
      backend = createBrowserBackend({ provider: "mock", seed: 42, mockTokenDelayMs: opts.mockTokenDelayMs });
    }
    return backend;
  };

  let host: HarnessHost | null = null;
  const study = new StudyController(opts.secretKV ?? safeLocalKV("brianharness/"), settingsKV);
  const getHost = async () => {
    if (host) return host;
    const { storage } = await ready;
    let tagger: HostTagger = opts.tagger;
    if (tagger && !("tag" in tagger) && tagger.kind === "ollama") {
      const s = await loadSettings();
      tagger = { ...tagger, baseUrl: tagger.baseUrl ?? normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL), fetchImpl: tagger.fetchImpl ?? fetchImpl };
    }
    if (!tagger) tagger = async () => { const c = await chooseTagger(); return { spec: c.spec, fallback: c.fallback }; };
    host = new HarnessHost({
      userId,
      storage,
      backend: ensureBackend,
      logRawEvents: true,
      tagger,
      study,
      // iOS: every ended session's JSONL (ratings included, mode never) lands in Files automatically
      onSessionEnd: opts.bhExport
        ? async (id) => {
            const f = host?.sessionFile(id);
            if (f) await saveViaBHExport(opts.bhExport!, [f]); // bh-session-<idx>-<start>.jsonl, ratings included
          }
        : undefined,
    });
    return host;
  };

  // llm-extract: one persisted call cap shared by every session; answers cached for the app's lifetime
  const extractorCalls = kvCallCounter(settingsKV, APP_EXTRACTOR_MAX_CALLS);
  const extractorCache = new Map<string, string>();
  const chooseTagger = async () => {
    const s = await loadSettings();
    const ollamaCloudKey = CLOUD_PROVIDERS.includes(s.provider) ? await readApiKey(credentials, "ollama-cloud").catch(() => null) : null;
    return appTaggerSpec({
      provider: s.provider,
      model: s.model,
      ollamaUrl: normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL),
      ollamaCloudKey,
      canReachOllamaCloud: nativeFetch,
      ollamaCloudUrl: opts.ollamaCloudUrl,
      promptVersion: parsePromptVersion(s.extractorPromptVersion),
      counter: extractorCalls,
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
    const [ollama, oaKey, anKey, ocKey, cloudKey] = await Promise.all([
      detectOllama(ollamaUrl, 1500, fetchImpl),
      readApiKey(credentials, "openai"),
      readApiKey(credentials, "anthropic"),
      readApiKey(credentials, "openai-compatible"),
      readApiKey(credentials, "ollama-cloud"),
    ]);
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
          await study.enable();
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
    },
    providers: {
      async status() {
        return { providers: await status(), current: await info() };
      },
      async select(provider: ProviderId, model?: string | null) {
        const s = await loadSettings();
        const next = await build({ ...s, provider: provider as ProviderKind, model: model ?? undefined }); // throws -> UI shows it
        await saveSettings({ provider: provider as ProviderKind, model: model ?? undefined });
        backend = next;
        host?.setBackend(next);
        return info();
      },
      async setApiKey(provider: KeyProvider, key: string) {
        const k = key.trim();
        if (!k) throw new Error("empty API key");
        await credentials.modify(provider, async () => ({ type: "api_key", key: k }));
        return { ok: true };
      },
      async setEndpoint(provider, url) {
        const u = url.trim();
        if (u && !/^https?:\/\//.test(u)) throw new Error("URL must start with http:// or https://");
        await saveSettings(provider === "ollama" ? { ollamaUrl: u || undefined } : { openaiCompatibleUrl: u || undefined });
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
