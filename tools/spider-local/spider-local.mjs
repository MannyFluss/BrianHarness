#!/usr/bin/env node
// Spider Cloud end-to-end against the REAL Worker code under `wrangler dev --local` with a fake Ollama upstream.
// No Cloudflare account, no deploy, no real keys (throwaway --var values, never printed), no model calls: the
// "upstream" is a local fake. Uses BrianHarness core's SpiderCloudBackend / listSpiderCloudModels / LlmInterestExtractor.
//   npm run -w packages/core build && node tools/spider-local/spider-local.mjs [--worker /workspace/brianharness-worker]
//   add --sessions to also exercise POST /v1/sessions (needs a Worker build that has it).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const workerRoot = resolve(arg("--worker", process.env.BH_WORKER_DIR || "/workspace/brianharness-worker"));
const core = await import(pathToFileURL(resolve(here, "../../packages/core/dist/index.js")).href);
const UP_PORT = Number(arg("--up-port", 11565)), W_PORT = Number(arg("--port", 8797)), W = `http://127.0.0.1:${W_PORT}`;
const FAKE_KEY = "spider-local-fake-up-" + randomBytes(12).toString("hex");
const ADMIN = "spider-local-fake-admin-" + randomBytes(16).toString("hex");
const persist = mkdtempSync(join(tmpdir(), "bh-spider-wr-"));
const kids = [];
let workerLog = "", passed = 0;
const done = (code) => { for (const k of kids) try { k.kill("SIGTERM"); } catch {} upSrv.close(); rmSync(persist, { recursive: true, force: true }); process.exit(code); };
export const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) done(1); passed++; };

// fake Ollama /api/chat: the extractor (system = v2 prompt, format json) gets an interests JSON, everything else a greeting
const upHits = [];
const upSrv = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") return res.writeHead(404).end();
  if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return res.writeHead(401).end('{"error":"unauthorized (fake)"}');
  let raw = ""; for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  const extractor = b.messages?.[0]?.content === core.EXTRACTOR_SYSTEM_PROMPT_V2;
  upHits.push({ model: b.model, stream: b.stream, extractor, format: b.format ?? null, options: b.options });
  const text = extractor ? JSON.stringify({ interests: [{ label: "sourdough bread baking", confidence: 0.9, turns: [1, 2, 3] }] }) : "Hello from the fake upstream 🌊";
  const final = { model: b.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 9, eval_count: 4 };
  if (!b.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...final, message: { role: "assistant", content: text } }));
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const w of text.split(/(?= )/)) { res.write(JSON.stringify({ model: b.model, message: { role: "assistant", content: w }, done: false }) + "\n"); await new Promise((r) => setTimeout(r, 3)); }
  res.end(JSON.stringify(final) + "\n");
}).listen(UP_PORT, "127.0.0.1");

