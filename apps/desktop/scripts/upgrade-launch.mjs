#!/usr/bin/env node
// UPGRADE cold launch (Nov 3 2026, add-only): Manny's device after a TestFlight update from a protocol-2 build
// (1604/2031) with a study IN PROGRESS. Phase 1 builds the old install's storage with the app itself (study started,
// a study session ended -> study_start + session queued for upload, uploads refused 503), then rewrites the Keychain
// to what a protocol-2 build leaves: schedule.protocol = 2, durable progress {enabled:true, next:3} (+ legacy copy).
// Phase 2 cold-launches the new head on the same profile. Based on demo-launch.mjs of the dist-head web bundle in headless Chrome as the iOS app (fake Capacitor
// BHStream / BHKeychain / BHExport [+ BHAppleAuth]), FRESH INSTALL each run (no saved settings), against the real
// Worker code under `wrangler dev --local` + scripts/fake-upstream.mjs. https://api.strangeriver.org is rewritten to a
// local proxy inside the fake native layer. Two flavors x two viewports:
//   token: a device token already in the Keychain -> straight to chat (Spider Cloud default model)
//   siwa:  nothing stored, BHAppleAuth available -> the Sign in with Apple screen only -> stubbed success -> chat
// The device token is issued by the local admin CLI into a throwaway persist dir and never written out.
// (OLD_PROTOCOL=3 seeds a protocol-3 install instead; the new head must reset either to "not started").
// Env: DIST (bundle), OUT (screenshots + upgrade-checks.json), BASE (first of 4 local ports, default 19620),
// WORKER_ROOT (Worker checkout with scripts/fake-upstream.mjs + admin.mjs), PLAYWRIGHT_FROM, OLD_PROTOCOL,
// RACE=1 (deterministic repro: take the post-launch dump only after the backoff retry has happened).
// Check (d) "upload queue preserved": every queued body byte-identical and every index item the same upload
// (id/kind/name/bytes/createdAt/study, still pending). The retry bookkeeping (attempts, consecutive5xx, nextAt,
// lastStatus, lastError) may legitimately advance: the app retries a 503'd item on its backoff timer (30 s after
// the phase-1 attempt), which can land just before the post-launch dump on a slow launch (was a ~1-in-8 iPhone flake).
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, resolve } from "node:path";
import { createRequire } from "node:module";

