#!/usr/bin/env node
// Live check of the empty-opener fix (Nov 3 2026): the web build in headless Chrome, iOS-like (fake Capacitor
// BHStream + mock Keychain), talking to Spider Cloud through a local Node proxy. One study-session OPENER per arm
// (adaptive, baseline) x model (gpt-oss:20b-cloud, gpt-oss:120b-cloud) = 4 chat requests, no user turns. Each opener
// must end the request with the user cue "(session start)", finish with "stop", have non-empty content and
// completion_tokens > 0, and show in the UI with no error notice.
//
//   BH_TEST_TOKEN=bhd_… PLAYWRIGHT_CORE=<dir of playwright-core> node apps/desktop/scripts/verify-opener.mjs
//   node apps/desktop/scripts/verify-opener.mjs --dry-run [--worker <brianharness-worker dir, branch p0-empty-opener>]
//   options: --dist <web build> (default apps/desktop/dist-web), --out <base dir>, --models a,b (<= 2), --port-base n,
//            --timeout-ms n (per opener, default 240000), --probe-typing (try to type during the reasoning phase and
//            after the reply; never sends), dry run only: --reasoning-delay-ms n (fake-upstream FAKE_DELAY_MS after every 1-9 byte
//            write; gpt-oss thinks 180 tokens first, so n = 1 gives ~3-5 s of reasoning before the first content token)
//   output: a NEW timestamped folder <base>/<YYYYMMDD-HHMMSS> (nothing existing is deleted)
//
// Each page's requests go to http://127.0.0.1:<proxy>/p/<page tag>/v1/…, so every request is matched to its page
// by tag (not by arrival order). A page is done when (1) the proxy saw that page's opener stream end, (2) the app
// logged director_turn 0, and (3) the UI is idle (no thinking indicator, no streaming reply, data-busy false); only
// then the screenshot, and the next page starts only after the previous page's stream ended. A UI timeline per page
// (request start, first reasoning / content chunk, thinking indicator, first token on screen, complete, composer
// unlocked, first key) is written to timeline-<tag>.json, and the run checks the composer is locked while busy.
//
// Safety (same conditions as verify-live-stream.mjs):
//   - network: the page may reach ONLY 127.0.0.1 (anything else is aborted and fails the run). The proxy forwards ONLY
//     POST /v1/chat/completions, ONLY to https://api.strangeriver.org (dry run: the local wrangler dev). /v1/models and
//     study uploads (/v1/sessions…) are answered locally (never forwarded); any other path is refused and fails the run.
//   - at most MAX_LIVE = 4 chat requests reach the upstream, and at most ONE per page: a second request from a page
//     (e.g. the empty-completion retry, i.e. the fix did not work) is refused locally 403 and fails the run.
//   - extractor calls (response_format/format) are refused and fail the run (no user turns are sent anyway).
//   - the token never enters the browser (placeholder credential; the proxy swaps in Authorization). It is never
//     printed or written; HAR/trace keep no Authorization/cookie headers; last step greps every output for "bhd_".
//   - study arms: each page starts with a TEST schedule seeded in the mock Keychain of a throwaway browser profile
//     (order adaptive, baseline, …; progress next = 1 or 2), so the launch session is a study session of a known arm.
//     Nothing is uploaded; it never touches a real participant schedule.
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes("--dry-run");
const LIVE_ORIGIN = "https://api.strangeriver.org";
const MAX_LIVE = 4;
const MODELS = (arg("--models", "gpt-oss:20b-cloud,gpt-oss:120b-cloud")).split(",").filter(Boolean);
const ARMS = ["adaptive", "baseline"];
if (MODELS.length * ARMS.length > MAX_LIVE) { console.error(`at most ${MAX_LIVE} openers (models x 2 arms)`); process.exit(2); }
const dist = resolve(arg("--dist", new URL("../dist-web/", import.meta.url).pathname)) + "/";
const OUT_BASE = resolve(arg("--out", DRY ? "/workspace/p0-stream/live-opener/dry-run" : "/workspace/p0-stream/live-opener"));
const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace(/[-: ]/g, (c) => (c === " " ? "-" : "")).slice(0, 15);
const OUT = join(OUT_BASE, stamp + (arg("--label", "") ? `-${arg("--label")}` : ""));
const TIMEOUT = Number(arg("--timeout-ms", 240_000));
const PROBE_TYPING = argv.includes("--probe-typing");
const REASONING_DELAY = DRY ? Number(arg("--reasoning-delay-ms", 0)) : 0;
if (!DRY && argv.includes("--reasoning-delay-ms")) { console.error("--reasoning-delay-ms is a dry-run option"); process.exit(2); }
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
const base = Number(arg("--port-base", 18770));
const UP = base, W = base + 1, PX = base + 2, WEB = base + 3;

