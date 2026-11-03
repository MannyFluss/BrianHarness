#!/usr/bin/env node
// Live check of the P0 "reply text stops partway" fix (Nov 2 2026): the web build in headless Chrome, iOS-like
// (fake Capacitor BHStream), talking to Spider Cloud through a local Node proxy, 3 long-reply prompts across
// gpt-oss:20b-cloud and gpt-oss:120b-cloud. Each prompt must finish with finish_reason "stop" and non-empty
// content, and the UI must show no "Reply cut off" / "Reply interrupted" note.
//
//   BH_TEST_TOKEN=bhd_… PLAYWRIGHT_CORE=<dir of playwright-core> node apps/desktop/scripts/verify-live-stream.mjs
//   node apps/desktop/scripts/verify-live-stream.mjs --dry-run [--worker <brianharness-worker dir>]
//
// Safety (InfrastructureBot's conditions):
//   - network: the page may reach ONLY 127.0.0.1/localhost (every other request is aborted and fails the run);
//     the proxy forwards ONLY to UPSTREAM (https://api.strangeriver.org live; the local wrangler dev in --dry-run)
//     and only POST /v1/chat/completions + at most one GET /v1/models; anything else is answered locally 403
//     and fails the run.
//   - at most MAX_LIVE requests reach UPSTREAM (the proxy refuses the next one and the run fails); the count is
//     printed at the end. 5 chat requests are needed: 2 openers + 3 prompts.
//   - the token never enters the browser: the page holds a placeholder credential and the proxy swaps in the
//     Authorization header. It is never printed or written; HAR/trace keep no Authorization header.
//   - the interest extractor is off (its persisted call cap is pre-filled, and the proxy refuses any request
//     with response_format/format, i.e. an extractor call, failing the run).
//   - last step: every output file is grepped for "bhd_" (and the token itself); any hit -> exit 1.
// Output: /workspace/p0-stream/live/ (dry run: /workspace/p0-stream/live/dry-run/), override with --out.
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
const MAX_LIVE = 6;
const PLAN = [ // [model, prompts]; each page also streams one opener on launch
  ["gpt-oss:20b-cloud", ["Tell me, in detail and in several paragraphs, how you would teach a friend to bake their first sourdough loaf.", "Now describe, at length, the three mistakes beginners make most often and how to fix each one."]],
  ["gpt-oss:120b-cloud", ["Write a long, detailed description of a perfect slow Sunday morning: the kitchen, the smells, the music, and what you cook."]],
];
const dist = resolve(arg("--dist", new URL("../dist-web/", import.meta.url).pathname)) + "/";
const OUT = resolve(arg("--out", DRY ? "/workspace/p0-stream/live/dry-run" : "/workspace/p0-stream/live"));
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
const base = Number(arg("--port-base", 18750));
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
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });

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
  // realistic: num_predict caps thinking + content, random 1..9-byte splits; "long" = ~210-word replies
  kids.push(spawn(process.execPath, [join(worker, "scripts/fake-upstream.mjs")], { env: { ...process.env, PORT: String(UP), FAKE_UPSTREAM_KEY: fakeKey, FAKE_SCENARIO: "realistic", FAKE_DELAY_MS: "0", FAKE_PLAN: "ok,long,long,ok,long" }, stdio: "ignore" }));
  let wlog = "";
  const wr = spawn(join(worker, "node_modules/.bin/wrangler"), ["dev", "--local", "--ip", "127.0.0.1", "--port", String(W), "--show-interactive-dev-session=false", "--persist-to", persist,
    "--var", `UPSTREAM_BASE_URL:http://127.0.0.1:${UP}`, "--var", `OLLAMA_API_KEY:${fakeKey}`, "--var", `ADMIN_SECRET:${admin}`, "--var", `COUNTER_SCOPE:verify-${Date.now()}`],
  { cwd: worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(wr); wr.stdout.on("data", (d) => (wlog += d)); wr.stderr.on("data", (d) => (wlog += d));
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(`http://127.0.0.1:${W}/healthz`)).ok) break; } catch {} if (Date.now() - t0 > 90_000) { console.error("wrangler dev did not start\n" + redact(wlog.slice(-1500))); process.exit(2); } await new Promise((r) => setTimeout(r, 300)); }
  const issued = execFileSync(process.execPath, [join(worker, "scripts/admin.mjs"), "issue", "verify-dry-run"], { env: { ...process.env, BH_API_URL: `http://127.0.0.1:${W}`, BH_ADMIN_SECRET: admin }, encoding: "utf8" });
  TOKEN = /token:\s+(\S+)/.exec(issued)?.[1] ?? null;
  if (!TOKEN) { console.error("dry run: the local admin CLI issued no token"); process.exit(2); }
  UPSTREAM = `http://127.0.0.1:${W}`;
}
const upURL = new URL(UPSTREAM);
const upstreamAllowed = (u) => (DRY ? u.hostname === "127.0.0.1" && u.port === String(W) : u.origin === LIVE_ORIGIN);
if (!upstreamAllowed(upURL)) { console.error("refusing upstream " + upURL.origin); process.exit(2); }

