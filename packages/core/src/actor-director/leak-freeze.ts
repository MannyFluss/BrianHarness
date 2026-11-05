/**
 * Researcher ruling A4 (5:33 PM): the leak-judge FREEZE RUN. One commit, one leak_judge_prompt_id, one judge model
 * (configurable, a different family from the Actor's), temperature 0.
 *
 * Per item: the regex layer runs first; then ONE judge call covers every code the judge must decide (mind_reading on
 * every reply, pivot_first / forced_move when there is a hint, regex-uncertain codes) and answer_first_violation
 * jointly. mind_reading and answer_first apply to every reply, so every reply item costs exactly one call (plus at
 * most one retry after an error / timeout / unparseable answer, counted against the cap).
 *
 * Two-day split: a resumable run with a hard per-run cap (--max-calls). The checkpoint directory holds state.json
 * (the frozen config + per-run request counts and usage) and done.jsonl (one durable line per finished item,
 * fsync'd). A resume REFUSES when the commit, the prompt id, the judge model, the temperature, the uncertain policy or
 * the inputs differ. The combined predictions JSONL ({id, codes, answer_first} per line, input order) is written only
 * when every item is done; there is no partial predictions file to share (the checkpoint is private, mode 0600).
 * A Worker 429 (role / device / global cap) ends the run at once; the item is retried on the next run.
 * The device token is never read here (the backend holds it) and never printed.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LEAK_CODES } from "../ad-contracts/index.js";
import type { LeakCode } from "../ad-contracts/index.js";
import type { AdChatBackend, AdChatRequest, AdChatResult } from "./director.js";
import { WorkerHttpError } from "./director.js";
import { LEAK_JUDGE_PROMPT_ID, LeakGate, assertJudgeModel } from "./leak-judge.js";
import { predictOne } from "./leak-predict.js";
import type { PredictInput, Prediction, UncertainPolicy } from "./leak-predict.js";

export const FREEZE_SCHEMA = "bh-leak-freeze/1";
export interface FreezeConfig {
  commit: string; leak_judge_prompt_id: string; judge_model: string; actor_model: string; temperature: number;
  uncertain_policy: UncertainPolicy; inputs_sha256: string; n: number; backend: string;
}
export interface UsageSummary {
  requests: number; ok: number; errors: number; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number;
  /** model tags the responses named (e.g. the Worker echoes the app model name) */
  models: Record<string, number>;
  /** last value seen per non-secret usage / rate header (x-ratelimit-*, retry-after, ...) */
  headers: Record<string, string>;
}
export const emptyUsage = (): UsageSummary => ({ requests: 0, ok: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, models: {}, headers: {} });
export interface FreezeState { schema: typeof FREEZE_SCHEMA; config: FreezeConfig; runs: Array<{ started: string; ended: string | null; calls: number; items: number; stopped: string; usage: UsageSummary }>; complete: boolean }
export interface DoneLine { id: string; attempts: number; pred: Prediction }
export interface FreezeRunResult {
  status: "complete" | "paused"; stopped: "complete" | "max_calls" | "worker_cap" | "aborted";
  callsThisRun: number; doneTotal: number; total: number; usage: UsageSummary; outPath: string | null;
  uncertain: UncertainSummary | null;
}
export interface UncertainSummary { items: number; byCode: Record<LeakCode, number>; answer_first: number; rateByCode: Record<LeakCode, number>; answer_first_rate: number; any: number }

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** counts every request against the cap and sums usage; it never sees or logs the token */
export class MeteredBackend implements AdChatBackend {
  readonly id: string;
  readonly usage = emptyUsage();
  calls = 0;
  constructor(private inner: AdChatBackend, private budget: () => number) { this.id = inner.id; }
  async complete(req: AdChatRequest): Promise<AdChatResult> {
    if (this.calls >= this.budget()) throw new CapReached();
    this.calls++; this.usage.requests++;
    try {
      const r = await this.inner.complete(req);
      this.usage.ok++;
      this.usage.prompt_tokens += r.usage.prompt_tokens ?? 0; this.usage.completion_tokens += r.usage.completion_tokens ?? 0; this.usage.reasoning_tokens += r.usage.reasoning_tokens ?? 0;
      const m = r.model ?? req.model; this.usage.models[m] = (this.usage.models[m] ?? 0) + 1;
      for (const [k, v] of Object.entries(r.headers ?? {})) this.usage.headers[k] = v;
      return r;
    } catch (e) { this.usage.errors++; throw e; }
  }
}
export class CapReached extends Error { constructor() { super("per-run call cap reached"); this.name = "CapReached"; } }