let TOKEN = DRY ? null : process.env.BH_TEST_TOKEN?.trim() || null;
const failures = [];
const fail = (m) => { failures.push(m); console.error(`FAIL: ${redact(m)}`); };
const redact = (s) => { let t = String(s); if (TOKEN) t = t.split(TOKEN).join("[REDACTED]"); return t.replace(/bhd_[A-Za-z0-9_-]+/g, "[REDACTED]"); };
const log = (...a) => console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));

if (!DRY && !TOKEN) { console.error("BH_TEST_TOKEN is not set (or use --dry-run)"); process.exit(2); }
if (!existsSync(join(dist, "index.html"))) { console.error(`no web build at ${dist} (npm run build:web)`); process.exit(2); }
if (!existsSync(chrome)) { console.error(`no Chrome at ${chrome} (set CHROME)`); process.exit(2); }
let pw;
try { pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core"); }
catch { console.error("playwright-core not found (set PLAYWRIGHT_CORE to its directory)"); process.exit(2); }
if (existsSync(OUT)) { console.error(`output folder exists already: ${OUT}`); process.exit(2); }
mkdirSync(OUT, { recursive: true }); // a fresh subfolder; earlier runs are kept

// ---- upstream: live Spider Cloud, or (dry run) wrangler dev + fake-upstream with a throwaway local token
const kids = []; let persist = null;
const cleanup = () => { for (const k of kids) try { k.kill("SIGTERM"); } catch {} if (persist) rmSync(persist, { recursive: true, force: true }); };
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
let UPSTREAM = LIVE_ORIGIN;
if (DRY) {
  const worker = resolve(arg("--worker", process.env.BH_WORKER_DIR ?? "/workspace/brianharness-worker"));
  const fakeKey = "dry-up-" + randomBytes(12).toString("hex"), admin = "dry-admin-" + randomBytes(16).toString("hex");
  persist = mkdtempSync(join(tmpdir(), "bh-verify-"));
  // FAKE_SYSTEM_ONLY=load: a system-only request gets the live behaviour (one empty done chunk, no counts), so an
  // unfixed build fails the dry run exactly like it fails live (needs the Worker branch p0-empty-opener fake-upstream)
  kids.push(spawn(process.execPath, [join(worker, "scripts/fake-upstream.mjs")], { env: { ...process.env, PORT: String(UP), FAKE_UPSTREAM_KEY: fakeKey, FAKE_SCENARIO: "realistic", FAKE_DELAY_MS: String(REASONING_DELAY), FAKE_SYSTEM_ONLY: "load" }, stdio: "ignore" }));
  let wlog = "";
  const wr = spawn(join(worker, "node_modules/.bin/wrangler"), ["dev", "--local", "--ip", "127.0.0.1", "--port", String(W), "--show-interactive-dev-session=false", "--persist-to", persist,
    "--var", `UPSTREAM_BASE_URL:http://127.0.0.1:${UP}`, "--var", `OLLAMA_API_KEY:${fakeKey}`, "--var", `ADMIN_SECRET:${admin}`, "--var", `COUNTER_SCOPE:verify-${Date.now()}`],
  { cwd: worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(wr); wr.stdout.on("data", (d) => (wlog += d)); wr.stderr.on("data", (d) => (wlog += d));
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(`http://127.0.0.1:${W}/healthz`)).ok) break; } catch {} if (Date.now() - t0 > 90_000) { console.error("wrangler dev did not start\n" + redact(wlog.slice(-1500))); process.exit(2); } await new Promise((r) => setTimeout(r, 300)); }
  const issued = execFileSync(process.execPath, [join(worker, "scripts/admin.mjs"), "issue", "verify-opener-dry-run"], { env: { ...process.env, BH_API_URL: `http://127.0.0.1:${W}`, BH_ADMIN_SECRET: admin }, encoding: "utf8" });
  TOKEN = /token:\s+(\S+)/.exec(issued)?.[1] ?? null;
  if (!TOKEN) { console.error("dry run: the local admin CLI issued no token"); process.exit(2); }
  UPSTREAM = `http://127.0.0.1:${W}`;
}
const upURL = new URL(UPSTREAM);
const upstreamAllowed = (u) => (DRY ? u.hostname === "127.0.0.1" && u.port === String(W) : u.origin === LIVE_ORIGIN);
if (!upstreamAllowed(upURL)) { console.error("refusing upstream " + upURL.origin); process.exit(2); }

