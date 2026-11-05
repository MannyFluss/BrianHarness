// BrianHarness leak-judge Mac runner (Hermes Bridge runs it on Manny's Mac). Bundled into ONE self-contained .mjs by
// scripts/judge-mac/build.ts; every judging module (leak-judge, leaks, leak-predict, leak-freeze, director's
// WorkerChatBackend, ad-contracts) is bundled from the FROZEN worktree at 3b425dd, unmodified (MANIFEST.json lists the
// sha256 of each against `git show 3b425dd:<path>`). This file is only the wrapper: token file, local hard caps,
// model allowlist, stop rules, summaries. Inference stays in the cloud: the only network calls are HTTPS to the Worker.
//
//   node runner.mjs verify [--worker-url URL] [--out DIR]                  the 30 R4 items shipped in this bundle
//   node runner.mjs r4c --in <R4c inputs.jsonl> [--worker-url URL] [--out DIR] [--max-calls N]
//   node runner.mjs manifest                                              print MANIFEST.json + this file's sha256
//
// Exit codes: 0 complete · 2 refused (nothing sent) · 3 paused at a cap (rerun later to resume) · 4 stopped: Worker
// 429 or a 5xx / network storm (resumable later) · 5 stopped: a response named a non-gemma4 model · 1 unexpected error.
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, unlinkSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapReached, FreezeRefused, runFreeze, type DoneLine, type FreezeRunResult } from "frozen:actor-director/leak-freeze";
import { LEAK_JUDGE_PROMPT_ID, MockJudgeBackend } from "frozen:actor-director/leak-judge";
import { WorkerChatBackend, WorkerHttpError, type AdChatBackend, type AdChatRequest, type AdChatResult } from "frozen:actor-director/director";
import { ACTOR_MODEL } from "frozen:actor-director/session";
import type { PredictInput } from "frozen:actor-director/leak-predict";
import { LEAK_CODES } from "frozen:ad-contracts/index";
import { BUILD, VERIFY_GOLD, VERIFY_INPUTS } from "bundle:data";

export const RUNNER_VERSION = "bh-judge-mac-runner/1";
const JUDGE_MODEL = "gemma4:cloud";
/** response model tags accepted: the gemma4 family (gemma4:cloud as the Worker names it, gemma4:31b upstream, ...) */
const MODEL_OK = /^gemma4(?::[a-z0-9._-]+)?$/i;
const CAP_VERIFY_TOTAL = 35, CAP_PER_DAY = 95, STORM_CONSECUTIVE = 3, STORM_TOTAL = 6;
const TZ = "America/Los_Angeles";
const EXIT = { complete: 0, error: 1, refused: 2, paused: 3, storm: 4, model: 5 } as const;