function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  const models = { ...a.models }; for (const [k, v] of Object.entries(b.models)) models[k] = (models[k] ?? 0) + v;
  return { requests: a.requests + b.requests, ok: a.ok + b.ok, errors: a.errors + b.errors, prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens, reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens, models, headers: { ...a.headers, ...b.headers } };
}
export function uncertainSummary(preds: Prediction[]): UncertainSummary {
  const byCode = Object.fromEntries(LEAK_CODES.map((c) => [c, 0])) as Record<LeakCode, number>;
  let af = 0, any = 0;
  for (const p of preds) { for (const c of p.uncertain) byCode[c]++; if (p.answer_first_judge === "uncertain") af++; if (p.uncertain.length || p.answer_first_judge === "uncertain" || p.verdict === "uncertain") any++; }
  const n = preds.length || 1;
  return { items: preds.length, byCode, answer_first: af, rateByCode: Object.fromEntries(LEAK_CODES.map((c) => [c, byCode[c] / n])) as Record<LeakCode, number>, answer_first_rate: af / n, any };
}

function atomicWrite(path: string, text: string) {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", 0o600); writeSync(fd, text); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
}
function appendDurable(path: string, line: string) {
  const fd = openSync(path, "a", 0o600); writeSync(fd, line + "\n"); fsyncSync(fd); closeSync(fd);
}
const CONFIG_KEYS: Array<keyof FreezeConfig> = ["commit", "leak_judge_prompt_id", "judge_model", "actor_model", "temperature", "uncertain_policy", "inputs_sha256", "n", "backend"];
export class FreezeRefused extends Error { constructor(m: string) { super(m); this.name = "FreezeRefused"; } }

export interface FreezeOptions {
  items: PredictInput[]; inputsText: string;
  config: Omit<FreezeConfig, "inputs_sha256" | "n" | "leak_judge_prompt_id" | "temperature"> & { leak_judge_prompt_id?: string; temperature?: number };
  backend: AdChatBackend; checkpointDir: string; outPath: string; maxCalls: number;
  /** a live judge sets a generous timeout; default 60 s */
  deadlineMs?: number; retries?: number; now?: () => Date; log?: (s: string) => void;
}

