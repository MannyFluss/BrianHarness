// Electron shell. Window chrome mirrors LearnHarness (hiddenInset traffic lights on mac,
// #141414 background, 1440x900). The harness core runs HERE in the main process (Node),
// the renderer is a pure view that streams keystroke telemetry over IPC.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { HarnessSession, SessionStore, createBackendFromEnv } from "@brianharness/core";
import { runDemo } from "./demo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";
const dataDir = process.env.EEG_DATA_DIR ?? join(app.getPath("userData"), "data");
mkdirSync(dataDir, { recursive: true });
const store = new SessionStore(dataDir);
const backend = createBackendFromEnv();
const userId = process.env.EEG_USER ?? "local-user";

/** @type {HarnessSession | null} */
let session = null;
const titles = new Map(); // sessionId -> first user line

async function newSession() {
  if (session) await session.end();
  session = new HarnessSession({ userId, backend, store, logRawEvents: true, seed: Date.now() % 100000 });
  const d = await session.start();
  return { sessionId: session.id, director: d, hud: session.hud() };
}

function sessionList() {
  return store.listSessions().slice(0, 50).map((id) => {
    const events = store.readSession(id);
    const firstUser = events.find((e) => e.type === "user_turn");
    const start = events.find((e) => e.type === "session_start");
    return {
      id,
      title: titles.get(id) ?? (firstUser ? firstUser.text.slice(0, 48) : "New chat"),
      turns: events.filter((e) => e.type === "user_turn").length,
      startedAt: start?.t ?? null,
      active: session?.id === id,
    };
  });
}

ipcMain.handle("harness:new", () => newSession());
ipcMain.handle("harness:reply", async (_e, { text, events, sentAt, shownAt }) => {
  if (!session) await newSession();
  if (typeof shownAt === "number") session.markShown(shownAt);
  if (session.turn === 0) titles.set(session.id, String(text).slice(0, 48));
  const out = await session.reply(String(text), Array.isArray(events) ? events : [], typeof sentAt === "number" ? sentAt : Date.now());
  return { director: out.director, hud: session.hud(), engagement: out.user.frame.engagement };
});
ipcMain.handle("harness:hud", () => session?.hud() ?? null);
ipcMain.handle("harness:sessions", () => sessionList());
ipcMain.handle("harness:info", () => ({ backend: backend.id, paid: backend.paid, dataDir, userId, platform: process.platform }));

function createWindow() {
  const win = new BrowserWindow({
    width: Number(process.env.EEG_WIDTH ?? 1440),
    height: Number(process.env.EEG_HEIGHT ?? 900),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#141414",
    title: "EEG Harness",
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
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env.EEG_DEV_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "..", "dist", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  const win = createWindow();
  if (process.env.EEG_SCREENSHOT) {
    // headless capture for docs/CI: play a scripted demo through the REAL core, then snapshot.
    win.webContents.once("did-finish-load", async () => {
      try {
        await runDemo(win);
        await new Promise((r) => setTimeout(r, 1200));
        const img = await win.webContents.capturePage();
        writeFileSync(process.env.EEG_SCREENSHOT, img.toPNG());
        console.log(`[eeg-harness] screenshot saved to ${process.env.EEG_SCREENSHOT}`);
      } catch (err) {
        console.error("[eeg-harness] screenshot failed", err);
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