const argv = process.argv.slice(2);
const stage = argv[0];
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ---- output: everything printed or written goes through redact() ----------------------------------------------
let secret: string | null = null;
const redact = (s: string) => { let t = s; if (secret) t = t.split(secret).join("[redacted]"); return t.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"); };
const say = (s: string) => process.stdout.write(redact(s) + "\n");
const warn = (s: string) => process.stderr.write(redact(s) + "\n");
class Refused extends Error { constructor(m: string) { super(m); this.name = "Refused"; } }
process.on("uncaughtException", (e) => { warn(`judge-runner: unexpected error: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`); process.exit(EXIT.error); });
process.on("unhandledRejection", (e) => { warn(`judge-runner: unexpected error: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`); process.exit(EXIT.error); });

function atomicWrite(path: string, text: string, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode); writeSync(fd, redact(text)); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
}
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// ---- clock (a test clock only against a loopback fake judge) ---------------------------------------------------
let clockOverride: string | null = null;
const now = () => (clockOverride ? new Date(clockOverride) : new Date());
const pacificDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// ---- the ledger: requests per LOCAL Pacific day across every run and stage; counted BEFORE each send --------------
interface Day { requests: number; verify: number; r4c: number; r4c_runs: number }
interface LedgerFile { schema: "bh-judge-ledger/1"; tz: string; caps: { verify_total: number; per_day: number }; verify_total: number; r4c_total: number; days: Record<string, Day>; updated: string | null }
class Ledger {
  private lockPath: string;
  private locked = false;
  constructor(readonly path: string) { this.lockPath = path + ".lock"; }
  lock() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let k = 0; k < 2; k++) {
      try { const fd = openSync(this.lockPath, "wx", 0o600); writeSync(fd, String(process.pid)); closeSync(fd); this.locked = true; return; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(readFileSync(this.lockPath, "utf8").trim());
        let alive = false;
        try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
        if (alive) throw new Refused(`another judge run (pid ${pid}) holds ${this.lockPath}; one run at a time`);
        unlinkSync(this.lockPath); // stale lock from a crashed run
      }
    }
    throw new Refused(`could not lock ${this.lockPath}`);
  }
  unlock() { if (this.locked) { try { unlinkSync(this.lockPath); } catch { /* gone */ } this.locked = false; } }
  read(): LedgerFile {
    if (!existsSync(this.path)) return { schema: "bh-judge-ledger/1", tz: TZ, caps: { verify_total: CAP_VERIFY_TOTAL, per_day: CAP_PER_DAY }, verify_total: 0, r4c_total: 0, days: {}, updated: null };
    let j: LedgerFile;
    try { j = JSON.parse(readFileSync(this.path, "utf8")) as LedgerFile; } catch { throw new Refused(`ledger ${this.path} is not valid JSON: refusing (never reset it to get more calls; ask the Engineer)`); }
    if (j.schema !== "bh-judge-ledger/1" || typeof j.verify_total !== "number" || typeof j.days !== "object" || !j.days) throw new Refused(`ledger ${this.path} has an unknown shape: refusing`);
    return j;
  }
  day(l: LedgerFile, d = pacificDay(now())): Day { return l.days[d] ?? { requests: 0, verify: 0, r4c: 0, r4c_runs: 0 }; }
  remaining(st: "verify" | "r4c"): number {
    const l = this.read(), d = this.day(l);
    const day = CAP_PER_DAY - d.requests;
    return Math.max(0, st === "verify" ? Math.min(day, CAP_VERIFY_TOTAL - l.verify_total) : day);
  }
  /** count one request (crash-safe write-then-rename) BEFORE it is sent; false = a cap is reached */
  reserve(st: "verify" | "r4c", firstOfRun: boolean): { ok: true } | { ok: false; reason: string } {
    const l = this.read(), key = pacificDay(now()), d = this.day(l, key);
    if (d.requests >= CAP_PER_DAY) return { ok: false, reason: `daily cap: ${d.requests}/${CAP_PER_DAY} requests on ${key} (Pacific)` };
    if (st === "verify" && l.verify_total >= CAP_VERIFY_TOTAL) return { ok: false, reason: `verify cap: ${l.verify_total}/${CAP_VERIFY_TOTAL} requests ever` };
    d.requests++;
    if (st === "verify") { d.verify++; l.verify_total++; } else { d.r4c++; l.r4c_total++; if (firstOfRun) d.r4c_runs++; }
    l.days[key] = d; l.updated = now().toISOString();
    atomicWrite(this.path, JSON.stringify(l, null, 2) + "\n");
    return { ok: true };
  }
}