// ---- proxy: page -> (localhost) -> UPSTREAM, Authorization swapped in here, request cap, wire trace
const trace = join(OUT, "trace.jsonl"); writeFileSync(trace, "");
const tlog = (o) => appendFileSync(trace, redact(JSON.stringify({ t: new Date().toISOString(), ...o })) + "\n");
let live = 0, models = 0;
const chats = [];
const px = createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-expose-headers": "*" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = ""; for await (const c of req) body += c;
  const path = new URL(req.url, "http://x").pathname;
  const deny = (why) => { fail(`proxy refused ${req.method} ${path}: ${why}`); tlog({ dir: "refused", method: req.method, path, why }); res.writeHead(403, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: `verify-live-stream: ${why}` })); };
  let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch {}
  const isChat = req.method === "POST" && path === "/v1/chat/completions";
  const isModels = req.method === "GET" && path === "/v1/models";
  if (!isChat && !isModels) return deny("path not allowed");
  if (isModels && ++models > 1) return deny("model-list polling beyond one call");
  if (isChat && (parsed?.response_format || parsed?.format)) return deny("extractor call (the extractor must be off)");
  if (live >= MAX_LIVE) return deny(`live request cap ${MAX_LIVE} reached`);
  const n = ++live;
  const target = new URL(path, UPSTREAM);
  if (!upstreamAllowed(target)) return deny("host not allowed: " + target.host);
  tlog({ n, dir: "req", method: req.method, path, ...(parsed ? { model: parsed.model, stream: parsed.stream, max_tokens: parsed.max_tokens, messages: parsed.messages?.length } : {}) });
  const headers = { "content-type": "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${TOKEN}`, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) };
  const mod = target.protocol === "https:" ? httpsRequest : httpRequest;
  const t0 = Date.now();
  const up = mod(target, { method: req.method, headers }, (ur) => {
    const h = { ...ur.headers }; delete h["set-cookie"];
    res.writeHead(ur.statusCode, { ...h, ...cors });
    const parts = [];
    ur.on("data", (c) => { parts.push(c); res.write(c); });
    ur.on("end", () => {
      res.end();
      const text = Buffer.concat(parts).toString("utf8");
      if (!isChat) { tlog({ n, dir: "end", status: ur.statusCode, bytes: text.length }); return; }
      const ev = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      let content = "", reasoning = 0; const fin = []; let usage = null, error = null;
      for (const e of ev) { if (e === "[DONE]") continue; try { const o = JSON.parse(e); if (o.error) error = o.error; const d = o.choices?.[0]?.delta ?? {}; content += d.content ?? ""; if (d.reasoning_content) reasoning++; if (o.choices?.[0]?.finish_reason) fin.push(o.choices[0].finish_reason); if (o.usage) usage = o.usage; } catch {} }
      const r = { n, model: parsed?.model, max_tokens: parsed?.max_tokens, status: ur.statusCode, ms: Date.now() - t0, bytes: Buffer.byteLength(text), sse_events: ev.length, done: ev.at(-1) === "[DONE]", finish_reason: fin.at(-1) ?? null, reasoning_events: reasoning, content_words: content.trim() ? content.trim().split(/\s+/).length : 0, content_tail: content.slice(-80), usage, error };
      chats.push(r); tlog({ dir: "end", ...r });
    });
    ur.on("error", (e) => { tlog({ n, dir: "error", message: e.message }); });
  });
  up.on("error", (e) => { tlog({ n, dir: "error", message: e.message }); if (!res.headersSent) res.writeHead(502, cors); res.end(); });
  up.end(body || undefined);
}).listen(PX, "127.0.0.1");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
}).listen(WEB, "127.0.0.1");