const wr = spawn(resolve(workerRoot, "node_modules/.bin/wrangler"), ["dev", "--local", "--ip", "127.0.0.1", "--port", String(W_PORT), "--show-interactive-dev-session=false", "--persist-to", persist,
  "--var", `UPSTREAM_BASE_URL:http://127.0.0.1:${UP_PORT}`, "--var", `OLLAMA_API_KEY:${FAKE_KEY}`, "--var", `ADMIN_SECRET:${ADMIN}`,
  "--var", "DAILY_CAP:50", "--var", "DEVICE_DAILY_CAP:6", "--var", `COUNTER_SCOPE:spider-local-${Date.now()}`],
  { cwd: workerRoot, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
kids.push(wr);
wr.stdout.on("data", (d) => (workerLog += d)); wr.stderr.on("data", (d) => (workerLog += d));
process.on("SIGINT", () => done(130));

async function waitFor(url, ms = 90000) {
  const t = Date.now();
  for (;;) { try { if ((await fetch(url)).ok) return; } catch {} if (Date.now() - t > ms) throw new Error(`timeout waiting for ${url}\n${workerLog.slice(-2000)}`); await new Promise((r) => setTimeout(r, 300)); }
}
const admin = (...a) => execFileSync(process.execPath, [resolve(workerRoot, "scripts/admin.mjs"), ...a], { env: { ...process.env, BH_API_URL: W, BH_ADMIN_SECRET: ADMIN }, encoding: "utf8" });

try {
  await waitFor(`${W}/healthz`);
  console.log(`wrangler dev --local (worker ${workerRoot}) up at ${W}`);
  const issued = admin("issue", "spider-local");
  const token = /token:\s+(\S+)/.exec(issued)?.[1], id = /device id:\s+(\S+)/.exec(issued)?.[1];
  check(core.SPIDER_TOKEN_RE.test(token ?? "") && !!id, "admin CLI issued a bhd_ device token");
  const base = core.normalizeSpiderUrl(`${W}/v1/`);

  // models
  const m = await core.listSpiderCloudModels(base, token, fetch, 5000);
  check(m.live && m.models.join(",") === "gemma4:cloud,gpt-oss:120b-cloud,gpt-oss:20b-cloud", `GET /v1/models via listSpiderCloudModels -> live ${m.models.join(", ")}`);
  const mBad = await core.listSpiderCloudModels(base, "bhd_not_a_real_token_000000000000", fetch, 5000);
  check(!mBad.live && mBad.models.join(",") === core.SPIDER_CLOUD_MODELS.join(",") && /invalid or revoked/.test(mBad.error ?? ""), `bad token -> static fallback list + "${mBad.error}"`);

  // streaming chat (desktop/web path; iOS routes the same fetch through BHStream)
  const be = new core.SpiderCloudBackend({ token, baseUrl: base, model: "gemma4:cloud" });
  const toks = [];
  const g = await be.generate({ messages: [{ role: "system", content: "You are Brian." }, { role: "user", content: "hi" }], onToken: (t) => toks.push(t) });
  check(g.text === "Hello from the fake upstream 🌊" && toks.length >= 3, `streaming chat via the Worker -> ${toks.length} tokens, "${g.text}"`);
  check(upHits.at(-1).stream === true && upHits.at(-1).model !== "gemma4:cloud", `Worker mapped gemma4:cloud -> upstream ${upHits.at(-1).model}, stream:true`);
  const g2 = await new core.SpiderCloudBackend({ token, baseUrl: base, model: "gpt-oss:20b-cloud" }).generate({ messages: [{ role: "user", content: "hi" }] });
  check(g2.text === "Hello from the fake upstream 🌊", `buffered chat gpt-oss:20b-cloud -> "${g2.text}"`);

  // extractor through the Worker: gemma4:cloud, v2 prompt, json format, same parsing; final effectiveTagger llm-extract
  const cache = new Map();
  const ex = new core.LlmInterestExtractor({ api: "openai", baseUrl: base, apiKey: token, everyN: 3, fetchImpl: core.spiderFetch(fetch), cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, v) } });
  const s = new core.HarnessSession({ userId: "u", backend: new core.MockBackend(1), store: null, seed: 7, tagger: ex });
  await s.start();
  for (const t of ["my sourdough starter bubbled over again", "the crumb on this loaf is so open", "i fed it rye flour this time"]) await s.reply(t);
  const xh = upHits.filter((h) => h.extractor);
  check(xh.length === 1 && xh[0].format === "json" && xh[0].options.temperature === 0 && xh[0].options.seed === 1, `extractor -> 1 Worker call (format json, temperature 0, seed 1, num_predict ${xh[0]?.options.num_predict})`);
  check(s.finalGuesses(1)[0]?.label === "sourdough bread baking", `extractor parsed via the Worker -> top1 "${s.finalGuesses(1)[0]?.label}"`);
  const out = s.extractorOutcome();
  check(out.effectiveTagger === "llm-extract" && out.fallback === false && out.extractorCalls.ok === 1, `extractorOutcome ${JSON.stringify(out)}`);
  check([...cache.keys()].every((k) => k.startsWith("oa:")), "extractor cache keys are oa:-prefixed (Ollama keys unchanged)");

  // 429 daily cap: 3 requests used so far, DEVICE_DAILY_CAP 6
  let capErr;
  for (let i = 0; i < 6 && !capErr; i++) { try { await be.generate({ messages: [{ role: "user", content: "x" }] }); } catch (e) { capErr = e; } }
  check(capErr && capErr.capped && /^Spider Cloud: daily limit reached, resets at /.test(capErr.message), `device cap -> "${capErr?.message}"`);
  const ex2 = new core.LlmInterestExtractor({ api: "openai", baseUrl: base, apiKey: token, everyN: 2, fetchImpl: core.spiderFetch(fetch), retryDelayMs: 1 });
  const s2 = new core.HarnessSession({ userId: "u", backend: new core.MockBackend(1), store: null, seed: 7, tagger: ex2 });
  await s2.start(); for (const t of ["a b c", "d e f"]) await s2.reply(t);
  check(s2.extractorOutcome().fallbackReason === "cap_reached", `extractor at the Worker cap -> fallbackReason ${s2.extractorOutcome().fallbackReason}`);

  // 401 after revoke
  admin("revoke", id);
  let authErr;
  try { await be.generate({ messages: [{ role: "user", content: "x" }] }); } catch (e) { authErr = e; }
  check(authErr?.status === 401 && authErr.message === "Spider Cloud: device token invalid or revoked", `revoked token -> "${authErr?.message}"`);

  if (process.argv.includes("--sessions")) {
    const { runSessions } = await import(pathToFileURL(resolve(here, "sessions-local.mjs")).href);
    await runSessions({ W, admin, check, core, adminSecret: ADMIN });
  }
  const leaked = [FAKE_KEY, ADMIN, token].some((k) => workerLog.includes(k));
  check(!leaked, "no throwaway secret or device token in the Worker output");
  console.log(`spider-local OK (${passed} checks)`);
  done(0);
} catch (e) { console.error(String(e.stack || e)); done(1); }