// ---- the guard: under the frozen MeteredBackend, around the frozen WorkerChatBackend --------------------------------
interface ReqRec { n: number; t: string; ms: number; status: number | string; model: string | null; prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null; content_json: boolean | null }
class GuardBackend implements AdChatBackend {
  readonly id = "worker";
  requests = 0; consecutive = 0; failures = 0;
  stop: { kind: "cap" | "storm" | "model"; reason: string } | null = null;
  readonly recs: ReqRec[] = [];
  constructor(private inner: AdChatBackend, private ledger: Ledger, private st: "verify" | "r4c", private recPath: string) {}
  async complete(req: AdChatRequest): Promise<AdChatResult> {
    if (this.stop) throw new CapReached();
    if (req.model !== JUDGE_MODEL || req.temperature !== 0) { this.stop = { kind: "model", reason: `refusing to send: request model ${req.model} temperature ${String(req.temperature)}` }; throw new CapReached(); }
    const r = this.ledger.reserve(this.st, this.requests === 0);
    if (!r.ok) { this.stop = { kind: "cap", reason: r.reason }; throw new CapReached(); }
    const n = ++this.requests, t0 = performance.now();
    const rec: ReqRec = { n, t: now().toISOString(), ms: 0, status: 0, model: null, prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, content_json: null };
    const done = () => { rec.ms = Math.round(performance.now() - t0); this.recs.push(rec); appendFileSync(this.recPath, redact(JSON.stringify(rec)) + "\n", { mode: 0o600 }); };
    try {
      const res = await this.inner.complete(req);
      rec.status = 200; rec.model = res.model ?? null;
      rec.prompt_tokens = res.usage.prompt_tokens; rec.completion_tokens = res.usage.completion_tokens; rec.reasoning_tokens = res.usage.reasoning_tokens;
      try { const p = JSON.parse(res.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); rec.content_json = !!p && typeof p === "object"; } catch { rec.content_json = false; }
      done();
      this.consecutive = 0;
      if (!res.model || !MODEL_OK.test(res.model)) {
        this.stop = { kind: "model", reason: `response model tag ${res.model ? JSON.stringify(res.model) : "(missing)"} is not gemma4 (gemma4:cloud / gemma4:31b family): stopped at once` };
        throw new CapReached(); // the frozen loop records nothing for this item and pauses; we exit 5
      }
      return res;
    } catch (e) {
      if (e instanceof CapReached) throw e;
      rec.status = e instanceof WorkerHttpError ? e.status : (e as Error)?.name === "AbortError" ? "timeout" : "network";
      done();
      if (rec.status === 429) this.stop = { kind: "storm", reason: `Worker 429 (${(e as WorkerHttpError).code ?? "cap"}): stopped` };
      else if (rec.status === "timeout" || rec.status === "network" || (typeof rec.status === "number" && rec.status >= 500)) {
        this.consecutive++; this.failures++;
        if (this.consecutive >= STORM_CONSECUTIVE || this.failures >= STORM_TOTAL) this.stop = { kind: "storm", reason: `${this.consecutive} consecutive / ${this.failures} total 5xx-network-timeout failures: stopped` };
      }
      throw e;
    }
  }
}