// ---- proxy: page -> (localhost) -> UPSTREAM, Authorization swapped in here, request caps, wire trace
const trace = join(OUT, "trace.jsonl"); writeFileSync(trace, "");
const tlog = (o) => appendFileSync(trace, redact(JSON.stringify({ t: new Date().toISOString(), ...o })) + "\n");
let live = 0, localOnly = 0;
const TAGS = new Set(); // page tags of this run (/p/<tag>/…)
const perPage = new Map(); // tag -> chat requests forwarded
const inflight = new Map(); // tag -> streams not yet ended
const chats = []; // one record per ended chat request, with its tag
const wire = new Map(); // tag -> { reqAt, firstReasoningAt, firstContentAt, endAt } (epoch ms, this machine)
const px = createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-expose-headers": "*" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = ""; for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const m = /^\/p\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
  const tag = m?.[1] ?? null, path = m?.[2] ?? url.pathname;
  const deny = (why) => { fail(`proxy refused ${req.method} ${path} (page ${tag}): ${why}`); tlog({ dir: "refused", page: tag, method: req.method, path, why }); res.writeHead(403, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: `verify-opener: ${why}` })); };
  if (!tag || !TAGS.has(tag)) return deny("request without a known page tag");
  if (req.method === "GET" && path === "/v1/models") { localOnly++; tlog({ dir: "local", page: tag, path }); return res.writeHead(503, { ...cors, "content-type": "application/json" }).end('{"error":"verify-opener: answered locally"}'); }
  if (path.startsWith("/v1/sessions")) { localOnly++; tlog({ dir: "local", page: tag, method: req.method, path: "/v1/sessions…" }); return res.writeHead(503, { ...cors, "content-type": "application/json" }).end('{"error":"verify-opener: uploads stay queued"}'); }
  if (!(req.method === "POST" && path === "/v1/chat/completions")) return deny("path not allowed");
  let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch {}
  if (parsed?.response_format || parsed?.format) return deny("extractor call");
  if ((perPage.get(tag) ?? 0) >= 1) return deny(`second chat request from page ${tag} (an empty-completion retry: the opener came back empty)`);
  if (live >= MAX_LIVE) return deny(`live request cap ${MAX_LIVE} reached`);
  const target = new URL(path, UPSTREAM);
  if (!upstreamAllowed(target)) return deny("host not allowed: " + target.host);
  perPage.set(tag, (perPage.get(tag) ?? 0) + 1);
  inflight.set(tag, (inflight.get(tag) ?? 0) + 1);
  const n = ++live; // counted when the request STARTS, so slow streams can never get past the cap
  const roles = parsed?.messages?.map((x) => x.role) ?? [];
  const cue = parsed?.messages?.at(-1)?.role === "user" ? parsed.messages.at(-1).content : null;
  const w = { reqAt: Date.now(), firstReasoningAt: null, firstContentAt: null, endAt: null }; wire.set(tag, w);
  tlog({ n, page: tag, dir: "req", model: parsed?.model, stream: parsed?.stream, max_tokens: parsed?.max_tokens, roles, last_user: cue, chars: parsed?.messages?.map((x) => String(x.content ?? "").length) });
  const headers = { "content-type": "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${TOKEN}`, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) };
  const mod = target.protocol === "https:" ? httpsRequest : httpRequest;
  const t0 = w.reqAt;
  const done = (r) => { if (w.endAt !== null) return; w.endAt = Date.now(); inflight.set(tag, (inflight.get(tag) ?? 1) - 1); chats.push(r); tlog({ dir: "end", ...r }); };
  const up = mod(target, { method: "POST", headers }, (ur) => {
    const h = { ...ur.headers }; delete h["set-cookie"];
    res.writeHead(ur.statusCode, { ...h, ...cors });
    const parts = []; let ttfb = null, carry = "";
    ur.on("data", (c) => {
      if (ttfb === null) ttfb = Date.now() - t0;
      parts.push(c); res.write(c);
      carry += c.toString("utf8"); const lines = carry.split("\n"); carry = lines.pop() ?? "";
      for (const l of lines) { if (!l.startsWith("data:")) continue; try { const d = JSON.parse(l.slice(5)).choices?.[0]?.delta ?? {}; if (d.reasoning_content && !w.firstReasoningAt) w.firstReasoningAt = Date.now(); if (d.content && !w.firstContentAt) w.firstContentAt = Date.now(); } catch {} }
    });
    ur.on("end", () => {
      res.end();
      const text = Buffer.concat(parts).toString("utf8");
      const ev = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      let content = "", reasoning = 0; const fin = []; let usage = null, error = null;
      for (const e of ev) { if (e === "[DONE]") continue; try { const o = JSON.parse(e); if (o.error) error = o.error; const d = o.choices?.[0]?.delta ?? {}; content += d.content ?? ""; if (d.reasoning_content) reasoning++; if (o.choices?.[0]?.finish_reason) fin.push(o.choices[0].finish_reason); if (o.usage) usage = o.usage; } catch {} }
      done({ n, page: tag, model: parsed?.model, roles, last_user: cue, status: ur.statusCode, ttfb_ms: ttfb, ms: Date.now() - t0, bytes: Buffer.byteLength(text), sse_events: ev.length, done: ev.at(-1) === "[DONE]", finish_reason: fin.at(-1) ?? null, reasoning_events: reasoning, content_words: content.trim() ? content.trim().split(/\s+/).length : 0, content_head: content.slice(0, 80), usage, error });
    });
    ur.on("error", (e) => { tlog({ n, page: tag, dir: "error", message: e.message }); done({ n, page: tag, model: parsed?.model, roles, last_user: cue, status: ur.statusCode, error: e.message }); });
  });
  up.on("error", (e) => { tlog({ n, page: tag, dir: "error", message: e.message }); if (!res.headersSent) res.writeHead(502, cors); res.end(); done({ n, page: tag, model: parsed?.model, roles, last_user: cue, status: 502, error: e.message }); });
  up.end(body || undefined);
}).listen(PX, "127.0.0.1");
const until = async (what, fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)); } };

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(WEB, "127.0.0.1");

