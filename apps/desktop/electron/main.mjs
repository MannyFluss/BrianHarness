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
import { BRAND, HarnessSession, ProviderHub, SessionStore, backendSpecFromEnv, createBackend, sessionTitle } from "@brianharness/core";
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
/** @type {HarnessSession | null} */
let session = null;
/** @type {Map<string, {firstUserText: string|null, topicLabel: string|null, turns: number}>} */
const titleInfo = new Map();
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

function titleFor(id) {
  const t = titleInfo.get(id);
  return t ? sessionTitle(t) : null;
}

async function newSession() {
  if (session) await session.end();
  session = new HarnessSession({ userId, backend: await ensureBackend(), store, logRawEvents: true, seed: Date.now() % 100000 });
  const d = await session.start();
  return { sessionId: session.id, director: d, hud: session.hud(), title: "New chat" };
}

function sessionList() {
  return store.listSessions().slice(0, 50).map((id) => {
    const events = store.readSession(id);
    const firstUser = events.find((e) => e.type === "user_turn");
    const start = events.find((e) => e.type === "session_start");
    return {
      id,
      title: titleFor(id) ?? (firstUser ? sessionTitle({ firstUserText: firstUser.text }) : "New chat"),
      turns: events.filter((e) => e.type === "user_turn").length,
      startedAt: start?.t ?? null,
      active: session?.id === id,
    };
  });
}

function info() {
  const s = hub.settings();
  return { backend: backend?.id ?? "…", paid: !!backend?.paid, provider: s.provider, model: s.model ?? null, dataDir, userId, platform: process.platform, appName: BRAND.name };
}

ipcMain.handle("harness:new", () => newSession());
ipcMain.handle("harness:reply", async (_e, { text, events, sentAt, shownAt }) => {
  if (!session) await newSession();
  if (typeof shownAt === "number") session.markShown(shownAt);
  const out = await session.reply(String(text), Array.isArray(events) ? events : [], typeof sentAt === "number" ? sentAt : Date.now());
  const hud = session.hud();
  const t = titleInfo.get(session.id) ?? { firstUserText: String(text), topicLabel: null, turns: 0 };
  t.turns = session.turn;
  t.topicLabel = hud.hypothesis ? session.map.label(hud.hypothesis) : null;
  titleInfo.set(session.id, t);
  return { director: out.director, hud, engagement: out.user.frame.engagement, title: sessionTitle(t) };
});
ipcMain.handle("harness:hud", () => session?.hud() ?? null);
ipcMain.handle("harness:sessions", () => sessionList());
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
  session?.setBackend(next); // swap mid-chat; the Director's state carries over
  return info();
});
ipcMain.handle("providers:apiKey", async (_e, { provider, key }) => {
  await hub.setApiKey(provider, String(key ?? ""));
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
  await session?.end();
  app.quit();
});
