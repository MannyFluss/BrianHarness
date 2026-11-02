#!/usr/bin/env node
// Self-contained LLM interest-extractor runner (Node >= 22.19, stdlib only, no npm install).
// Sends the prepared prompts (prompts.jsonl) to Ollama Cloud, https://ollama.com/api/chat, stream:false,
// with Authorization: Bearer $OLLAMA_API_KEY. Never uses a local ollama daemon.
//
//   OLLAMA_API_KEY=... node run.mjs                     # DEFAULT: gemma4:cloud, 24 sessions x turns 12+6 = 48 calls
//   OLLAMA_API_KEY=... node run.mjs --models gemma4:cloud,gpt-oss:120b-cloud --turns 12   # alt: 2 models x 24 x turn 12 = 48
//   node run.mjs --status                                              # counter + cache, no calls
//   node run.mjs --dry-run --base-url http://127.0.0.1:8765            # against fake_server.mjs, state in out-dry/
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
const baseUrl = (arg("base-url", "https://ollama.com")).replace(/\/+$/, "").replace(/\/(api\/chat|api|v1)$/, "");
if (!dry && baseUrl !== "https://ollama.com") { console.error("refusing: real runs go to https://ollama.com only (use --dry-run for a fake server)"); process.exit(2); }
const OUT = path.resolve(arg("out", path.join(HERE, dry ? "out-dry" : "out")));
const models = arg("models", "gemma4:cloud").split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(arg("limit", "1000"));
const turns = arg("turns", "12,6").split(",").map(Number);
const maxCalls = Math.min(HARD_CAP, Number(arg("max-calls", String(HARD_CAP))));
const timeoutMs = Number(arg("timeout-s", "180")) * 1000;
const key = process.env.OLLAMA_API_KEY ?? (dry ? "dry-run-fake-key" : undefined);

fs.mkdirSync(path.join(OUT, "cache"), { recursive: true });
const counterFile = path.join(OUT, "calls.json");
const counter = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, "utf8")) : { calls: 0, cap: HARD_CAP, log: [] };
const saveCounter = () => fs.writeFileSync(counterFile, JSON.stringify(counter, null, 1) + "\n");
const prompts = fs.readFileSync(path.join(HERE, "prompts.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cachePath = (k) => path.join(OUT, "cache", `${k}.json`);

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
console.log(`out: ${OUT}\nmodels: ${models.join(", ")}; turns ${turns.join(",")}; prompts selected ${todoAll.length}, already cached ${todoAll.length - todo.length}, to send ${todo.length}`);
console.log(`call counter: ${counter.calls} used of ${HARD_CAP} (this run may use ${Math.max(0, Math.min(maxCalls, HARD_CAP) - counter.calls)})`);
if (flag("status")) { console.log(`responses.jsonl: ${writeResponses()} lines`); process.exit(0); }
if (todo.length && !key) { console.error("OLLAMA_API_KEY is not set; nothing sent"); process.exit(2); }

let sent = 0, ok = 0, failed = 0;
const t0 = Date.now();
for (const p of todo) {
  if (counter.calls >= maxCalls) { console.log(`STOP: call cap reached (${counter.calls}/${maxCalls})`); break; }
  const body = { ...p.body, stream: false };
  if (/^gpt-oss/.test(p.model)) body.options = { ...(body.options ?? {}), num_predict: Math.max(512, body.options?.num_predict ?? 0) };
  counter.calls++; counter.log.push({ at: new Date().toISOString(), model: p.model, key: p.key, dry }); saveCounter();
  sent++;
  const t = Date.now();
  let status = 0, raw = "", err = "";
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
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
