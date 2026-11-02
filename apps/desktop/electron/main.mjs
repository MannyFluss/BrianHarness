// Electron shell. Window chrome mirrors LearnHarness (hiddenInset traffic lights on mac,
// #141414 background, 1440x900). The harness core runs HERE in the main process (Node);
// the renderer is a pure view that streams keystroke telemetry over IPC.
// Model providers (mock / Ollama / ChatGPT / Claude Code / Anthropic) come from ProviderHub;
// credentials live in <userData>/credentials.json, encrypted with Electron safeStorage
// (macOS: key in the login Keychain), never in the repo.
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
  BRAND, HarnessHost, ProviderHub, SessionStore, StudyController, backendSpecFromEnv, createBackend, credentialSecretStore, zipFiles,
  APP_EXTRACTOR_MAX_CALLS, DEFAULT_EXTRACTOR_PROMPT_VERSION, appTaggerSpec, kvCallCounter, normalizeOllamaBaseUrl, SPIDER_CREDENTIAL_ID, DEFAULT_OLLAMA_URL, parsePromptVersion, readApiKey,
  UploadQueue, normalizeSpiderUrl, STUDY_PROTOCOL_VERSION,
} from "@brianharness/core";
import { runDemo } from "./demo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

// One brand config: name + data dir (~/Library/Application Support/BrianHarness on macOS).
app.setName(BRAND.name);
if (!process.env.EEG_USER_DATA) app.setPath("userData", join(app.getPath("appData"), BRAND.dataDirName));
else app.setPath("userData", process.env.EEG_USER_DATA);

const dataDir = process.env.EEG_DATA_DIR ?? join(app.getPath("userData"), "data");
mkdirSync(dataDir, { recursive: true });
const store = new SessionStore(dataDir);
const userId = process.env.EEG_USER ?? "local-user";

