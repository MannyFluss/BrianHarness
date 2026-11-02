#!/usr/bin/env node
// Self-contained LLM interest-extractor runner (Node >= 22.19, stdlib only, no npm install).
// Sends the prepared prompts (prompts.jsonl) to an Ollama /api/chat endpoint, stream:false:
//   * LOCAL (default when OLLAMA_API_KEY is unset): http://127.0.0.1:11434, the signed-in Ollama app, which forwards
//     *:cloud models to Ollama's cloud. No key, no Authorization header. Every model must be a cloud tag
//     (":cloud" or "...-cloud"), or it refuses to start before any call, so nothing runs on the local machine.
//   * REMOTE (default when OLLAMA_API_KEY is set): https://ollama.com/api/chat with Authorization: Bearer $OLLAMA_API_KEY.
//     The direct API uses other names, mapped by REMOTE_NAMES below (e.g. gemma4:cloud -> gemma4:31b).
//
//   node run.mjs --base-url http://127.0.0.1:11434 --status      # counter + cache, 0 calls
//   node run.mjs --base-url http://127.0.0.1:11434               # DEFAULT set: gemma4:cloud, 24 sessions x turns 12+6 = 48 calls
//   node run.mjs --base-url http://127.0.0.1:11434 --models gemma4:cloud,gpt-oss:120b-cloud --turns 12   # alt: 48 calls
//   node run.mjs --dry-run --base-url http://127.0.0.1:8765      # against fake_server.mjs, state in out-dry/
//
// HARD CAP: at most 50 network calls in total, across runs and models, persisted in <out>/calls.json
// (a call is counted BEFORE it is sent, so crashes/timeouts count too). Every OK response is cached in
// <out>/cache/<key>.json and never requested again. <out>/responses.jsonl is rewritten from the cache at
// the end of every run: {key, model, session, persona, turn, status, ok, raw}. Copy <out>/ back to the box.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HARD_CAP = 50;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const dry = flag("dry-run");
const key = process.env.OLLAMA_API_KEY || undefined;
const REMOTE = "https://ollama.com";
const LOCAL_DEFAULT = "http://127.0.0.1:11434";
const baseUrl = (arg("base-url", key ? REMOTE : LOCAL_DEFAULT)).replace(/\/+$/, "").replace(/\/(api\/chat|api|v1)$/, "");
const isLocal = (() => { try { return ["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname); } catch { return false; } })();
const isRemote = baseUrl === REMOTE;
if (!dry && !isLocal && !isRemote) { console.error(`refusing: real runs go to ${REMOTE} or a localhost / 127.0.0.1 Ollama app, not ${baseUrl} (use --dry-run for a fake server)`); process.exit(2); }
// names on the direct ollama.com API differ from the app's :cloud tags (request body only; cache keys stay the same)
const REMOTE_NAMES = { "gemma4:cloud": "gemma4:31b", "gpt-oss:120b-cloud": "gpt-oss:120b", "gpt-oss:20b-cloud": "gpt-oss:20b" };
const wireModel = (m) => (isRemote ? REMOTE_NAMES[m] ?? m : m);
const isCloudTag = (m) => /:(cloud|[^:]*-cloud)$/.test(m);
const OUT = path.resolve(arg("out", path.join(HERE, dry ? "out-dry" : "out")));
const models = arg("models", "gemma4:cloud").split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(arg("limit", "1000"));
const turns = arg("turns", "12,6").split(",").map(Number);
const maxCalls = Math.min(HARD_CAP, Number(arg("max-calls", String(HARD_CAP))));
const timeoutMs = Number(arg("timeout-s", "180")) * 1000;

const counterFile = path.join(OUT, "calls.json");
const counter = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, "utf8")) : { calls: 0, cap: HARD_CAP, log: [] };
const saveCounter = () => fs.writeFileSync(counterFile, JSON.stringify(counter, null, 1) + "\n");
const prompts = fs.readFileSync(path.join(HERE, "prompts.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cachePath = (k) => path.join(OUT, "cache", `${k}.json`);
if (isLocal) {
  const bad = [...new Set([...models, ...prompts.map((p) => p.model), ...prompts.map((p) => p.body?.model)])].filter((m) => !isCloudTag(String(m)));
  if (bad.length) { console.error(`refusing (local base URL): non-cloud model(s) ${bad.join(", ")}; only :cloud / -cloud tags may go through the local Ollama app`); process.exit(2); }
}
fs.mkdirSync(path.join(OUT, "cache"), { recursive: true });

function writeResponses() {
  const lines = [];
  for (const p of prompts) if (fs.existsSync(cachePath(p.key))) {
    const c = JSON.parse(fs.readFileSync(cachePath(p.key), "utf8"));
    lines.push(JSON.stringify({ key: p.key, model: p.model, session: p.session, persona: p.persona, turn: p.turn, status: c.status, ok: c.ok, raw: c.raw }));
  }
  fs.writeFileSync(path.join(OUT, "responses.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));
  return lines.length;
}

const todoAll = [];
for (const m of models) {
  if (!prompts.some((p) => p.model === m)) { console.error(`no prepared prompts for model ${m} (have: ${[...new Set(prompts.map((p) => p.model))].join(", ")})`); process.exit(2); }
  for (const t of turns) todoAll.push(...prompts.filter((p) => p.model === m && p.turn === t).slice(0, limit));
}
const todo = todoAll.filter((p) => !fs.existsSync(cachePath(p.key)));
console.log(`base: ${baseUrl} (${isLocal ? "local Ollama app, no auth" : isRemote ? "ollama.com, Bearer key" : "dry-run target"})${isRemote ? "; wire names: " + models.map((m) => `${m}->${wireModel(m)}`).join(", ") : ""}`);
console.log(`out: ${OUT}\nmodels: ${models.join(", ")}; turns ${turns.join(",")}; prompts selected ${todoAll.length}, already cached ${todoAll.length - todo.length}, to send ${todo.length}`);
console.log(`call counter: ${counter.calls} used of ${HARD_CAP} (this run may use ${Math.max(0, Math.min(maxCalls, HARD_CAP) - counter.calls)})`);
if (flag("status")) { console.log(`responses.jsonl: ${writeResponses()} lines`); process.exit(0); }
if (todo.length && isRemote && !key) { console.error(`OLLAMA_API_KEY is not set (needed for ${REMOTE}); nothing sent`); process.exit(2); }

let sent = 0, ok = 0, failed = 0;
const t0 = Date.now();
for (const p of todo) {
  if (counter.calls >= maxCalls) { console.log(`STOP: call cap reached (${counter.calls}/${maxCalls})`); break; }
  const body = { ...p.body, model: wireModel(p.body.model ?? p.model), stream: false };
  if (/^gpt-oss/.test(p.model)) body.options = { ...(body.options ?? {}), num_predict: Math.max(512, body.options?.num_predict ?? 0) };
  counter.calls++; counter.log.push({ at: new Date().toISOString(), model: p.model, key: p.key, dry }); saveCounter();
  sent++;
  const t = Date.now();
  let status = 0, raw = "", err = "";
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json", ...(key && !isLocal ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status; raw = await res.text();
  } catch (e) { err = String(e?.message ?? e); }
  const good = status === 200 && raw.length > 0;
  const content = good ? (() => { try { return JSON.parse(raw)?.message?.content ?? ""; } catch { return ""; } })() : "";
  console.log(`[${counter.calls}/${HARD_CAP}] ${p.model} t${p.turn} ${p.session} -> ${status || err} ${((Date.now() - t) / 1000).toFixed(1)}s ${content.replace(/\s+/g, " ").slice(0, 100)}`);
  if (good) { ok++; fs.writeFileSync(cachePath(p.key), JSON.stringify({ status, ok: true, raw, model: p.model, session: p.session, ms: Date.now() - t })); }
  else {
    failed++;
    fs.appendFileSync(path.join(OUT, "errors.jsonl"), JSON.stringify({ at: new Date().toISOString(), key: p.key, model: p.model, status, err, raw: raw.slice(0, 500) }) + "\n");
    if (status === 401 || status === 403) { console.error("STOP: key rejected (401/403)"); break; }
    if (status === 429) { console.error("STOP: rate limited (429); rerun later, cached prompts are skipped"); break; }
    if (failed >= 3 && ok === 0) { console.error("STOP: 3 failures and no success"); break; }
  }
}
const n = writeResponses();
console.log(`done: sent ${sent} (ok ${ok}, failed ${failed}) in ${((Date.now() - t0) / 1000).toFixed(0)}s; counter ${counter.calls}/${HARD_CAP}; ${n} responses in ${path.join(OUT, "responses.jsonl")}`);
