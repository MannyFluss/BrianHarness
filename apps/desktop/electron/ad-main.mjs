// E7: the Actor/Director Mac shell ("BrianHarness Director"). Separate from the protocol-4 app (main.mjs,
// unchanged): its own entry, appId, userData and window. Runs the E6 web app (dist-ad) with the MediaPipe camera
// tracker in a Web Worker and the mock Actor/Director in-process: no LLM on the Mac, no network.
//
//   - bh-app://app/*       dist-ad (the app) and, under /gaze/, the bundled model + wasm (Resources/gaze when
//                          packaged, resources/gaze in the repo). Every request is logged as a bundle load.
//   - network              every http(s)/ws(s) request from any webContents is CANCELLED and logged.
//   - camera               systemPreferences camera status / askForMediaAccess; Chromium "media" permission is
//                          granted for video only, to bh-app://app, and logged.
//   - H1 report            --h1-report[=<file>] [--h1-seconds=N] [--h1-calibrate]: runs the tracker for N s
//                          (default 120), samples app.getAppMetrics() every 2 s, writes JSON and quits.
//                          Without --h1-report the app just runs (Hermes can use it by hand).
import { app, BrowserWindow, ipcMain, protocol, screen, session, systemPreferences } from "electron";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "BrianHarness Director";
app.setName(APP_NAME);
app.setPath("userData", process.env.BH_AD_USER_DATA ?? join(app.getPath("appData"), "BrianHarness-Director"));