const out = process.env.OUT ?? "/workspace/p0-stream/report-fixes/demo";
const OLD_PROTOCOL = Number(process.env.OLD_PROTOCOL ?? 2);
const dist = resolve(process.env.DIST ?? "/workspace/p0-stream/dist-head") + "/";
const workerRoot = process.env.WORKER_ROOT ?? "/workspace/p0-stream/wt-worker";
const base = Number(process.env.BASE ?? 19620), UP = base, W = base + 1, PX = base + 2, WEB = base + 3;
const FAKE_KEY = "up-up-" + randomBytes(12).toString("hex"), ADMIN = "up-admin-" + randomBytes(16).toString("hex");
const persist = mkdtempSync(join(tmpdir(), "up-wr-"));
const kids = []; let wlog = ""; const profiles = [];
const pw = createRequire(process.env.PLAYWRIGHT_FROM ?? "/workspace/bh-smoke/package.json")("playwright-core");
process.on("exit", () => { for (const k of kids) try { k.kill("SIGTERM"); } catch {} for (const d of [persist, ...profiles]) rmSync(d, { recursive: true, force: true }); });
const checks = []; const check = (ok, what, detail) => { checks.push({ ok: !!ok, what, ...(detail !== undefined ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`); };

kids.push(spawn(process.execPath, [join(workerRoot, "scripts/fake-upstream.mjs")], { env: { ...process.env, PORT: String(UP), FAKE_UPSTREAM_KEY: FAKE_KEY, FAKE_SCENARIO: "realistic", FAKE_DELAY_MS: "1", FAKE_SYSTEM_ONLY: "load" }, stdio: "ignore" }));
const wr = spawn(join(workerRoot, "node_modules/.bin/wrangler"), ["dev", "--local", "--ip", "127.0.0.1", "--port", String(W), "--show-interactive-dev-session=false", "--persist-to", persist,
  "--var", `UPSTREAM_BASE_URL:http://127.0.0.1:${UP}`, "--var", `OLLAMA_API_KEY:${FAKE_KEY}`, "--var", `ADMIN_SECRET:${ADMIN}`, "--var", `COUNTER_SCOPE:dm-${Date.now()}`],
  { cwd: workerRoot, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
kids.push(wr); wr.stdout.on("data", (d) => (wlog += d)); wr.stderr.on("data", (d) => (wlog += d));
for (const t = Date.now(); ;) { try { if ((await fetch(`http://127.0.0.1:${W}/healthz`)).ok) break; } catch {} if (Date.now() - t > 90000) throw new Error("wrangler\n" + wlog.slice(-1500)); await new Promise((r) => setTimeout(r, 500)); }
const issue = (label) => /token:\s+(\S+)/.exec(execFileSync(process.execPath, [join(workerRoot, "scripts/admin.mjs"), "issue", label], { env: { ...process.env, BH_API_URL: `http://127.0.0.1:${W}`, BH_ADMIN_SECRET: ADMIN }, encoding: "utf8" }))?.[1];
const setPlan = (p) => fetch(`http://127.0.0.1:${UP}/_plan`, { method: "POST", body: p });

// proxy: chat + models -> Worker; POST /v1/auth/apple -> a locally issued device token (stands in for the Worker's
// Apple verification); /v1/feedback -> 201; everything else (uploads) 503 (stays queued, nothing leaves the box)
let appleToken = null; const seen = []; const seenAt = [];
createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-expose-headers": "*" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = ""; for await (const c of req) body += c;
  const path = new URL(req.url, "http://x").pathname; seen.push(`${req.method} ${path}`); seenAt.push(Date.now());
  const json = (s, b) => res.writeHead(s, { ...cors, "content-type": "application/json" }).end(JSON.stringify(b));
  if (path === "/v1/auth/apple") return json(200, { token: appleToken, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
  if (path === "/v1/feedback") return json(201, { id: JSON.parse(body).report_id, received_at: new Date().toISOString() });
  if (!(path === "/v1/chat/completions" || path === "/v1/models")) return json(503, { error: "offline (test)" });
  const up = httpRequest({ host: "127.0.0.1", port: W, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${W}` } }, (ur) => { res.writeHead(ur.statusCode, { ...ur.headers, ...cors }); ur.pipe(res); });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, cors); res.end(); });
  up.end(body);
}).listen(PX, "127.0.0.1");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  if (p === "__parked") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>parked</title>"); // same origin, no app
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(f));
}).listen(WEB, "127.0.0.1");

const shim = ({ token, siwa, px }) => {
  const LIVE = "https://api.strangeriver.org", local = (u) => String(u).replace(LIVE, px);
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => realFetch(typeof input === "string" || input instanceof URL ? local(input) : new Request(local(input.url), input), init);
  if (token && !sessionStorage.getItem("seeded")) { localStorage.setItem("mock-keychain/credentials/spider", JSON.stringify({ type: "api_key", key: token })); sessionStorage.setItem("seeded", "1"); }
  window.__BH_APP_INFO__ = { appVersion: "0.1.0", build: "20261103.demo" };
  const listeners = []; const emit = (ev) => setTimeout(() => listeners.forEach((l) => l(ev)), 0); const ctl = {};
  const BHStream = {
    addListener: (_n, cb) => { listeners.push(cb); return { remove: () => listeners.splice(listeners.indexOf(cb), 1) }; },
    cancel: async ({ id }) => { ctl[id]?.abort(); },
    start: async ({ url, method, headers, body }) => {
      const id = Math.random().toString(36).slice(2); const ac = (ctl[id] = new AbortController());
      (async () => {
        try {
          const r = await realFetch(local(url), { method, headers, body, signal: ac.signal });
          const h = {}; r.headers.forEach((v, k) => (h[k] = v)); emit({ id, type: "head", status: r.status, headers: h });
          const rd = r.body.getReader();
          for (;;) { const { done, value } = await rd.read(); if (done) break; for (let i = 0; i < value.length;) { const k = 1 + Math.floor(Math.random() * 5); let s = ""; for (const b of value.subarray(i, i + k)) s += String.fromCharCode(b); emit({ id, type: "chunk", b64: btoa(s) }); i += k; } }
          emit({ id, type: "end" });
        } catch (e) { emit({ id, type: "error", message: String(e?.message ?? e) }); }
      })();
      return { id };
    },
  };
  const KC = "mock-keychain/", DOC = "mock-docs/";
  const BHKeychain = {
    get: async ({ key }) => ({ value: localStorage.getItem(KC + key) }),
    set: async ({ key, value }) => { localStorage.setItem(KC + key, value); },
    remove: async ({ key }) => { localStorage.removeItem(KC + key); },
    keys: async () => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith(KC)).map((k) => k.slice(KC.length)) }),
  };
  const BHExport = {
    kvGet: async ({ key }) => ({ value: localStorage.getItem(DOC + key) }),
    kvSet: async ({ key, value }) => { localStorage.setItem(DOC + key, value); },
    kvRemove: async ({ key }) => { localStorage.removeItem(DOC + key); },
    kvKeys: async ({ prefix = "" } = {}) => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith(DOC + prefix)).map((k) => k.slice(DOC.length)) }),
    share: async () => ({}), exportFiles: async () => ({}),
  };
  const b64u = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const BHAppleAuth = {
    isAvailable: async () => ({ available: true }),
    makeNonce: async () => ({ nonce: "N".repeat(43) }),
    signIn: async ({ nonce }) => { window.__siwaTaps = (window.__siwaTaps ?? 0) + 1; await new Promise((r) => setTimeout(r, 400)); return { identityToken: `${b64u({ alg: "none" })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 600, sub: "demo.user" })}.sig`, user: "demo.user", nonce }; },
    credentialState: async () => ({ state: "authorized" }),
  };
  const plugins = { BHStream, BHKeychain, BHExport, ...(siwa ? { BHAppleAuth } : {}) };
  window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => n in plugins, Plugins: plugins };
};

const proseCount = (page) => page.$$eval(".eeg-prose", (e) => e.length);
const waitIdle = (page, n) => page.waitForFunction((n) => document.querySelectorAll(".eeg-prose").length >= n && !document.querySelector("[data-streaming]") && !document.querySelector("textarea")?.readOnly && !document.querySelector("textarea")?.disabled, n, { timeout: 60000 });
const lastText = (page) => page.$$eval(".eeg-prose", (e) => e.at(-1)?.textContent?.trim() ?? "");
async function openSidebar(page) { const b = page.getByRole("button", { name: "Open sidebar" }); if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(450); } }
async function closeSidebar(page) { const b = page.getByRole("button", { name: "Close sidebar" }).last(); if (await b.isVisible().catch(() => false)) { await b.click({ force: true }); await page.waitForTimeout(300); } }
const chatReqs = async () => (await (await fetch(`http://127.0.0.1:${UP}/_history`)).json());


const dump = (page) => page.evaluate(async () => {
  const ls = {}; for (const k of Object.keys(localStorage)) ls[k] = localStorage.getItem(k);
  const db = await new Promise((ok, ko) => { const r = indexedDB.open("brianharness"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const kv = {};
  if (db.objectStoreNames.contains("kv")) await new Promise((ok) => { const rq = db.transaction("kv", "readonly").objectStore("kv").openCursor(); rq.onsuccess = () => { const c = rq.result; if (!c) return ok(); kv[String(c.key)] = typeof c.value === "string" ? c.value : JSON.stringify(c.value); c.continue(); }; });
  db.close();
  return { ls, kv };
});
const KC_SCHED = "mock-keychain/study/phaseD/schedule", KC_PROG = "mock-keychain/study/phaseD/progress";
const isDocs = (k) => k.startsWith("mock-docs/");

const park = async (page) => { await page.goto(`http://127.0.0.1:${WEB}/__parked`); await page.waitForTimeout(300); };
const footerOf = (page) => page.evaluate(() => document.body.innerText.match(/Spider Cloud · [^\n]+/)?.[0] ?? document.body.innerText.match(/· (Mock[^\n]*)/)?.[1] ?? null);
const savedSettings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("brianharness/settings") ?? "null"));
// the user picks in the model picker (the real UI): Spider Cloud gemma4 or Mock
async function pick(page, which) {
  await page.evaluate(() => window.__eegDemo.openPicker()); await page.waitForTimeout(700);
  const b = which === "mock" ? page.locator("button", { hasText: /Template Director/ }).first() : page.locator("button", { hasText: /gemma4/i }).first();
  await b.click(); await page.waitForTimeout(900);
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
}

async function run(vp, settings, tag = "", pickAfter = null) {
  const L = `upgrade-${vp.name}${tag ? "-" + tag : ""}`;
  const profile = mkdtempSync(join(tmpdir(), "up-profile-")); profiles.push(profile);
  const token = issue(`up-${L}`); if (!token) throw new Error("no token");
  const opts = { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true, bypassCSP: true, viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, hasTouch: true, isMobile: vp.name === "iphone", userAgent: vp.ua };
  // ---------- phase 1: the old install
  await setPlan("ok,ok,ok,ok,ok,ok,ok,ok,ok,ok");
  let ctx = await pw.chromium.launchPersistentContext(profile, opts);
  await ctx.addInitScript(shim, { token, siwa: false, px: `http://127.0.0.1:${PX}` });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${WEB}/`); await waitIdle(page, 1);
  await page.fill("textarea", "a plain chat before the study"); await page.keyboard.press("Enter"); await waitIdle(page, 3);
  await openSidebar(page);
  const t = page.locator("[data-study-toggle]"); await t.scrollIntoViewIfNeeded().catch(() => {});
  await t.click(); await page.waitForTimeout(900); await t.click(); await page.waitForTimeout(600);
  await page.getByRole("button", { name: "New chat" }).click(); await page.waitForTimeout(600);
  for (const sel of ['[data-rating-probe="session"]']) { const c = page.locator(sel); if (await c.isVisible().catch(() => false)) await c.getByRole("button", { name: "Skip", exact: true }).last().click(); }
  await closeSidebar(page); await waitIdle(page, 1);
  await page.fill("textarea", "a study-session turn"); await page.keyboard.press("Enter"); await waitIdle(page, 3);
  await openSidebar(page);
  await page.getByRole("button", { name: "New chat" }).click(); await page.waitForTimeout(600); // ends study session 1 -> queued upload
  { const c = page.locator('[data-rating-probe="session"]'); if (await c.isVisible().catch(() => false)) await c.getByRole("button", { name: "Skip", exact: true }).last().click(); }
  await closeSidebar(page); await waitIdle(page, 1); await page.waitForTimeout(1500);
  // what a protocol-2 build leaves: schedule sealed under protocol 2, study enabled at index 3 (+ legacy progress copy)
  await page.evaluate(({ KC_SCHED, KC_PROG, settings, OLD_PROTOCOL }) => {
    const s = JSON.parse(localStorage.getItem(KC_SCHED)); s.protocol = OLD_PROTOCOL; localStorage.setItem(KC_SCHED, JSON.stringify(s));
    const prog = JSON.stringify({ enabled: true, next: 3 });
    localStorage.setItem(KC_PROG, prog); localStorage.setItem("brianharness/study/phaseD/progress", prog);
    if (settings) localStorage.setItem("brianharness/settings", JSON.stringify(settings)); else localStorage.removeItem("brianharness/settings");
  }, { KC_SCHED, KC_PROG, settings, OLD_PROTOCOL });
  // park the tab on a same-origin non-app URL before quitting: a tab Chrome restores on the next persistent launch
  // (before the fake native shell is injected) must not boot a second, browser-mode copy of the app
  await park(page);
  const before = await dump(page);
  const tParked = Date.now();
  await ctx.close();
  const oldSessions = Object.keys(before.kv).filter((k) => before.kv[k].includes('"session_start"'));
  const oldDocs = Object.keys(before.ls).filter(isDocs);
  check(JSON.parse(before.ls[KC_SCHED]).protocol === OLD_PROTOCOL && JSON.parse(before.ls[KC_PROG]).next === 3, `${L}: old install seeded: protocol-${OLD_PROTOCOL} schedule, study in progress at index 3`);
  check(oldDocs.length >= 2, `${L}: old install has queued uploads`, oldDocs.map((k) => k.slice(10, 70)));
  check(oldSessions.some((k) => before.kv[k].includes('"study":{')), `${L}: old install has a study session log`, oldSessions.length);
  // ---------- phase 2: cold launch of the new head on the same storage
  const hBefore = (await chatReqs()).length;
  const seenAtLaunch = seen.length;
  ctx = await pw.chromium.launchPersistentContext(profile, opts);
  await ctx.addInitScript(shim, { token, siwa: false, px: `http://127.0.0.1:${PX}` });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const tLaunch = Date.now();
  await page.goto(`http://127.0.0.1:${WEB}/`); await waitIdle(page, 1); await page.waitForTimeout(1200);
  const st = await page.evaluate(() => ({ siwa: !!document.querySelector("[data-siwa-screen]"), lost: !!document.querySelector("[data-study-lost]"), rating: !!document.querySelector("[data-rating-probe]"), dialogs: [...document.querySelectorAll("[role=dialog]")].filter((d) => d.getAttribute("aria-hidden") !== "true" && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().left < innerWidth && d.getBoundingClientRect().top < innerHeight && d.getBoundingClientRect().bottom > 0).map((d) => d.getAttribute("aria-label")), footer: document.body.innerText.match(/Spider Cloud · [^\n]+/)?.[0] ?? null, prose: document.querySelectorAll(".eeg-prose").length }));
  await page.screenshot({ path: join(out, `${L}.png`) });
  // RACE=1: force the flake's ordering (dump only after the app's backoff retry has hit the 503 proxy)
  if (process.env.RACE === "1") { for (const t0 = Date.now(); Date.now() - t0 < 40000 && !seen.slice(seenAtLaunch).some((x) => /sessions/.test(x));) await new Promise((r) => setTimeout(r, 200)); await page.waitForTimeout(800); }
  const tDumpStart = Date.now();
  const after = await dump(page);
  // (a)
  const sched = after.ls[KC_SCHED] ?? null, prog = after.ls[KC_PROG] ? JSON.parse(after.ls[KC_PROG]) : null;
  check(!sched && prog && prog.enabled === false && prog.next === 1 && !after.ls["brianharness/study/phaseD/progress"], `(a) ${L}: the new protocol reset the old protocol-${OLD_PROTOCOL} study to not started (schedule cleared, progress {enabled:false,next:1}, legacy copy gone)`, { sched: sched === null ? null : sched.slice(0, 20), prog });
  await openSidebar(page);
  const tl = (await page.locator("[data-study-toggle]").textContent().catch(() => null))?.trim() ?? null;
  check(tl === "Start study", `(a) ${L}: sidebar shows "Start study"`, tl);
  await closeSidebar(page);
  // (b)
  const h = (await chatReqs()).slice(hBefore);
  check(st.prose >= 1 && !st.siwa && !st.lost && !st.rating && st.dialogs.length === 0, `(b) ${L}: lands on plain chat (no sign-in, lost banner, rating or other dialog)`, st);
  check(h.length >= 1 && h.every((x) => x.model === "gpt-oss:20b") && /gpt-oss:20b-cloud/.test(st.footer ?? ""), `(b) ${L}: on gpt-oss:20b-cloud`, { upstream: h.map((x) => x.model), footer: st.footer });
  // (c)
  const newSessions = Object.keys(after.kv).filter((k) => !oldSessions.includes(k) && after.kv[k].includes('"session_start"'));
  const ss = newSessions.map((k) => JSON.parse(after.kv[k].split("\n").find((l) => l.includes('"session_start"'))));
  check(newSessions.length === 1 && !("study" in ss[0]) && !after.kv[newSessions[0]].includes('"study":{'), `(c) ${L}: the launch session is non-study (no study assignment)`, ss.map((x) => ({ keys: Object.keys(x), backend: x.backend, t: x.t })));
  const newDocs = Object.keys(after.ls).filter((k) => isDocs(k) && !oldDocs.includes(k));
  check(newDocs.length === 0 && !Object.keys(after.ls).filter(isDocs).some((k) => !oldDocs.includes(k) && /study_start/.test(after.ls[k])), `(c) ${L}: no new study_start / upload queued at launch`, newDocs);
  // (d)
  check(oldSessions.every((k) => after.kv[k] === before.kv[k]), `(d) ${L}: old session logs byte-identical`, oldSessions.length);
  {
    const RETRY = new Set(["attempts", "consecutive5xx", "nextAt", "lastStatus", "lastError"]);
    const ix = (ls) => { try { const v = JSON.parse(ls["mock-docs/uploads/index"] ?? "[]"); return Array.isArray(v) ? v : []; } catch { return null; } };
    const bIx = ix(before.ls), aIx = ix(after.ls);
    const sameUpload = (b, a) => !!a && a.state === b.state && [...new Set([...Object.keys(b), ...Object.keys(a)])].every((k) => RETRY.has(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]))
      && (a.attempts ?? 0) >= (b.attempts ?? 0) && (a.attempts === b.attempts || a.lastStatus === 503);
    const bodiesSame = oldDocs.filter((k) => k !== "mock-docs/uploads/index").every((k) => after.ls[k] === before.ls[k]);
    const itemsSame = !!bIx && !!aIx && bIx.length === aIx.length && bIx.every((b) => sameUpload(b, aIx.find((a) => a.id === b.id)));
    const retried = (aIx ?? []).filter((a) => a.attempts !== bIx?.find((b) => b.id === a.id)?.attempts).map((a) => a.kind);
    check(bodiesSame && itemsSame, `(d) ${L}: upload queue preserved (bodies byte-identical; same items, only retry bookkeeping may advance)`, { items: oldDocs.length, retriedDuringLaunch: retried });
  }
  // diagnostics (flake investigation): which queue entry changed, field by field, and the launch timing vs nextAt
  const redact = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/bh[dr]_[A-Za-z0-9_-]+/g, "<tok>"));
  const idxOf = (ls) => { try { return JSON.parse(ls["mock-docs/uploads/index"] ?? "null"); } catch { return null; } };
  const bi = idxOf(before.ls), ai = idxOf(after.ls);
  const itemsOf = (ix) => (Array.isArray(ix) ? ix : ix?.items ?? []);
  const diag = { L, tParked, tLaunch, gapMs: tLaunch - tParked, items: itemsOf(bi).map((b) => {
    const a = itemsOf(ai).find((x) => x.id === b.id);
    const changed = Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(a ?? {})])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a?.[k])).map((k) => [k, [redact(b[k]), redact(a?.[k])]]));
    return { id: b.id.slice(0, 40), kind: b.kind, nextAtVsLaunchMs: b.nextAt - tLaunch, changed };
  }), bodies: oldDocs.filter((k) => k.includes("/body/")).map((k) => ({ k: k.slice(23, 60), same: after.ls[k] === before.ls[k], len: [before.ls[k]?.length, after.ls[k]?.length] })),
    otherKeys: oldDocs.filter((k) => !k.includes("/body/") && k !== "mock-docs/uploads/index" && after.ls[k] !== before.ls[k]).map((k) => [k, redact(before.ls[k]), redact(after.ls[k])]),
    indexOrderSame: JSON.stringify(itemsOf(bi).map((x) => x.id)) === JSON.stringify(itemsOf(ai).map((x) => x.id)),
    uploadPostsDuringLaunch: seen.slice(seenAtLaunch).filter((x) => /sessions|study/.test(x)),
    dumpAtMs: tDumpStart - tLaunch, uploadPostAtMs: seen.map((x, i) => [x, seenAt[i] - tLaunch]).slice(seenAtLaunch).filter(([x]) => /sessions/.test(x)).map(([, t]) => t) };
  console.log("DIAG", JSON.stringify(diag));
  check(errs.length === 0, `${L}: no page errors`, errs);
  check(!JSON.stringify(after.kv).includes(token), `${L}: token not in any session log`);
  // (e) the saved pick from the old install was reset once (marker written, Worker URL etc. kept)
  const sv = await savedSettings(page);
  check(settings ? sv?.pickMigration === 1 && !("provider" in sv) && !("model" in sv) && !sv.providerChosen : sv === null || sv.pickMigration === 1, `(e) ${L}: old pick ${JSON.stringify(settings)} reset once -> saved ${JSON.stringify(sv)}`);
  if (pickAfter) {
    // (f) a pick made after the upgrade survives a cold relaunch
    await pick(page, pickAfter);
    const sv2 = await savedSettings(page);
    await park(page); await ctx.close();
    const h2 = (await chatReqs()).length;
    ctx = await pw.chromium.launchPersistentContext(profile, opts);
    await ctx.addInitScript(shim, { token, siwa: false, px: `http://127.0.0.1:${PX}` });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`http://127.0.0.1:${WEB}/`); await waitIdle(page, 1); await page.waitForTimeout(1200);
    const ft = await footerOf(page), up = (await chatReqs()).slice(h2).map((x) => x.model), sv3 = await savedSettings(page);
    await page.screenshot({ path: join(out, `${L}-relaunch-${pickAfter}.png`) });
    const ok = pickAfter === "mock" ? sv3?.provider === "mock" && sv3.providerChosen && up.length === 0 && /^Mock/i.test(ft ?? "")
      : sv3?.provider === "spider-cloud" && sv3.model === "gemma4:cloud" && up.length >= 1 && up.every((m) => m === "gemma4:31b") && /gemma4:cloud/.test(ft ?? "");
    check(ok && sv3?.pickMigration === 1 && JSON.stringify(sv3) === JSON.stringify(sv2), `(f) ${L}: picked ${pickAfter} after the upgrade -> kept across a cold relaunch`, { saved: sv3, footer: ft, upstream: up });
  }
  await ctx.close();
}