// ---- token + worker url ------------------------------------------------------------------------------------------
function readToken(): { path: string } {
  const path = resolve(process.env.BH_JUDGE_TOKEN_FILE || join(homedir(), ".config/brianharness/judge-cal-token"));
  if (!existsSync(path)) throw new Refused(`token file ${path} does not exist (InfrastructureBot's judge-cal device token; or set BH_JUDGE_TOKEN_FILE)`);
  const st = statSync(path);
  if (!st.isFile()) throw new Refused(`token file ${path} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Refused(`token file ${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}): run  chmod 600 "${path}"  and retry`);
  const tok = readFileSync(path, "utf8").trim();
  if (!tok) throw new Refused(`token file ${path} is empty`);
  if (/\s/.test(tok)) throw new Refused(`token file ${path} holds more than one token (whitespace inside)`);
  secret = tok;
  return { path };
}
function workerUrl(): URL {
  const raw = opt("--worker-url") ?? process.env.BH_WORKER_URL;
  if (!raw) throw new Refused("no Worker URL: pass --worker-url https://... or set BH_WORKER_URL");
  let u: URL;
  try { u = new URL(raw); } catch { throw new Refused("the Worker URL is not a URL"); }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(loop && u.protocol === "http:")) throw new Refused("the Worker URL must be https:// (http only for a loopback test server)");
  if (u.username || u.password || u.search) throw new Refused("the Worker URL must not carry credentials or a query");
  if (process.env.BH_JUDGE_TEST_NOW) {
    if (!loop) throw new Refused("BH_JUDGE_TEST_NOW (a test clock) is honoured only against a loopback test server");
    if (Number.isNaN(Date.parse(process.env.BH_JUDGE_TEST_NOW))) throw new Refused("BH_JUDGE_TEST_NOW is not a date");
    clockOverride = process.env.BH_JUDGE_TEST_NOW;
  }
  return u;
}

// ---- scoring (verify) ----------------------------------------------------------------------------------------------
type Gold = { id: string; codes: string[]; answer_first_violation: boolean; af_scored: boolean };
type Pred = { id: string; codes: string[]; answer_first: boolean };
function score(preds: Pred[], gold: Map<string, Gold>) {
  const cells: Record<string, { pos: number; tp: number; fp: number; fn: number }> = {};
  for (const c of [...LEAK_CODES, "answer_first"]) cells[c] = { pos: 0, tp: 0, fp: 0, fn: 0 };
  for (const p of preds) {
    const g0 = gold.get(p.id); if (!g0) continue;
    const g = new Set(g0.codes), q = new Set(p.codes);
    if (g0.af_scored) { if (g0.answer_first_violation) g.add("answer_first"); if (p.answer_first) q.add("answer_first"); }
    for (const [c, x] of Object.entries(cells)) { const gi = g.has(c), qi = q.has(c); if (gi) x.pos++; if (gi && qi) x.tp++; else if (qi) x.fp++; else if (gi) x.fn++; }
  }
  return cells;
}
const pct = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!; };
const readJsonl = <T>(p: string): T[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : []);
function selfSha(): string { try { return sha256(readFileSync(fileURLToPath(import.meta.url))); } catch { return "unknown"; } }

async function main(): Promise<number> {
  if (stage === "manifest") {
    const mf = join(dirname(fileURLToPath(import.meta.url)), "MANIFEST.json");
    say(`runner.mjs sha256 ${selfSha()}`);
    say(existsSync(mf) ? readFileSync(mf, "utf8") : "(no MANIFEST.json next to runner.mjs)");
    return EXIT.complete;
  }
  if (stage !== "verify" && stage !== "r4c") { warn("usage: node runner.mjs verify | r4c --in <inputs.jsonl> | manifest   [--worker-url https://...] [--out DIR] [--max-calls N]"); return EXIT.refused; }
  const jm = opt("--judge-model");
  if (jm !== undefined && jm !== JUDGE_MODEL) throw new Refused(`--judge-model ${jm} refused: only ${JUDGE_MODEL} is allowed`);
  if (opt("--temperature") !== undefined && Number(opt("--temperature")) !== 0) throw new Refused("temperature is fixed at 0");
  const url = workerUrl();
  const tok = readToken();
  const mfPath = join(dirname(fileURLToPath(import.meta.url)), "MANIFEST.json");
  const self = selfSha();
  let manifestOk: boolean | null = null;
  if (existsSync(mfPath)) { try { manifestOk = (JSON.parse(readFileSync(mfPath, "utf8")) as { runner_mjs_sha256?: string }).runner_mjs_sha256 === self; } catch { manifestOk = false; } }
  if (manifestOk === false) throw new Refused("runner.mjs does not match MANIFEST.json runner_mjs_sha256: the bundle was altered; re-copy it");

  const outDir = resolve(opt("--out") ?? join(homedir(), "BrianHarness/judge-runs", stage));
  let inPath: string, inputsText: string;
  if (stage === "verify") {
    inputsText = VERIFY_INPUTS;
    if (sha256(inputsText) !== BUILD.verify_inputs_sha256) throw new Refused("bundled verify inputs do not match their recorded sha256");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    inPath = join(outDir, "inputs.jsonl");
    if (!existsSync(inPath) || readFileSync(inPath, "utf8") !== inputsText) atomicWrite(inPath, inputsText, 0o644);
  } else {
    const p = opt("--in");
    if (!p) throw new Refused("r4c needs --in <path to the R4c inputs.jsonl the Researcher released>");
    inPath = resolve(p);
    if (!existsSync(inPath)) throw new Refused(`--in ${inPath} does not exist`);
    inputsText = readFileSync(inPath, "utf8");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }
  const items = inputsText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as PredictInput);
  const ledger = new Ledger(resolve(process.env.BH_JUDGE_LEDGER || join(homedir(), ".config/brianharness/judge-cal-ledger.json")));
  ledger.lock();
  try {
    if (stage === "r4c") { const d = ledger.day(ledger.read()); if (d.r4c_runs >= 1) throw new Refused(`R4c already ran today (${pacificDay(now())} Pacific): one R4c run per day; rerun tomorrow to resume`); }
    const userCap = opt("--max-calls") !== undefined ? Number(opt("--max-calls")) : CAP_PER_DAY;
    if (!Number.isInteger(userCap) || userCap < 1) throw new Refused("--max-calls must be a positive integer");
    const budget = Math.min(userCap, ledger.remaining(stage));
    const recPath = join(outDir, "requests.jsonl");
    const guard = new GuardBackend(new WorkerChatBackend({ baseUrl: url.origin + url.pathname.replace(/\/$/, ""), token: () => secret }), ledger, stage, recPath);
    const startDone = readJsonl<DoneLine>(join(outDir, "ckpt/done.jsonl")).length;
    let r: FreezeRunResult | null = null, refused: string | null = null;
    if (budget >= 1) {
      try {
        // the frozen CLI's (scripts/ad-leak-freeze.ts @ 3b425dd) exact runFreeze call for --judge worker
        r = await runFreeze({ items, inputsText, backend: guard, checkpointDir: join(outDir, "ckpt"), outPath: join(outDir, "predictions.jsonl"), maxCalls: budget, retries: 1, deadlineMs: 90_000,
          config: { commit: BUILD.frozen_commit, leak_judge_prompt_id: LEAK_JUDGE_PROMPT_ID, judge_model: JUDGE_MODEL, actor_model: ACTOR_MODEL, temperature: 0, uncertain_policy: "positive", backend: "worker" },
          log: (s) => say(s) });
      } catch (e) { if (e instanceof FreezeRefused || (e instanceof Error && /judge model/i.test(e.message))) refused = e.message; else throw e; }
    }
    if (refused) throw new Refused(refused);
    const stop = guard.stop ?? (budget < 1 ? { kind: "cap" as const, reason: `no budget left: ${ledger.remaining(stage)} (${stage === "verify" ? `verify ${CAP_VERIFY_TOTAL} ever, ` : ""}${CAP_PER_DAY}/day Pacific)` } : null);
    const code = stop?.kind === "model" ? EXIT.model : stop?.kind === "storm" || r?.stopped === "worker_cap" ? EXIT.storm : r?.status === "complete" ? EXIT.complete : EXIT.paused;
    // ---- summary ----
    const l = ledger.read(), today = pacificDay(now()), d = ledger.day(l, today);
    const recs = guard.recs, lat = recs.map((x) => x.ms);
    const sum = (k: "prompt_tokens" | "completion_tokens" | "reasoning_tokens") => recs.reduce((s, x) => s + (x[k] ?? 0), 0);
    const models: Record<string, number> = {}; for (const x of recs) if (x.status === 200) models[x.model ?? "(missing)"] = (models[x.model ?? "(missing)"] ?? 0) + 1;
    const http: Record<string, number> = {}; for (const x of recs) http[String(x.status)] = (http[String(x.status)] ?? 0) + 1;
    const doneLines = readJsonl<DoneLine>(join(outDir, "ckpt/done.jsonl"));
    const summary: Record<string, unknown> = {
      schema: "bh-judge-run-summary/1", runner: RUNNER_VERSION, runner_mjs_sha256: self, manifest_match: manifestOk, stage, exit_code: code,
      status: code === 0 ? "complete" : code === 3 ? "paused (cap)" : code === 4 ? "stopped (worker 429 / 5xx storm)" : "stopped (model tag)", stop_reason: stop?.reason ?? r?.stopped ?? null,
      items: { total: items.length, done: doneLines.length, done_this_run: doneLines.length - startDone },
      requests_this_run: guard.requests, today: { date_pacific: today, requests: d.requests, cap: CAP_PER_DAY }, verify_total: { requests: l.verify_total, cap: CAP_VERIFY_TOTAL }, r4c_runs_today: d.r4c_runs,
      tokens_this_run: { prompt: sum("prompt_tokens"), completion: sum("completion_tokens"), reasoning: sum("reasoning_tokens") }, models_seen: models, http_status: http,
      latency_ms: { median: pct(lat, 0.5), p95: pct(lat, 0.95), max: lat.length ? Math.max(...lat) : null }, replies_not_json: recs.filter((x) => x.content_json === false).length,
      retries: doneLines.reduce((s, x) => s + x.attempts - 1, 0), final_status: doneLines.reduce<Record<string, number>>((m, x) => { m[x.pred.status] = (m[x.pred.status] ?? 0) + 1; return m; }, {}),
      frozen_commit: BUILD.frozen_commit, prompt_id: LEAK_JUDGE_PROMPT_ID, judge_model: JUDGE_MODEL, actor_model: ACTOR_MODEL, temperature: 0,
      worker_host: url.host, token_file: tok.path, inputs_sha256: sha256(inputsText), ...(clockOverride ? { test_clock: clockOverride } : {}),
      outputs: code === 0 ? ["predictions.jsonl", "predictions.meta.json", ...(stage === "verify" ? ["mock-predictions.jsonl", "report.txt"] : []), "requests.jsonl", "summary.json"] : ["requests.jsonl", "summary.json"],
      written_at: now().toISOString(),
    };
    const lines: string[] = [];
    if (stage === "verify" && r?.status === "complete") {
      // the mock judge on the SAME items with the SAME frozen code (offline, in-process, no ledger, no network)
      const tmp = mkdtempSync(join(tmpdir(), "bh-judge-mock-"));
      try {
        await runFreeze({ items, inputsText, backend: new MockJudgeBackend(), checkpointDir: join(tmp, "ckpt"), outPath: join(outDir, "mock-predictions.jsonl"), maxCalls: 1000, retries: 1, deadlineMs: 60_000,
          config: { commit: BUILD.frozen_commit, leak_judge_prompt_id: LEAK_JUDGE_PROMPT_ID, judge_model: JUDGE_MODEL, actor_model: ACTOR_MODEL, temperature: 0, uncertain_policy: "positive", backend: "mock" } });
      } finally { rmSync(tmp, { recursive: true, force: true }); }
      const gold = new Map(VERIFY_GOLD.split("\n").filter(Boolean).map((x) => JSON.parse(x) as Gold).map((g) => [g.id, g]));
      const J = score(readJsonl<Pred>(join(outDir, "predictions.jsonl")), gold), M = score(readJsonl<Pred>(join(outDir, "mock-predictions.jsonl")), gold);
      const f = (x: number, dd: number) => (dd ? (x / dd).toFixed(3) : "  n/a");
      const unc = doneLines.filter((x) => x.pred.uncertain.length || x.pred.answer_first_judge === "uncertain").length;
      lines.push(`R4 verify (30 items, R4 dev+test, NOT R4c): judge ${JUDGE_MODEL} vs mock, same items, frozen ${BUILD.frozen_commit.slice(0, 12)} ${LEAK_JUDGE_PROMPT_ID}`);
      lines.push(`uncertain: ${unc}/${doneLines.length} items`);
      lines.push(`code           pos | judge  tp  fp  fn      P      R | mock   tp  fp  fn      P      R`);
      for (const c of Object.keys(J)) { const x = J[c]!, y = M[c]!; lines.push(`${c.padEnd(14)} ${String(x.pos).padStart(3)} |      ${String(x.tp).padStart(3)} ${String(x.fp).padStart(3)} ${String(x.fn).padStart(3)}  ${f(x.tp, x.tp + x.fp)}  ${f(x.tp, x.tp + x.fn)} |      ${String(y.tp).padStart(3)} ${String(y.fp).padStart(3)} ${String(y.fn).padStart(3)}  ${f(y.tp, y.tp + y.fp)}  ${f(y.tp, y.tp + y.fn)}`); }
      lines.push("(answer_first scored on reply units with context only; the mock is tuned on R4: in-sample)");
      summary.verify_scores = { judge: J, mock: M, uncertain_items: unc };
      atomicWrite(join(outDir, "report.txt"), lines.join("\n") + "\n", 0o644);
    }
    atomicWrite(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", 0o644);
    say(`\n== judge-runner ${stage}: exit ${code} (${String(summary.status)})${stop ? ` · ${stop.reason}` : ""}`);
    say(`items ${doneLines.length}/${items.length} done · requests this run ${guard.requests} · today ${d.requests}/${CAP_PER_DAY} (${today} Pacific) · verify total ${l.verify_total}/${CAP_VERIFY_TOTAL}`);
    say(`tokens this run: prompt ${sum("prompt_tokens")} completion ${sum("completion_tokens")} reasoning ${sum("reasoning_tokens")} · models seen ${JSON.stringify(models)} · http ${JSON.stringify(http)}`);
    say(`latency ms median ${String(summary.latency_ms && (summary.latency_ms as { median: unknown }).median)} p95 ${String((summary.latency_ms as { p95: unknown }).p95)} · replies not JSON ${String(summary.replies_not_json)} · retries ${String(summary.retries)}`);
    for (const x of lines) say(x);
    say(`summary: ${join(outDir, "summary.json")}`);
    if (code === 3 || code === 4) say("resumable: rerun the SAME command later (a cap resets on the next Pacific day; a storm: wait, then rerun).");
    if (code === 5) say("STOP: do not rerun. Send summary.json + requests.jsonl back to the Engineer.");
    if (code === 0 && stage === "verify") say("verify complete: STOP here and send the outputs back. R4c only on the Engineer's go.");
    return code;
  } finally { ledger.unlock(); }
}

main().then((c) => process.exit(c), (e) => {
  if (e instanceof Refused) { warn(`judge-runner: refused: ${e.message}`); process.exit(EXIT.refused); }
  warn(`judge-runner: unexpected error: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`); process.exit(EXIT.error);
});