/** one run of the freeze: resumes from the checkpoint, stops at maxCalls, writes the predictions only when complete */
export async function runFreeze(o: FreezeOptions): Promise<FreezeRunResult> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  if (!(o.maxCalls >= 1)) throw new FreezeRefused("--max-calls must be >= 1");
  const promptId = o.config.leak_judge_prompt_id ?? LEAK_JUDGE_PROMPT_ID;
  if (promptId !== LEAK_JUDGE_PROMPT_ID) throw new FreezeRefused(`prompt id ${promptId} != the code's ${LEAK_JUDGE_PROMPT_ID}`);
  const temperature = o.config.temperature ?? 0;
  if (temperature !== 0) throw new FreezeRefused("the freeze run uses temperature 0");
  assertJudgeModel(o.config.judge_model, o.config.actor_model);
  const ids = new Set<string>();
  for (const it of o.items) { if (!it.id || ids.has(it.id)) throw new FreezeRefused(`duplicate or missing id: ${it.id}`); ids.add(it.id); }
  const config: FreezeConfig = { ...o.config, leak_judge_prompt_id: promptId, temperature, inputs_sha256: sha256(o.inputsText), n: o.items.length };
  mkdirSync(o.checkpointDir, { recursive: true, mode: 0o700 });
  const statePath = join(o.checkpointDir, "state.json"), donePath = join(o.checkpointDir, "done.jsonl");
  let state: FreezeState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as FreezeState;
    const diff = CONFIG_KEYS.filter((k) => state.config[k] !== config[k]);
    if (state.schema !== FREEZE_SCHEMA || diff.length) throw new FreezeRefused(`checkpoint was made with a different ${diff.join(", ") || "schema"}: refusing to resume (${diff.map((k) => `${k} ${String(state.config[k])} -> ${String(config[k])}`).join("; ")})`);
  } else {
    state = { schema: FREEZE_SCHEMA, config, runs: [], complete: false };
    atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
  }
  const done = new Map<string, DoneLine>();
  let doneText = existsSync(donePath) ? readFileSync(donePath, "utf8") : "";
  if (doneText && !doneText.endsWith("\n")) { doneText = doneText.slice(0, doneText.lastIndexOf("\n") + 1); atomicWrite(donePath, doneText); } // drop a torn tail
  for (const l of doneText.split("\n")) {
    if (!l.trim()) continue;
    try { const d = JSON.parse(l) as DoneLine; if (ids.has(d.id)) done.set(d.id, d); } catch { /* a torn last line from a crash: that item is redone */ }
  }
  const run = { started: now().toISOString(), ended: null as string | null, calls: 0, items: 0, stopped: "running", usage: emptyUsage() };
  state.runs.push(run);
  const metered = new MeteredBackend(o.backend, () => o.maxCalls);
  const gate = new LeakGate({ backend: metered, model: config.judge_model, actorModel: config.actor_model, deadlineMs: o.deadlineMs ?? 60_000, temperature: 0 });
  const retries = o.retries ?? 1;
  let stopped: FreezeRunResult["stopped"] = "complete";
  const save = () => { run.calls = metered.calls; run.usage = metered.usage; atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n"); };
  try {
    for (const it of o.items) {
      if (done.has(it.id)) continue;
      if (metered.calls >= o.maxCalls) { stopped = "max_calls"; break; }
      let pred: Prediction | null = null, attempts = 0, workerCap = false;
      for (let k = 0; k <= retries; k++) {
        if (metered.calls >= o.maxCalls) break;
        attempts++;
        const p = await predictOne(it, gate, config.uncertain_policy);
        if (p.status === "ok") { pred = p; break; }
        const err = gate.lastError;
        if (err instanceof WorkerHttpError && err.status === 429) { workerCap = true; pred = null; break; }
        if (err instanceof CapReached) { pred = null; break; }
        pred = p; // the gate's fail-safe reading, kept only when no retry is left
      }
      if (workerCap) { stopped = "worker_cap"; break; }
      // no answer yet and the cap stops the retry: not recorded, the item is redone next run
      if (!pred || (pred.status !== "ok" && attempts <= retries)) { stopped = "max_calls"; break; }
      const line: DoneLine = { id: it.id, attempts, pred };
      appendDurable(donePath, JSON.stringify(line));
      done.set(it.id, line); run.items++;
      save();
    }
  } finally {
    run.ended = now().toISOString(); run.stopped = done.size === o.items.length ? "complete" : stopped; save();
  }
  const total = addUsage(emptyUsage(), metered.usage);
  if (done.size < o.items.length) {
    log(`paused: ${done.size}/${o.items.length} items done, ${metered.calls} calls this run (cap ${o.maxCalls}), stopped: ${stopped}. No predictions written.`);
    return { status: "paused", stopped: stopped === "complete" ? "aborted" : stopped, callsThisRun: metered.calls, doneTotal: done.size, total: o.items.length, usage: total, outPath: null, uncertain: null };
  }
  const preds = o.items.map((it) => done.get(it.id)!.pred);
  const out = preds.map((p) => JSON.stringify({ id: p.id, codes: p.codes, answer_first: p.answer_first })).join("\n") + "\n";
  atomicWrite(o.outPath, out);
  chmodSync(o.outPath, 0o644);
  state.complete = true; save();
  const allUsage = state.runs.reduce((a, r) => addUsage(a, r.usage), emptyUsage());
  const unc = uncertainSummary(preds);
  const meta = { schema: FREEZE_SCHEMA, ...config, runs: state.runs.map((r) => ({ started: r.started, ended: r.ended, calls: r.calls, items: r.items, stopped: r.stopped })),
    requests_total: allUsage.requests, usage_total: allUsage, attempts_total: preds.length ? [...done.values()].reduce((a, d) => a + d.attempts, 0) : 0,
    uncertain: unc, predictions_sha256: sha256(out), answer_first_field: "answer_first = answer-first VIOLATION (R4c answer_first_violation)", written_at: now().toISOString() };
  atomicWrite(o.outPath.replace(/\.jsonl$/, "") + ".meta.json", JSON.stringify(meta, null, 2) + "\n");
  log(`complete: ${preds.length} predictions -> ${o.outPath}; ${allUsage.requests} requests over ${state.runs.length} run(s)`);
  return { status: "complete", stopped: "complete", callsThisRun: metered.calls, doneTotal: done.size, total: o.items.length, usage: total, outPath: o.outPath, uncertain: unc };
}