// fresh install with a token (no old storage): unchanged -> gpt-oss, nothing written to settings at launch
async function freshRun(vp) {
  const L = `upgrade-${vp.name}-fresh`;
  const profile = mkdtempSync(join(tmpdir(), "up-profile-")); profiles.push(profile);
  const token = issue(`up-${L}`);
  const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true, bypassCSP: true, viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, hasTouch: true, isMobile: vp.name === "iphone", userAgent: vp.ua });
  await ctx.addInitScript(shim, { token, siwa: false, px: `http://127.0.0.1:${PX}` });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const h = (await chatReqs()).length;
  await page.goto(`http://127.0.0.1:${WEB}/`); await waitIdle(page, 1); await page.waitForTimeout(1000);
  const ft = await footerOf(page), up = (await chatReqs()).slice(h).map((x) => x.model), sv = await savedSettings(page);
  await page.screenshot({ path: join(out, `${L}.png`) });
  check(/gpt-oss:20b-cloud/.test(ft ?? "") && up.length >= 1 && up.every((m) => m === "gpt-oss:20b") && sv === null && !errs.length, `(g) ${L}: fresh install unchanged (gpt-oss, no settings written)`, { footer: ft, upstream: up, saved: sv, errs });
  await ctx.close();
}

// old install with gemma4 saved but NO token: the Sign in with Apple screen as before; after sign-in -> gpt-oss
async function siwaRun(vp) {
  const L = `upgrade-${vp.name}-siwa-gemma4`;
  const profile = mkdtempSync(join(tmpdir(), "up-profile-")); profiles.push(profile);
  appleToken = issue(`up-${L}`);
  const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true, bypassCSP: true, viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, hasTouch: true, isMobile: vp.name === "iphone", userAgent: vp.ua });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem("v2")) { localStorage.setItem("brianharness/settings", JSON.stringify({ provider: "spider-cloud", model: "gemma4:cloud" })); sessionStorage.setItem("v2", "1"); } });
  await ctx.addInitScript(shim, { token: null, siwa: true, px: `http://127.0.0.1:${PX}` });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/`);
  await page.waitForSelector("[data-siwa-screen]", { timeout: 15000 }).catch(() => {});
  const gate = await page.evaluate(() => ({ siwa: !!document.querySelector("[data-siwa-screen]"), gate: !!document.querySelector("[data-siwa-gate]"), prose: document.querySelectorAll(".eeg-prose").length }));
  await page.screenshot({ path: join(out, `${L}-1-siwa.png`) });
  check(gate.siwa && gate.prose === 0, `(h) ${L}: no token -> the Sign in with Apple screen (unchanged), no chat behind it`, gate);
  const h = (await chatReqs()).length;
  await page.getByRole("button", { name: /Sign in with Apple/ }).last().click();
  await waitIdle(page, 1); await page.waitForTimeout(1000);
  const ft = await footerOf(page), up = (await chatReqs()).slice(h).map((x) => x.model);
  await page.screenshot({ path: join(out, `${L}-2-chat.png`) });
  check(/gpt-oss:20b-cloud/.test(ft ?? "") && up.length >= 1 && up.every((m) => m === "gpt-oss:20b") && !errs.length, `(h) ${L}: after sign-in -> gpt-oss:20b-cloud (old gemma4 pick reset)`, { footer: ft, upstream: up, errs });
  await ctx.close();
}

const VPS = [
  { name: "iphone", w: 393, h: 852, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" },
  { name: "ipad", w: 1180, h: 820, ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" },
];
// iPhone: no saved settings; iPad: the old build saved provider "mock" (setEndpoint etc. persist the default)
await run(VPS[0], null);
await run(VPS[1], { provider: "mock" }, "", "gemma4");                                   // v2 Mock pick -> gpt-oss; then gemma4 picked, kept
await run(VPS[0], { provider: "spider-cloud", model: "gemma4:cloud", spiderCloudUrl: "https://api.strangeriver.org" }, "gemma4", "mock"); // v2 gemma4 -> gpt-oss; then Mock picked, kept
await run(VPS[1], { provider: "spider-cloud", model: "gemma4:cloud" }, "gemma4");
await freshRun(VPS[0]); await freshRun(VPS[1]);
await siwaRun(VPS[0]); await siwaRun(VPS[1]);
writeFileSync(join(out, "upgrade-checks.json"), JSON.stringify({ dist, checks }, null, 2));
console.log(checks.every((c) => c.ok) ? "ALL PASS" : "SOME FAILED");
process.exit(checks.every((c) => c.ok) ? 0 : 1);