// iOS-like shell: BHStream (base64 chunks like the Swift plugin), mock Keychain seeded with a TEST study schedule.
const shim = ({ settings, order, next }) => {
  if (sessionStorage.getItem("verify-opener-seeded")) return; // seed once per page (reloads keep the state)
  sessionStorage.setItem("verify-opener-seeded", "1");
  localStorage.setItem("brianharness/settings", JSON.stringify(settings));
  localStorage.setItem("brianharness/credentials/spider", JSON.stringify({ type: "api_key", key: "proxy-swaps-in-the-real-token" }));
  localStorage.setItem("brianharness/llm-extract/calls", JSON.stringify({ calls: 50, max: 50 })); // extractor off
  localStorage.setItem("mock-keychain/study/phaseD/schedule", JSON.stringify({ study: "phaseD", version: 1, seed: 1, order, createdAt: new Date().toISOString(), protocol: 3 }));
  localStorage.setItem("mock-keychain/study/phaseD/progress", JSON.stringify({ enabled: true, next }));
};
const native = () => {
  const listeners = []; const emit = (ev) => setTimeout(() => listeners.forEach((l) => l(ev)), 0); const ctl = {};
  const BHStream = {
    addListener: (_n, cb) => { listeners.push(cb); return { remove: () => listeners.splice(listeners.indexOf(cb), 1) }; },
    cancel: async ({ id }) => { ctl[id]?.abort(); },
    start: async ({ url, method, headers, body }) => {
      const id = Math.random().toString(36).slice(2); const ac = (ctl[id] = new AbortController());
      (async () => {
        try {
          const r = await fetch(url, { method, headers, body, signal: ac.signal });
          const h = {}; r.headers.forEach((v, k) => (h[k] = v)); emit({ id, type: "head", status: r.status, headers: h });
          const rd = r.body.getReader();
          for (;;) { const { done, value } = await rd.read(); if (done) break; let s = ""; for (const b of value) s += String.fromCharCode(b); emit({ id, type: "chunk", b64: btoa(s) }); }
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
  const plugins = { BHStream, BHKeychain, BHExport };
  window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => n in plugins, Plugins: plugins };
};
// UI timeline (epoch ms): thinking indicator, first token on screen, reply complete (data-streaming removed: the
// commit that stamps completeAt), data-busy, composer lock (textarea readOnly/disabled), every input event
const observer = () => {
  const T = (window.__timeline = []); const mark = (k, extra) => T.push({ k, t: Date.now(), ...(extra ?? {}) });
  let last = {};
  const look = () => {
    const ta = document.querySelector("textarea");
    const now = { thinking: !!document.querySelector("[data-typing-indicator]"), streaming: !!document.querySelector("[data-streaming]"),
      busy: document.querySelector("[data-busy]")?.getAttribute("data-busy") ?? null, locked: ta ? ta.readOnly || ta.disabled : null };
    let changed = false; for (const k of Object.keys(now)) if (now[k] !== last[k]) changed = true;
    if (changed) for (const k of Object.keys(now)) if (now[k] !== last[k]) mark(`${k}=${now[k]}`, { busy: now.busy, locked: now.locked, thinking: now.thinking, streaming: now.streaming });
    last = now;
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-busy", "data-streaming", "readonly", "disabled"] });
  document.addEventListener("input", (e) => { if (e.target instanceof HTMLTextAreaElement) mark("input", { busy: last.busy, thinking: last.thinking, streaming: last.streaming, locked: last.locked }); }, true);
};
const sessionLog = (page) => page.evaluate(async () => {
  const db = await new Promise((ok, ko) => { const r = indexedDB.open("brianharness"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const out = [];
  if (db.objectStoreNames.contains("kv")) await new Promise((ok) => { const tx = db.transaction("kv", "readonly"); const rq = tx.objectStore("kv").openCursor(); rq.onsuccess = () => { const c = rq.result; if (!c) return ok(); if (String(c.key).startsWith("sessions/")) out.push(String(c.value)); c.continue(); }; });
  db.close();
  return out.join("\n");
});

const ORDER = Array.from({ length: 10 }, (_, i) => ARMS[i % 2]); // TEST schedule: index 1 adaptive, 2 baseline, …
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const results = [];
const readLog = async (page) => (await sessionLog(page)).split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
try {
  for (const model of MODELS) for (const arm of ARMS) {
    const tag = `${model.replace(/[:.]/g, "_")}-${arm}`;
    TAGS.add(tag);
    const har = join(OUT, `${tag}.har`);
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true, recordHar: { path: har, content: "embed", urlFilter: `http://127.0.0.1:${PX}/**` }, serviceWorkers: "block" });
    await ctx.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && (u.port === String(WEB) || u.port === String(PX))) return route.continue();
      if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
      fail(`page tried a non-local host: ${u.origin}`); return route.abort("blockedbyclient");
    });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.addInitScript(native);
    await page.addInitScript(observer);
    await page.addInitScript(shim, { settings: { provider: "spider-cloud", model, spiderCloudUrl: `http://127.0.0.1:${PX}/p/${tag}` }, order: ORDER, next: ORDER.indexOf(arm) + 1 });
    await page.goto(`http://127.0.0.1:${WEB}/`);
    let probe = null;
    try {
      await page.waitForSelector("textarea", { timeout: 30_000 });
      if (PROBE_TYPING) {
        // the reasoning phase: request out, reasoning chunks arriving, no content yet, thinking indicator shown
        const inReasoning = await until("the reasoning phase", async () => wire.get(tag)?.firstReasoningAt && !wire.get(tag)?.firstContentAt && !!(await page.$("[data-typing-indicator]")), Math.min(TIMEOUT, 60_000)).catch(() => false);
        const during = await page.evaluate(() => { const ta = document.querySelector("textarea"); return { busy: document.querySelector("[data-busy]")?.getAttribute("data-busy"), thinking: !!document.querySelector("[data-typing-indicator]"), streaming: !!document.querySelector("[data-streaming]"), readOnly: ta.readOnly, disabled: ta.disabled, sendDisabled: document.querySelector("button[aria-label=Send]")?.disabled ?? null }; });
        await page.locator("textarea").focus().catch(() => {});
        await page.keyboard.type("x");
        await page.keyboard.press("Enter"); // must not send: the Director is busy
        probe = { during: { inReasoning: !!inReasoning, contentYet: !!wire.get(tag)?.firstContentAt, ...during, typedValue: await page.locator("textarea").inputValue() } };
      }
      // done = this page's stream ended (proxy) + director_turn 0 logged (app) + the UI idle
      await until(`the opener stream of ${tag} to end`, () => wire.get(tag)?.endAt && (inflight.get(tag) ?? 0) === 0, TIMEOUT);
      await until(`director_turn 0 in the log of ${tag}`, async () => (await readLog(page)).some((e) => e.type === "director_turn" && e.turn === 0), 30_000);
      await until(`the UI of ${tag} to be idle`, () => page.evaluate(() => !document.querySelector("[data-typing-indicator]") && !document.querySelector("[data-streaming]") && document.querySelector("[data-busy]")?.getAttribute("data-busy") === "false"), 30_000);
      await page.waitForTimeout(500);
      if (PROBE_TYPING) {
        await page.locator("textarea").fill(""); await page.locator("textarea").focus();
        await page.keyboard.type("y"); // the first key AFTER completeAt (never sent)
        probe.after = { typedValue: await page.locator("textarea").inputValue() };
      }
    } catch (e) { fail(`${tag}: ${e.message}`); }
    const ui = await page.evaluate(() => ({ texts: [...document.querySelectorAll(".eeg-prose")].map((e) => e.textContent.trim()).filter(Boolean), alerts: [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.trim()).filter(Boolean), thinking: !!document.querySelector("[data-typing-indicator]") }));
    const shot = join(OUT, `${tag}-opener.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const ev = await readLog(page);
    const timelineUI = await page.evaluate(() => window.__timeline ?? []);
    const ss = ev.find((e) => e.type === "session_start" && e.study), dt = ev.find((e) => e.type === "director_turn" && e.turn === 0);
    const mine = chats.filter((c) => c.page === tag); // matched by tag, never by arrival order
    const w = mine[0] ?? null, wt = wire.get(tag) ?? {};
    const tl = [...Object.entries(wt).filter(([, v]) => typeof v === "number").map(([k, t]) => ({ k: `wire.${k}`, t })), ...timelineUI.map((x) => ({ ...x, k: `ui.${x.k}` }))].sort((a, b) => a.t - b.t).map((x) => ({ ...x, ms: wt.reqAt ? x.t - wt.reqAt : null }));
    writeFileSync(join(OUT, `timeline-${tag}.json`), JSON.stringify({ tag, probe, timeline: tl }, null, 1));
    // composer lock: while the Director is busy (incl. the thinking phase) the textarea must not accept input
    const unlockedWhileBusy = timelineUI.filter((x) => x.busy === "true" && x.locked === false);
    const inputWhileBusy = timelineUI.filter((x) => x.k === "input" && (x.busy === "true" || x.thinking || x.streaming));
    const r = { model, arm, tag, study_index: ss?.study?.index ?? null, requests: mine.length, roles: w?.roles, last_user: w?.last_user, finish_reason: w?.finish_reason ?? null, ttfb_ms: w?.ttfb_ms, ms: w?.ms, completion_tokens: w?.usage?.completion_tokens ?? null, content_words: w?.content_words ?? 0,
      ui_words: ui.texts.join(" ").split(/\s+/).filter(Boolean).length, error_notice: ui.alerts.length > 0, thinking_still_shown: ui.thinking, composer_unlocked_while_busy: unlockedWhileBusy.length > 0, input_while_busy: inputWhileBusy.length, probe,
      log: dt ? { text_chars: dt.text.length, finish_reason: dt.finish_reason, opener_cue: dt.opener_cue, opener_cue_id: dt.opener_cue_id, empty_retries: dt.empty_retries, error: dt.error ?? null, genMs: dt.genMs, firstTokenMs: dt.firstTokenMs } : null, screenshot: shot };
    results.push(r);
    log(`${tag}: index ${r.study_index}, requests ${r.requests}, roles ${r.roles?.join(",")}, finish ${r.finish_reason}, completion_tokens ${r.completion_tokens}, words ${r.content_words}/${r.ui_words}, composer locked while busy: ${!r.composer_unlocked_while_busy}`);
    if (r.study_index !== ORDER.indexOf(arm) + 1) fail(`${tag}: launch session is not study index ${ORDER.indexOf(arm) + 1} (got ${r.study_index})`);
    if (r.requests !== 1) fail(`${tag}: ${r.requests} chat requests (want exactly 1 opener)`);
    if (r.roles?.at(-1) !== "user" || r.last_user !== "(session start)") fail(`${tag}: the opener does not end with the user cue`);
    if (r.finish_reason !== "stop") fail(`${tag}: finish_reason ${r.finish_reason}`);
    if (!r.content_words || !r.ui_words || !(r.completion_tokens > 0)) fail(`${tag}: empty opener (words ${r.content_words}, ui ${r.ui_words}, completion_tokens ${r.completion_tokens})`);
    if (r.error_notice) fail(`${tag}: error notice shown: ${ui.alerts.join(" | ")}`);
    if (r.thinking_still_shown) fail(`${tag}: the thinking indicator is still shown`);
    if (r.composer_unlocked_while_busy) fail(`${tag}: the composer accepted input while the Director was busy (${[...new Set(unlockedWhileBusy.map((x) => x.k))].join(", ")})`);
    if (r.input_while_busy) fail(`${tag}: ${r.input_while_busy} input event(s) landed before the reply was complete`);
    if (probe && (!probe.during.inReasoning || probe.during.typedValue !== "" || probe.after?.typedValue !== "y")) fail(`${tag}: typing probe: in reasoning ${probe.during.inReasoning}, typed during reasoning ${JSON.stringify(probe.during.typedValue)} (want ""), after complete ${JSON.stringify(probe.after?.typedValue)} (want "y")`);
    if (!r.log || r.log.opener_cue !== true || r.log.opener_cue_id !== "oc1-075ffc54" || r.log.empty_retries !== 0 || r.log.error) fail(`${tag}: director_turn 0 not logged as a cued opener without retry: ${JSON.stringify(r.log)}`);
    if (ev.some((e) => JSON.stringify(e).includes("(session start)"))) fail(`${tag}: the cue text is in the session log`);
    if (errs.length) log(`${tag}: page errors`, errs);
    // never start the next page while this page's stream is still open
    await until(`all streams of ${tag} to end`, () => (inflight.get(tag) ?? 0) === 0, TIMEOUT).catch((e) => fail(e.message));
    await ctx.close(); // flushes the HAR
  }
} catch (e) { fail(`run aborted: ${e?.message ?? e}`); }
await browser.close(); px.close(); web.close();

// HAR: no Authorization / cookie headers anywhere; the token (and any bhd_ string) replaced
const SENSITIVE = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
for (const f of readdirSync(OUT).filter((f) => f.endsWith(".har"))) {
  const h = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  for (const e of h.log?.entries ?? []) for (const side of [e.request, e.response]) if (side?.headers) side.headers = side.headers.filter((x) => !SENSITIVE.has(String(x.name).toLowerCase()));
  writeFileSync(join(OUT, f), redact(JSON.stringify(h, null, 1)));
}
const summary = { mode: DRY ? "dry-run (wrangler dev + fake-upstream, system-only -> empty done)" : `live ${LIVE_ORIGIN}`, upstream_requests: live, max_upstream_requests: MAX_LIVE, answered_locally: localOnly, chats, results, failures };
writeFileSync(join(OUT, "summary.json"), redact(JSON.stringify(summary, null, 2)));
const hits = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { const b = readFileSync(p); if (b.includes("bhd_") || (TOKEN && b.includes(TOKEN))) hits.push(p); } } };
walk(OUT);
log(`\nresults (${summary.mode}):`);
for (const r of results) log(`  ${r.model} ${r.arm}: index=${r.study_index} requests=${r.requests} cue=${r.last_user === "(session start)"} finish_reason=${r.finish_reason} completion_tokens=${r.completion_tokens} words=${r.content_words} ttfb=${r.ttfb_ms}ms total=${r.ms}ms composer_locked_while_busy=${!r.composer_unlocked_while_busy}${r.probe ? ` typed_during_reasoning=${JSON.stringify(r.probe.during.typedValue)}` : ""}`);
log(`upstream chat requests: ${live} (cap ${MAX_LIVE}); answered locally (models/uploads): ${localOnly}`);
log(`outputs: ${OUT}`);
if (hits.length) { console.error(`SELF-CHECK FAILED: "bhd_" found in ${hits.join(", ")}`); process.exit(1); }
log('self-check: no "bhd_" in any output file');
const want = MODELS.length * ARMS.length;
if (failures.length || results.length !== want) { console.error(`FAILED (${failures.length} problem(s), ${results.length}/${want} openers)`); process.exit(1); }
log(`PASS: ${want}/${want} openers non-empty, cued, finish_reason stop`);
process.exit(0);