/** @type {ProviderHub} */
let hub;
/** @type {import("@brianharness/core").ModelBackend | null} */
let backend = null;
// Session lifecycle, titles and the session list live in core's HarnessHost (shared with the
// in-process web/iOS transport), so both shells run the same logic.
// Phase D study: the sealed schedule lives in the safeStorage-encrypted credentials file (via the
// hub's credential store, resolved lazily: the hub exists once the app is ready); only the
// non-secret progress (enabled + next index) is in <userData>/study-progress.json.
const progressFile = () => join(app.getPath("userData"), "study-progress.json");
const fileKV = {
  get: async (k) => { try { return JSON.parse(readFileSync(progressFile(), "utf8"))[k] ?? null; } catch { return null; } },
  set: async (k, v) => {
    let o = {};
    try { o = JSON.parse(readFileSync(progressFile(), "utf8")); } catch {}
    o[k] = v;
    writeFileSync(progressFile(), JSON.stringify(o), { mode: 0o600 });
  },
  remove: async (k) => {
    let o = {};
    try { o = JSON.parse(readFileSync(progressFile(), "utf8")); } catch { return; }
    delete o[k];
    writeFileSync(progressFile(), JSON.stringify(o), { mode: 0o600 });
  },
  keys: async () => [],
};
// progress lives in the safeStorage credentials file next to the schedule; study-progress.json = legacy (migrated, key removed)
const study = new StudyController(credentialSecretStore({ read: (id) => hub.credentials.read(id), modify: (id, fn) => hub.credentials.modify(id, fn) }), fileKV, {
  // recovery sources if the progress is gone: local session logs + the pending-uploads ledger
  recover: async () => [...host.studyRecords(), ...(await uploads.studyRecords().catch(() => []))],
});
// launch: discard a schedule sealed under an older study protocol (practice builds); session logs untouched
study.ensureProtocol().then((r) => { if (r.reset) console.error("[brianharness] study schedule from an older protocol discarded; Start study seals a new one"); }).catch(() => {});
// dev/debug only: hash and unseal (never in a packaged build unless BH_STUDY_DEBUG=1)
const studyDebug = !app.isPackaged || process.env.BH_STUDY_DEBUG === "1";
// Topic tagger, chosen per new session (core appTaggerSpec): llm-extract (prompt v2 by default, rank lead,
// gemma4:cloud) with a real cloud provider + an Ollama Cloud key, else keyphrase-idf. Prompt rollback:
// BH_LLM_PROMPT_VERSION=v1 (env, wins) or the settings flag (providers:extractorPrompt). Network calls are
// reserved against one persisted cap (<userData>/llm-extract-calls.json, BH_LLM_MAX_CALLS, default 50).
const callsFile = () => join(app.getPath("userData"), "llm-extract-calls.json");
const callsKV = {
  get: async () => { try { return readFileSync(callsFile(), "utf8"); } catch { return null; } },
  set: async (_k, v) => writeFileSync(callsFile(), v, { mode: 0o600 }),
  remove: async () => {},
  keys: async () => [],
};
const extractorCalls = kvCallCounter(callsKV, Number(process.env.BH_LLM_MAX_CALLS ?? APP_EXTRACTOR_MAX_CALLS));
const extractorCache = new Map();
const envPromptVersion = parsePromptVersion(process.env.BH_LLM_PROMPT_VERSION);
const promptVersionSetting = () => envPromptVersion ?? parsePromptVersion(hub?.settings().extractorPromptVersion) ?? DEFAULT_EXTRACTOR_PROMPT_VERSION;
let taggerReason = "keyphrase-idf";
/** @param {{ study?: boolean }} [ctx] study sessions: per-session extractor budget; others: the device-wide counter */
async function chooseTagger(ctx = {}) {
  const s = hub.settings();
  const cloud = ["ollama-cloud", "openai", "anthropic"].includes(s.provider);
  const c = appTaggerSpec({
    provider: s.provider,
    model: s.model,
    ollamaUrl: normalizeOllamaBaseUrl(s.ollamaUrl ?? DEFAULT_OLLAMA_URL),
    ollamaCloudKey: cloud ? (process.env.OLLAMA_API_KEY || (await readApiKey(hub.credentials, "ollama-cloud").catch(() => null))) : null,
    spiderToken: s.provider === "spider-cloud" ? (process.env.BH_SPIDER_TOKEN || (await readApiKey(hub.credentials, SPIDER_CREDENTIAL_ID).catch(() => null))) : null,
    spiderUrl: s.spiderCloudUrl,
    promptVersion: promptVersionSetting(),
    counter: extractorCalls,
    study: !!ctx.study,
    cache: { get: (k) => extractorCache.get(k), set: (k, v) => void extractorCache.set(k, v) },
  });
  taggerReason = c.reason;
  return { spec: c.spec, fallback: c.fallback };
}
// ---- auto-upload queue (POST /v1/sessions): <userData>/pending-uploads/, one 0600 file per key ----
const uploadsDir = () => join(app.getPath("userData"), "pending-uploads");
const keyFile = (k) => join(uploadsDir(), encodeURIComponent(k));
const uploadKV = {
  get: async (k) => { try { return readFileSync(keyFile(k), "utf8"); } catch { return null; } },
  set: async (k, v) => { mkdirSync(uploadsDir(), { recursive: true, mode: 0o700 }); writeFileSync(keyFile(k), v, { mode: 0o600 }); },
  remove: async (k) => rmSync(keyFile(k), { force: true }),
  keys: async (p = "") => { try { return readdirSync(uploadsDir()).map(decodeURIComponent).filter((k) => k.startsWith(p)); } catch { return []; } },
};
const uploads = new UploadQueue(uploadKV, {
  meta: { appVersion: app.getVersion(), platform: `desktop-${process.platform}`, build: null },
  target: async () => {
    const token = process.env.BH_SPIDER_TOKEN || (await readApiKey(hub.credentials, SPIDER_CREDENTIAL_ID).catch(() => null));
    return token ? { url: `${normalizeSpiderUrl(hub.settings().spiderCloudUrl)}/v1/sessions`, token } : null;
  },
});
/** study sessions only: practice logs never upload */
const isStudyFile = (f) => {
  for (const line of f.content.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.type === "session_start") return !!r.study && typeof r.study === "object"; } catch {}
  }
  return false;
};
const host = new HarnessHost({ userId, storage: store, backend: () => ensureBackend(), logRawEvents: true, seed: () => Date.now() % 100000, study, tagger: chooseTagger,
  onSessionEnd: async (id) => {
    const f = host.sessionFile(id);
    if (f && isStudyFile(f)) { await uploads.enqueueSession(f).catch((e) => console.error(`[${BRAND.slug}] upload queue: ${e?.message}`)); void uploads.flush().catch(() => {}); }
  },
  onExtractorWarning: (msg, { sessionId, reason }) => console.error(`[${BRAND.slug}] ${msg} [session ${sessionId}, ${reason}]`) });
/** @type {BrowserWindow | null} */
let mainWin = null;