const argv = process.argv.slice(1);
const flag = (k) => argv.find((a) => a === k || a.startsWith(k + "="));
const val = (k, d) => { const f = flag(k); return f && f.includes("=") ? f.slice(k.length + 1) : d; };
const H1 = !!flag("--h1-report");
const H1_FILE = val("--h1-report", join(app.getPath("userData"), `h1-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const H1_SECONDS = Number(val("--h1-seconds", "120"));
const H1_CAL = !!flag("--h1-calibrate");

const APP_DIR = join(here, "..", "dist-ad");
const GAZE_DIR = app.isPackaged ? join(process.resourcesPath, "gaze") : join(here, "..", "resources", "gaze");
const ORIGIN = "bh-app://app";
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; media-src 'self' blob: mediastream:; connect-src 'self'; base-uri 'self'; form-action 'none'";

// ---- what the H1 report collects -------------------------------------------------------------------
const t0 = Date.now();
const log = { network: [], bundle: [], permissions: [], renderer: [], metrics: [], errors: [] };
const MAX = 2000;
const push = (arr, v) => { if (arr.length < MAX) arr.push(v); };
const rel = () => Date.now() - t0;
let lastRenderer = null;

// smoke runs without a camera (CI / the Linux build box): Chromium's fake capture device (a moving test pattern,
// no face). Never set on the Mac for H1.
if (process.env.BH_AD_FAKE_CAMERA === "1") { app.commandLine.appendSwitch("use-fake-device-for-media-stream"); app.commandLine.appendSwitch("use-fake-ui-for-media-stream"); }
// headless Linux has no GPU: software WebGL so the MediaPipe GPU path can be smoke-tested (never needed on the Mac)
if (process.env.BH_AD_SWIFTSHADER === "1") { app.commandLine.appendSwitch("use-angle", "swiftshader"); app.commandLine.appendSwitch("enable-unsafe-swiftshader"); app.commandLine.appendSwitch("ignore-gpu-blocklist"); }
protocol.registerSchemesAsPrivileged([{ scheme: "bh-app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".gz": "application/gzip", ".task": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(req) {
  const u = new URL(req.url);
  const path = decodeURIComponent(u.pathname);
  const [root, sub] = path.startsWith("/gaze/") ? [GAZE_DIR, path.slice("/gaze/".length)] : [APP_DIR, path.slice(1) || "ad.html"];
  const f = normalize(join(root, sub));
  if (!(f === root || f.startsWith(root + sep)) || !existsSync(f)) { push(log.bundle, { t: rel(), path, status: 404 }); return new Response("not found", { status: 404 }); }
  push(log.bundle, { t: rel(), path, status: 200, bytes: statSync(f).size });
  const ext = f.slice(f.lastIndexOf("."));
  // read with fs (not net.fetch(file://), which would go through the network guard)
  return readFile(f).then((b) => new Response(b, { status: 200, headers: { "content-type": MIME[ext] ?? "application/octet-stream", "content-security-policy": CSP } }));
}

function guardNetwork(ses) {
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, cb) => {
    const scheme = d.url.split(":")[0];
    if (scheme === "bh-app" || scheme === "devtools" || scheme === "data" || scheme === "blob" || scheme === "chrome-extension") return cb({});
    let where = d.url; try { const u = new URL(d.url); where = u.origin + u.pathname; } catch {}
    push(log.network, { t: rel(), url: where, method: d.method, resourceType: d.resourceType, action: "cancelled" });
    cb({ cancel: true });
  });
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl ?? wc.getURL()).origin; } catch { return ""; } })();
    const media = permission === "media" && origin === ORIGIN && !(details.mediaTypes ?? []).includes("audio");
    push(log.permissions, { t: rel(), permission, mediaTypes: details.mediaTypes ?? [], origin, granted: media });
    cb(media);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && origin === ORIGIN);
}

const mapPermission = (s) => (s === "granted" ? "granted" : s === "denied" ? "denied" : s === "restricted" ? "restricted" : "prompt");
const cameraStatus = () => (process.platform === "darwin" ? mapPermission(systemPreferences.getMediaAccessStatus("camera")) : "granted");
ipcMain.handle("ad:camera-permission", () => cameraStatus());
ipcMain.handle("ad:camera-request", async () => {
  const before = cameraStatus();
  let after = before;
  if (process.platform === "darwin" && before === "prompt") after = (await systemPreferences.askForMediaAccess("camera")) ? "granted" : "denied";
  else after = cameraStatus();
  push(log.permissions, { t: rel(), permission: "macos.camera", before, after });
  return after;
});
let win = null;
ipcMain.handle("ad:screen", () => {
  const d = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const c = win?.getContentBounds() ?? { x: 0, y: 0, width: d.size.width, height: d.size.height };
  const mm = Number(process.env.BH_SCREEN_WIDTH_MM ?? "") || null;
  return { deviceModel: "Mac" + process.arch /* contract: "Mac" + process.arch */, platform: "mac", orientation: "landscape_left", widthPt: d.size.width, heightPt: d.size.height, scale: d.scaleFactor, webview: { x: c.x - d.bounds.x, y: c.y - d.bounds.y, width: c.width, height: c.height }, widthMm: mm };
});
ipcMain.on("ad:h1", (_e, r) => { lastRenderer = r; push(log.renderer, { t: rel(), fps: r?.stats?.fps ?? null, state: r?.status?.state ?? null, code: r?.status?.code ?? null }); });

function sampleMetrics() {
  const ms = app.getAppMetrics();
  const byType = {};
  let cpu = 0, mem = 0;
  for (const m of ms) {
    const c = m.cpu?.percentCPUUsage ?? 0, w = (m.memory?.workingSetSize ?? 0) / 1024;
    cpu += c; mem += w;
    const k = m.type; byType[k] = byType[k] ?? { cpu: 0, memMB: 0, n: 0 }; byType[k].cpu += c; byType[k].memMB += w; byType[k].n++;
  }
  push(log.metrics, { t: rel(), cpuPct: Math.round(cpu * 10) / 10, memMB: Math.round(mem), byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { cpu: Math.round(v.cpu * 10) / 10, memMB: Math.round(v.memMB), n: v.n }])), sysFreeMB: Math.round(os.freemem() / 2 ** 20) });
}

const stat = (xs) => { const s = [...xs].filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, min: s[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: s[s.length - 1], mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 }; };

function report() {
  const r = lastRenderer ?? {};
  const stats = r.stats ?? {};
  const warm = (stats.fpsWindows ?? []).slice(5); // first 5 s = model warm-up
  const fps = stat(warm.length ? warm : stats.fpsWindows ?? []);
  const steady = log.metrics.filter((m) => m.t > 10000);
  const cpu = stat((steady.length ? steady : log.metrics).map((m) => m.cpuPct));
  const mem = stat((steady.length ? steady : log.metrics).map((m) => m.memMB));
  const gazeBundle = log.bundle.filter((b) => b.path.startsWith("/gaze/"));
  const health = [...new Set([...(stats.codes ?? []), ...(r.health ?? []), ...(r.status?.code ? [r.status.code] : [])])];
  const failures = [];
  if (!lastRenderer) failures.push({ what: "renderer never reported", cause: log.errors[0]?.message ?? "app did not start the tracker (see errors)" });
  if (r.status?.permission && r.status.permission !== "granted") failures.push({ what: "camera permission", cause: `gaze.camera_denied (permission ${r.status.permission}): System Settings > Privacy & Security > Camera > ${APP_NAME}` });
  if (r.status?.state === "error") failures.push({ what: "tracker error", cause: r.status.code ?? "unknown" });
  if (!stats.modelSha256) failures.push({ what: "model not loaded", cause: (gazeBundle.some((b) => b.status === 404) ? "gaze.model_missing: bundle file missing (Resources/gaze)" : (stats.errors ?? [])[0] ?? "gaze.model_missing: see errors") });
  if (fps && fps.median < 25) failures.push({ what: `fps median ${fps.median} < 25`, cause: `inference ${Math.round(stats.inferMsMean ?? 0)} ms/frame on ${stats.delegate ?? "?"}; faces ${stats.faces}/${stats.frames}` });
  if (log.network.length) failures.push({ what: `${log.network.length} network request(s) attempted (all cancelled)`, cause: [...new Set(log.network.map((n) => n.url))].slice(0, 5).join(", ") });
  return {
    schema: "bh-h1-report/1", app: APP_NAME, version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged,
    machine: { platform: process.platform, arch: process.arch, os: os.release(), cpus: os.cpus()[0]?.model ?? null, cores: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 2 ** 20) },
    ran: { seconds: Math.round(rel() / 1000), requested: H1_SECONDS, calibrated: !!r.calibrated },
    camera: { macos: cameraStatus(), tracker: r.status?.permission ?? null, requests: log.permissions },
    model: { dir: GAZE_DIR, files: gazeManifest(), loadedSha256: stats.modelSha256 ?? null, loadMs: stats.modelMs ?? null, delegate: stats.delegate ?? null, bundleLoads: gazeBundle },
    network: { requests: log.network.length, log: log.network, workerBlocked: stats.blocked ?? [] },
    fps: { ...(fps ?? {}), frames: stats.frames ?? 0, faces: stats.faces ?? 0, inferMsMean: stats.inferMsMean ? Math.round(stats.inferMsMean * 10) / 10 : null, windows: stats.fpsWindows ?? [] },
    cpu: { note: "sum of percentCPUUsage over all app processes (100 = one core), after the first 10 s", ...(cpu ?? {}) },
    memory: { note: "sum of workingSetSize over all app processes, MB, after the first 10 s", ...(mem ?? {}) },
    metrics: log.metrics,
    health,
    trackerErrors: stats.errors ?? [],
    errors: log.errors,
    done: { fps25: !!fps && fps.median >= 25, cpuMem: !!cpu && !!mem, noTrackerNetwork: log.network.length === 0, failures },
  };
}
function gazeManifest() {
  return ["face_landmarker.task", "vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"].map((n) => {
    const f = join(GAZE_DIR, n);
    if (!existsSync(f)) return { name: n, present: false };
    const b = readFileSync(f);
    return { name: n, present: true, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: "#0a0a0a", title: APP_NAME,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: { preload: join(here, "ad-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    show: false,
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") push(log.errors, { t: rel(), level: e.level, message: String(e.message).slice(0, 400) }); });
  win.webContents.on("render-process-gone", (_e, d) => push(log.errors, { t: rel(), message: `renderer gone: ${d.reason}` }));
  const q = new URLSearchParams({ tracker: "mediapipe", ...(H1 ? { h1: "1" } : {}), ...(H1_CAL || flag("--calibrate") ? { calibrate: "1" } : {}) });
  void win.loadURL(`${ORIGIN}/ad.html?${q}`);
}

app.whenReady().then(() => {
  protocol.handle("bh-app", serve);
  guardNetwork(session.defaultSession);
  app.on("session-created", guardNetwork);
  createWindow();
  if (H1) {
    // with --h1-calibrate the clock starts once calibration is done (the renderer reports calibrated:true) or after 120 s
    const metrics = setInterval(sampleMetrics, 2000);
    const startAt = Date.now();
    const finish = () => {
      clearInterval(metrics);
      const out = report();
      mkdirSync(dirname(H1_FILE), { recursive: true });
      writeFileSync(H1_FILE, JSON.stringify(out, null, 1));
      const d = out.done;
      console.log(`[h1] report: ${H1_FILE}`);
      console.log(`[h1] fps median ${out.fps.median ?? "n/a"} | cpu median ${out.cpu.median ?? "n/a"}% | mem median ${out.memory.median ?? "n/a"} MB | network ${out.network.requests} | health ${out.health.join(",") || "none"}`);
      console.log(`[h1] done-when: fps>=25 ${d.fps25} | cpu+mem ${d.cpuMem} | no tracker network ${d.noTrackerNetwork}${d.failures.length ? " | failures: " + d.failures.map((f) => `${f.what} <- ${f.cause}`).join("; ") : ""}`);
      app.quit();
    };
    const wait = () => {
      if (H1_CAL && !lastRenderer?.calibrated && Date.now() - startAt < 180000) { setTimeout(wait, 1000); return; }
      setTimeout(finish, H1_SECONDS * 1000);
    };
    wait();
  }
});
app.on("window-all-closed", () => app.quit());
