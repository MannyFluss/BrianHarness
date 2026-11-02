// Electron shell. Window chrome mirrors LearnHarness (hiddenInset traffic lights on mac,
// #141414 background, 1440x900). The harness core runs HERE in the main process (Node);
// the renderer is a pure view that streams keystroke telemetry over IPC.
// Model providers (mock / Ollama / ChatGPT / Claude Code / Anthropic) come from ProviderHub;
// credentials live in <userData>/credentials.json, encrypted with Electron safeStorage
// (macOS: key in the login Keychain), never in the repo.
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { BRAND, HarnessHost, ProviderHub, SessionStore, backendSpecFromEnv, createBackend } from "@brianharness/core";
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
const host = new HarnessHost({ userId, storage: store, backend: () => ensureBackend(), logRawEvents: true, seed: () => Date.now() % 100000 });
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
  return { backend: backend?.id ?? "…", paid: !!backend?.paid, provider: s.provider, model: s.model ?? null, dataDir, userId, platform: process.platform, appName: BRAND.name };
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
  return { ok: true };
});
ipcMain.handle("providers:endpoint", async (_e, { provider, url }) => {
  if (provider !== "ollama") throw new Error("only the Ollama URL is configurable on desktop");
  const u = String(url ?? "").trim();
  if (u && !/^https?:\/\//.test(u)) throw new Error("URL must start with http:// or https://");
  hub.saveSettings({ ollamaUrl: u || undefined });
  return { ok: true };
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