function keychainCipher() {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  // Linux without a keyring falls back to a hard-coded key; plain 0600 JSON is just as good there.
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text") return undefined;
  return {
    kind: "electron-safeStorage",
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, "base64")),
  };
}

async function ensureBackend() {
  if (backend) return backend;
  try {
    // EEG_BACKEND / BH_PROVIDER env override (dev, screenshots); otherwise the picker's saved choice.
    const envSpec = process.env.BH_PROVIDER || process.env.EEG_BACKEND ? backendSpecFromEnv() : null;
    backend = envSpec ? await createBackend(envSpec) : await hub.createBackend();
  } catch (err) {
    console.error(`[${BRAND.slug}] backend unavailable, falling back to mock:`, err?.message ?? err);
    backend = await createBackend({ provider: "mock" });
  }
  return backend;
}

function info() {
  const s = hub.settings();
  return {
    backend: backend?.id ?? "…", paid: !!backend?.paid, provider: s.provider, model: s.model ?? null, dataDir, userId, platform: process.platform, appName: BRAND.name,
    extractorPromptVersion: promptVersionSetting(), tagger: taggerReason,
  };
}

// Token streaming: when the renderer passes a request id (rid), deltas go back as "harness:token".
const tokenSink = (e, rid) =>
  typeof rid === "string" && rid ? { onToken: (delta) => !e.sender.isDestroyed() && e.sender.send("harness:token", { rid, delta }) } : {};
ipcMain.handle("harness:new", (e, p) => host.newSession(tokenSink(e, p?.rid)));
ipcMain.handle("harness:reply", (e, payload) => host.reply(payload ?? {}, tokenSink(e, payload?.rid)));
ipcMain.handle("harness:hud", () => host.hud());
ipcMain.handle("harness:sessions", () => host.sessions());
ipcMain.handle("harness:info", async () => {
  await ensureBackend();
  return info();
});