// iOS-like shell: BHStream streams base64 chunks like the Swift plugin. The credential is a placeholder.
const shim = ({ settings }) => {
  localStorage.setItem("brianharness/settings", JSON.stringify(settings));
  localStorage.setItem("brianharness/credentials/spider", JSON.stringify({ type: "api_key", key: "proxy-swaps-in-the-real-token" }));
  localStorage.setItem("brianharness/llm-extract/calls", JSON.stringify({ calls: 50, max: 50 })); // extractor off
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
  window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => n === "BHStream", Plugins: { BHStream } };
};

const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const results = [];
try {
  for (const [model, prompts] of PLAN) {
    const tag = model.replace(/[:.]/g, "_");
    const har = join(OUT, `${tag}.har`);
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true, recordHar: { path: har, content: "embed", urlFilter: `http://127.0.0.1:${PX}/**` } /* API traffic only (the app bundle itself mentions "bhd_") */, serviceWorkers: "block" });
    await ctx.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && (u.port === String(WEB) || u.port === String(PX))) return route.continue();
      if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
      fail(`page tried a non-local host: ${u.origin}`); return route.abort("blockedbyclient");
    });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.addInitScript(shim, { settings: { provider: "spider-cloud", model, spiderCloudUrl: `http://127.0.0.1:${PX}`, pickMigration: 1 } });
    await page.goto(`http://127.0.0.1:${WEB}/`);
    await page.waitForSelector("textarea", { timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector("[data-streaming]") && document.querySelectorAll(".eeg-prose").length >= 1, null, { timeout: 180_000 });
    for (const [i, prompt] of prompts.entries()) {
      const before = await page.$$eval(".eeg-prose", (els) => els.length);
      const chatsBefore = chats.length;
      await page.fill("textarea", prompt);
      await page.keyboard.press("Enter");
      await page.waitForFunction((n) => document.querySelectorAll(".eeg-prose").length >= n + 2 && !document.querySelector("[data-streaming]"), before, { timeout: 240_000 });
      await page.waitForTimeout(500);
      const ui = await page.evaluate(() => ({ reply: [...document.querySelectorAll(".eeg-prose")].at(-1)?.textContent ?? "", cutoff: document.querySelectorAll("[data-reply-cutoff]").length, failed: document.querySelectorAll("[data-reply-failed]").length }));
      const wire = chats.slice(chatsBefore).at(-1) ?? null;
      const shot = join(OUT, `${tag}-prompt${i + 1}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      const r = { model, prompt: i + 1, finish_reason: wire?.finish_reason ?? null, done: wire?.done ?? false, max_tokens: wire?.max_tokens, content_words: wire?.content_words ?? 0, ui_words: ui.reply.trim() ? ui.reply.trim().split(/\s+/).length : 0, cutoff_notice: ui.cutoff > 0, error_notice: ui.failed > 0 || ui.reply.startsWith("⚠"), screenshot: shot };
      results.push(r);
      if (r.finish_reason !== "stop") fail(`${model} prompt ${i + 1}: finish_reason ${r.finish_reason}`);
      if (!r.content_words || !r.ui_words) fail(`${model} prompt ${i + 1}: empty reply`);
      if (r.cutoff_notice || r.error_notice) fail(`${model} prompt ${i + 1}: cut-off / error notice shown`);
    }
    if (errs.length) log(`${model}: page errors`, errs);
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
const summary = { mode: DRY ? "dry-run (wrangler dev + fake-upstream)" : `live ${LIVE_ORIGIN}`, upstream_requests: live, max_upstream_requests: MAX_LIVE, model_list_calls: models, chats, results, failures };
writeFileSync(join(OUT, "summary.json"), redact(JSON.stringify(summary, null, 2)));

// self-check: no token, no bhd_ anywhere in the outputs
const hits = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { const b = readFileSync(p); if (b.includes("bhd_") || (TOKEN && b.includes(TOKEN))) hits.push(p); } } };
walk(OUT);
log(`\nresults (${summary.mode}):`);
for (const r of results) log(`  ${r.model} prompt ${r.prompt}: finish_reason=${r.finish_reason} max_tokens=${r.max_tokens} words=${r.content_words} cutoff=${r.cutoff_notice} error=${r.error_notice}`);
log(`upstream requests: ${live} (cap ${MAX_LIVE}); model-list calls: ${models}`);
log(`outputs: ${OUT}`);
if (hits.length) { console.error(`SELF-CHECK FAILED: "bhd_" found in ${hits.join(", ")}`); process.exit(1); }
log('self-check: no "bhd_" in any output file');
if (failures.length || results.length !== 3) { console.error(`FAILED (${failures.length} problem(s), ${results.length}/3 prompts)`); process.exit(1); }
log("PASS: 3/3 long replies finished with stop");
process.exit(0);