ipcMain.handle("harness:rate", (_e, r) => host.rate(r ?? {}));
// "Export logs": every session JSONL + the interest map, one zip through the native save dialog
ipcMain.handle("harness:exportLogs", async (e) => {
  const files = host.exportFiles();
  if (!files.length) return { ok: false, files: 0, via: "none", detail: "nothing to export yet" };
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const d = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const r = await dialog.showSaveDialog(win, { title: "Export logs", defaultPath: join(app.getPath("downloads"), `brianharness-logs-${d}.zip`), filters: [{ name: "Zip", extensions: ["zip"] }] });
  if (r.canceled || !r.filePath) return { ok: false, files: files.length, via: "save-dialog", detail: "canceled" };
  writeFileSync(r.filePath, zipFiles(files));
  return { ok: true, files: files.length, via: "save-dialog", detail: r.filePath };
});
ipcMain.handle("study:status", () => study.status());
ipcMain.handle("study:enable", async () => {
  try {
    const s = await study.enable();
    void uploads.enqueueStudyStart({ scheduleHash: s.scheduleHash, nSessions: 10, createdAt: s.createdAt, protocol: s.protocol ?? STUDY_PROTOCOL_VERSION }).then(() => uploads.flush()).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});
ipcMain.handle("study:disable", async () => (await study.disable(), { ok: true }));
ipcMain.handle("study:reissue", (_e, { n, confirm, reason }) => study.requestReissue(Number(n), String(confirm ?? ""), reason == null ? undefined : String(reason)));
ipcMain.handle("study:setNext", (_e, { n, confirm }) => study.setNext(Number(n), String(confirm ?? "")));
ipcMain.handle("study:cancelReissue", async () => (await study.cancelReissue(), { ok: true }));
ipcMain.handle("uploads:status", () => uploads.summary());
ipcMain.handle("uploads:flush", () => uploads.flush({ force: true }));
app.whenReady().then(() => uploads.flush()).catch(() => {}); // launch: retry what's left
ipcMain.handle("study:hash", () => (studyDebug ? study.hash() : null));
ipcMain.handle("study:unseal", (_e, confirm) => {
  if (!studyDebug) throw new Error("unseal is a dev/debug command (BH_STUDY_DEBUG=1)");
  return study.unseal(String(confirm ?? ""));
});

// ---- provider picker ----
ipcMain.handle("providers:status", async () => ({ providers: await hub.status(), current: info() }));
ipcMain.handle("providers:select", async (_e, { provider, model }) => {
  const next = await hub.createBackend({ provider, model: model ?? undefined }); // throws -> renderer shows it
  hub.saveSettings({ provider, model: model ?? undefined });
  backend = next;
  host.setBackend(next); // swap mid-chat; the Director's state carries over
  return info();
});
ipcMain.handle("providers:apiKey", async (_e, { provider, key }) => {
  await hub.setApiKey(provider, String(key ?? ""));
  if (provider === SPIDER_CREDENTIAL_ID) void uploads.flush().catch(() => {}); // a new token resumes a 401 pause
  return { ok: true };
});
ipcMain.handle("providers:endpoint", async (_e, { provider, url }) => {
  if (provider !== "ollama" && provider !== "spider-cloud") throw new Error("only the Ollama and Spider Cloud URLs are configurable on desktop");
  const u = String(url ?? "").trim();
  if (u && !/^https?:\/\//.test(u)) throw new Error("URL must start with http:// or https://");
  hub.saveSettings(provider === "ollama" ? { ollamaUrl: u || undefined } : { spiderCloudUrl: u || undefined });
  return { ok: true };
});
ipcMain.handle("providers:extractorPrompt", async (_e, { version }) => {
  const v = parsePromptVersion(version);
  if (!v) throw new Error("extractor prompt version must be v1 or v2");
  hub.saveSettings({ extractorPromptVersion: v === DEFAULT_EXTRACTOR_PROMPT_VERSION ? undefined : v });
  return info();
});
ipcMain.handle("providers:logout", async (_e, { provider }) => {
  await hub.logout(provider);
  return { ok: true };
});

/** @type {AbortController | null} */
let loginAbort = null;
const pendingPrompts = new Map();
let promptSeq = 0;
ipcMain.handle("providers:login", async (e, { provider }) => {
  loginAbort?.abort();
  const ac = (loginAbort = new AbortController());
  const send = (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, payload); };
  try {
    await hub.login(provider, {
      signal: ac.signal,
      notify: (ev) => {
        if (ev.type === "auth_url" && typeof ev.url === "string" && /^https:\/\//.test(ev.url)) void shell.openExternal(ev.url);
        send("auth:event", ev);
      },
      prompt: (p) =>
        new Promise((resolve, reject) => {
          const id = `p${++promptSeq}`;
          pendingPrompts.set(id, { resolve, reject });
          const onAbort = () => { pendingPrompts.delete(id); send("auth:promptDone", { id }); reject(new Error("cancelled")); };
          ac.signal.addEventListener("abort", onAbort, { once: true });
          p.signal?.addEventListener("abort", onAbort, { once: true });
          const { signal: _s, ...rest } = p;
          send("auth:prompt", { id, ...rest });
        }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: ac.signal.aborted ? "Sign-in cancelled" : String(err?.message ?? err) };
  } finally {
    if (loginAbort === ac) loginAbort = null;
  }
});
ipcMain.handle("auth:answer", (_e, { id, value }) => {
  const p = pendingPrompts.get(id);
  if (!p) return false;
  pendingPrompts.delete(id);
  p.resolve(String(value ?? ""));
  return true;
});
ipcMain.handle("providers:cancelLogin", () => {
  loginAbort?.abort();
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: Number(process.env.EEG_WIDTH ?? 1440),
    height: Number(process.env.EEG_HEIGHT ?? 900),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#141414",
    title: BRAND.name,
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
      : { titleBarStyle: "hidden", titleBarOverlay: { color: "#141414", symbolColor: "#e5e5e5", height: 59 } }),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env.EEG_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "..", "dist", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  hub = new ProviderHub({ dataDir: app.getPath("userData"), cipher: keychainCipher() });
  if (process.env.BH_STUDY_HASH === "1") console.log(`[${BRAND.slug}] study schedule sha256: ${(await study.hash()) ?? "(none yet)"}`);
  const win = (mainWin = createWindow());
  if (process.env.EEG_SCREENSHOT) {
    // headless capture for docs/CI: play a scripted demo through the REAL core, then snapshot.
    win.webContents.once("did-finish-load", async () => {
      try {
        await runDemo(win);
        await new Promise((r) => setTimeout(r, 1200));
        const img = await win.webContents.capturePage();
        writeFileSync(process.env.EEG_SCREENSHOT, img.toPNG());
        console.log(`[${BRAND.slug}] screenshot saved to ${process.env.EEG_SCREENSHOT}`);
      } catch (err) {
        console.error(`[${BRAND.slug}] screenshot failed`, err);
      } finally {
        app.quit();
      }
    });
  }
});
app.on("window-all-closed", async () => {
  await host.end();
  app.quit();
});
