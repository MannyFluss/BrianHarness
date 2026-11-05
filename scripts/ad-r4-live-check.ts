// R4 live-check (DirectorBot 6:00 PM PT): a ~30-item stratified sample of R4 dev+test (NEVER R4c) run through the
// FROZEN leak-judge freeze tool (scripts/ad-leak-freeze.ts at the pinned commit, unchanged) on a real judge, scored
// against the R4 labels next to the mock judge on the SAME items. This wrapper lives outside the frozen paths; it runs
// the freeze tool from a detached worktree at the pinned commit, so the judge code is exactly the frozen code.
//
//   inputs:  npx tsx scripts/ad-r4-live-check.ts inputs            -> research-runs/r4-live-check/{inputs.jsonl,ids.txt,manifest.json}
//   dry run: npx tsx scripts/ad-r4-live-check.ts run --fake-judge  -> a local fake judge (Worker-shaped HTTP), no network
//   live:    BH_WORKER_URL=https://<worker> BH_JUDGE_TOKEN=<token> \
//            npx tsx scripts/ad-r4-live-check.ts run --live --approved-token-use
//
// run: --judge-model gemma4:cloud (default), --max-calls 35 (default), temperature 0 (the freeze tool's), --retries 1.
// A local metering proxy (127.0.0.1) sits between the freeze tool and the judge: per-request latency, HTTP status,
// response-body model + usage, and whether the reply content is JSON. It forwards the Authorization header untouched and
// never logs or prints it; the token is read from the environment only (BH_JUDGE_TOKEN), never from a flag or a file.
// The run is resumable (the freeze tool's checkpoint); a paused run (cap reached) prints counts only, no P/R.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { LEAK_CODES } from "../packages/core/src/ad-contracts/index.ts";
import { MockJudgeBackend } from "../packages/core/src/actor-director/leak-judge.ts";

const PIN = "3b425dd", PROMPT_ID = "lj2-eeca9847", SEED = 20261104;
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const R4 = "/workspace/actor-director/research/R4/labels.jsonl";
const OUT = "/workspace/actor-director/research-runs/r4-live-check";
const PINNED_WT = "/workspace/actor-director/wt-freeze-3b425dd";
const a = process.argv.slice(2), cmd = a[0];
const opt = (k: string, d?: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const die = (m: string): never => { console.error("ad-r4-live-check: " + m); process.exit(2); };

type Item = { id: string; split: string; kind: string; group: string; unit: string; text: string; codes: string[]; answer_first_violation: boolean; context: string; note: string };
const loadR4 = (): Item[] => { if (/R4c/i.test(R4)) die("never R4c"); return readFileSync(R4, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((i) => i.split === "dev" || i.split === "test"); };
const afScored = (i: { unit: string; context: string }) => i.unit === "reply" && !!i.context;

function mulberry32(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function makeInputs() {
  const all = loadR4(), rnd = mulberry32(SEED);
  const shuffled = (xs: Item[]) => xs.map((x) => [rnd(), x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const picked = new Map<string, string>();
  const take = (pool: Item[], n: number, stratum: string) => { let k = 0; for (const it of shuffled(pool)) { if (k >= n) break; if (picked.has(it.id)) continue; picked.set(it.id, stratum); k++; } };
  // 3 positives per leak code (one clear, one subtle, one any) = 18; 3 answer-first violations (af_violation, no leak
  // code); 1 hard negative per leak-code group = 6; 3 valid answer-first replies (af_valid: answer_first's hard
  // negatives; that group has no hard_neg kind) = 30
  for (const c of LEAK_CODES) {
    const pos = all.filter((i) => i.codes.includes(c));
    take(pos.filter((i) => i.kind === "clear_pos"), 1, `pos:${c}`); take(pos.filter((i) => i.kind === "subtle_pos"), 1, `pos:${c}`); take(pos, 1, `pos:${c}`);
  }
  take(all.filter((i) => i.kind === "af_violation" && afScored(i) && i.answer_first_violation), 3, "pos:answer_first");
  for (const g of [...new Set(all.map((i) => i.group))].sort()) take(all.filter((i) => i.kind === "hard_neg" && i.group === g && !i.codes.length && !i.answer_first_violation), 1, `hard_neg:${g}`);
  take(all.filter((i) => i.kind === "af_valid" && afScored(i) && !i.codes.length && !i.answer_first_violation), 3, "clean:af_valid");
  const items = all.filter((i) => picked.has(i.id)); // R4 file order
  mkdirSync(OUT, { recursive: true });
  // the judge input carries no labels: {id, unit, context, note, text} only
  const inputs = items.map((i) => JSON.stringify({ id: i.id, unit: i.unit, context: i.context || null, note: i.note || null, text: i.text })).join("\n") + "\n";
  writeFileSync(join(OUT, "inputs.jsonl"), inputs);
  writeFileSync(join(OUT, "ids.txt"), items.map((i) => `${i.id}\t${i.split}\t${picked.get(i.id)}\tgold=${[...i.codes, ...(afScored(i) && i.answer_first_violation ? ["answer_first"] : [])].join(",") || "-"}`).join("\n") + "\n");
  const pos: Record<string, number> = {};
  for (const i of items) { for (const c of i.codes) pos[c] = (pos[c] ?? 0) + 1; if (afScored(i) && i.answer_first_violation) pos.answer_first = (pos.answer_first ?? 0) + 1; }
  const manifest = { source: R4, source_sha256: createHash("sha256").update(readFileSync(R4)).digest("hex"), splits: ["dev", "test"], seed: SEED, n: items.length,
    inputs_sha256: createHash("sha256").update(inputs).digest("hex"), positives: pos, negatives: items.filter((i) => !i.codes.length && !(afScored(i) && i.answer_first_violation)).length,
    strata: Object.fromEntries(items.map((i) => [i.id, picked.get(i.id)])) };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${OUT}/inputs.jsonl (${items.length} items, seed ${SEED}, sha256 ${manifest.inputs_sha256.slice(0, 12)}); positives ${JSON.stringify(pos)}; negatives ${manifest.negatives}`);
  console.log("ids:\n" + readFileSync(join(OUT, "ids.txt"), "utf8"));
}

function pinnedWorktree() {
  const pin = execFileSync("git", ["rev-parse", PIN + "^{commit}"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!existsSync(PINNED_WT)) execFileSync("git", ["worktree", "add", "--detach", PINNED_WT, pin], { cwd: ROOT, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PINNED_WT, encoding: "utf8" }).trim();
  if (head !== pin) die(`${PINNED_WT} is at ${head.slice(0, 12)}, not the pinned ${PIN}`);
  if (!existsSync(join(PINNED_WT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(PINNED_WT, "node_modules"));
  return pin;
}

type Req = { n: number; ms: number; status: number; model: string | null; prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null; content_json: boolean | null };
/** 127.0.0.1 metering proxy: forwards to `upstream`, records latency/status/usage; never logs headers or bodies */
async function meteringProxy(upstream: string, logPath: string) {
  let n = 0;
  const reqs: Req[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const t0 = performance.now(), k = ++n;
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(h)) headers[h] = v;
      let status = 0, text = "", out: Record<string, string> = {};
      try {
        const r = await fetch(upstream.replace(/\/$/, "") + (req.url ?? "/"), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(120_000) });
        status = r.status; text = await r.text();
        r.headers.forEach((v, h) => { if (/^(content-type|x-ratelimit-[a-z-]+|x-bh-[a-z-]+|ratelimit[a-z-]*|retry-after)$/i.test(h)) out[h] = v; });
      } catch (e) { status = 599; text = JSON.stringify({ error: { code: "proxy_upstream_error", message: e instanceof Error ? e.name : "error" } }); out = { "content-type": "application/json" }; }
      const ms = performance.now() - t0;
      let j: { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } } | null = null;
      try { j = JSON.parse(text); } catch { j = null; }
      const content = j?.choices?.[0]?.message?.content;
      let cj: boolean | null = null;
      if (status === 200 && typeof content === "string") { try { const p = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); cj = !!p && typeof p === "object"; } catch { cj = false; } }
      const rec: Req = { n: k, ms: Math.round(ms), status, model: typeof j?.model === "string" ? j.model : null, prompt_tokens: j?.usage?.prompt_tokens ?? null, completion_tokens: j?.usage?.completion_tokens ?? null, reasoning_tokens: j?.usage?.completion_tokens_details?.reasoning_tokens ?? null, content_json: cj };
      reqs.push(rec); appendFileSync(logPath, JSON.stringify(rec) + "\n", { mode: 0o600 });
      res.writeHead(status === 599 ? 502 : status, out); res.end(text);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, reqs, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** a Worker-shaped fake judge for the dry run: the MockJudgeBackend's verdicts, seeded latency, one 500 and one
 * unparseable reply injected (exercises retry + schema-failure accounting); checks the bearer token, model and
 * temperature 0 without printing them */
async function fakeJudge(token: string, model: string) {
  const mock = new MockJudgeBackend(), rnd = mulberry32(7);
  let n = 0; const seen = { badAuth: 0, badModel: 0, badTemp: 0 };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const k = ++n;
      if (req.headers.authorization !== `Bearer ${token}`) { seen.badAuth++; res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unauthorized" } })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number; temperature?: number };
      if (body.model !== model) seen.badModel++;
      if (body.temperature !== 0) seen.badTemp++;
      await new Promise((r) => setTimeout(r, 40 + Math.round(rnd() * 360)));
      if (k === 3) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "upstream_error", role: "judge" } })); return; }
      const out = await mock.complete({ role: String(req.headers["x-bh-role"] ?? ""), model: body.model, messages: body.messages, maxTokens: body.max_tokens });
      const content = k === 7 ? "Sorry, I can't produce JSON for this one." : out.text;
      res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": String(100 - k) });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1800 + Math.round(rnd() * 400), completion_tokens: 60 + Math.round(rnd() * 80), completion_tokens_details: { reasoning_tokens: 0 } } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function freezeTool(args: string[], env: NodeJS.ProcessEnv, secret: string | null): Promise<{ code: number; out: string }> {
  const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsx, join(PINNED_WT, "scripts/ad-leak-freeze.ts"), ...args], { cwd: PINNED_WT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code: code ?? 1, out: secret ? out.split(secret).join("[redacted]") : out }));
  });
}

type Pred = { id: string; codes: string[]; answer_first: boolean };
type Done = { id: string; attempts: number; pred: { status: string; uncertain: string[]; answer_first_judge: unknown; verdict: string } };
const readJsonl = <T>(p: string): T[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : []);
const pct = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!; };

function score(preds: Pred[], gold: Map<string, Item>) {
  const cells: Record<string, { pos: number; tp: number; fp: number; fn: number }> = {};
  for (const c of [...LEAK_CODES, "answer_first"]) cells[c] = { pos: 0, tp: 0, fp: 0, fn: 0 };
  for (const p of preds) {
    const it = gold.get(p.id)!, g = new Set(it.codes), q = new Set(p.codes);
    if (afScored(it)) { if (it.answer_first_violation) g.add("answer_first"); if (p.answer_first) q.add("answer_first"); }
    for (const [c, x] of Object.entries(cells)) { const gi = g.has(c), qi = q.has(c); if (gi) x.pos++; if (gi && qi) x.tp++; else if (qi) x.fp++; else if (gi) x.fn++; }
  }
  return cells;
}

async function run() {
  const live = a.includes("--live"), fake = a.includes("--fake-judge");
  if (live === fake) die("run needs exactly one of --live | --fake-judge");
  if (live && !a.includes("--approved-token-use")) die("--live needs --approved-token-use (a live judge run spends judge quota)");
  const judgeModel = opt("--judge-model", "gemma4:cloud")!, maxCalls = opt("--max-calls", "35")!;
  const inPath = join(OUT, "inputs.jsonl");
  if (!existsSync(inPath)) die(`no ${inPath}: run \`inputs\` first`);
  let upstream = "", token = "", fj: Awaited<ReturnType<typeof fakeJudge>> | null = null;
  if (live) {
    upstream = process.env.BH_WORKER_URL || die("--live needs BH_WORKER_URL in the environment");
    token = process.env.BH_JUDGE_TOKEN || die("--live needs BH_JUDGE_TOKEN in the environment (env only; never a flag)");
  }
  const pin = pinnedWorktree();
  const dir = join(OUT, live ? "live" : "dryrun"); mkdirSync(dir, { recursive: true });
  if (!live) {
    token = "fake-" + randomBytes(12).toString("hex");
    fj = await fakeJudge(token, judgeModel); upstream = fj.url;
    for (const f of ["checkpoint", "predictions.jsonl", "predictions.meta.json", "requests.jsonl"]) rmSync(join(dir, f), { recursive: true, force: true });
  }
  const proxy = await meteringProxy(upstream, join(dir, "requests.jsonl"));
  const common = ["--in", inPath, "--commit", PIN, "--prompt-id", PROMPT_ID, "--judge-model", judgeModel, "--retries", "1"];
  const env = { ...process.env, BH_WORKER_URL: proxy.url, BH_JUDGE_TOKEN: token };
  console.log(`judge run: ${live ? "LIVE" : "DRY RUN (local fake judge)"}; freeze tool ${PINNED_WT}/scripts/ad-leak-freeze.ts @ ${pin.slice(0, 12)}; ${PROMPT_ID}; ${judgeModel}; temperature 0; --max-calls ${maxCalls}; token from env (${live ? "BH_JUDGE_TOKEN" : "generated fake"}), never printed`);
  const r = await freezeTool([...common, "--out", join(dir, "predictions.jsonl"), "--checkpoint", join(dir, "checkpoint"), "--max-calls", maxCalls, "--judge", "worker", "--approved-token-use"], env, token);
  await proxy.close(); await fj?.close();
  console.log(r.out.trim().split("\n").map((l) => "  | " + l).join("\n"));
  // mock judge on the SAME items, same frozen code (fresh checkpoint every time; offline)
  const mdir = join(OUT, "mock"); rmSync(mdir, { recursive: true, force: true }); mkdirSync(mdir, { recursive: true });
  const m = await freezeTool([...common, "--out", join(mdir, "predictions.jsonl"), "--checkpoint", join(mdir, "checkpoint"), "--max-calls", "1000", "--judge", "mock"], { ...process.env, BH_JUDGE_TOKEN: "" }, null);
  if (m.code !== 0) die("mock run failed:\n" + m.out);

  const gold = new Map(loadR4().map((i) => [i.id, i]));
  const reqs = readJsonl<Req>(join(dir, "requests.jsonl"));
  const done = readJsonl<Done>(join(dir, "checkpoint/done.jsonl"));
  const lat = reqs.map((q) => q.ms), sum = (k: keyof Req) => reqs.reduce((s, q) => s + (typeof q[k] === "number" ? (q[k] as number) : 0), 0);
  const models: Record<string, number> = {}; for (const q of reqs) if (q.model) models[q.model] = (models[q.model] ?? 0) + 1;
  const statuses: Record<string, number> = {}; for (const q of reqs) statuses[q.status] = (statuses[q.status] ?? 0) + 1;
  const n = done.length;
  const unc = { any: done.filter((d) => d.pred.uncertain.length || d.pred.answer_first_judge === "uncertain").length, af: done.filter((d) => d.pred.answer_first_judge === "uncertain").length, byCode: Object.fromEntries(LEAK_CODES.map((c) => [c, done.filter((d) => d.pred.uncertain.includes(c)).length])) };
  const finalStatus: Record<string, number> = {}; for (const d of done) finalStatus[d.pred.status] = (finalStatus[d.pred.status] ?? 0) + 1;
  const lines: string[] = [];
  const P = (s: string) => { lines.push(s); console.log(s); };
  P(`\n== R4 live-check ${live ? "LIVE" : "DRY RUN (fake judge)"}: ${n}/${gold.size ? readJsonl(inPath).length : 0} items judged; status ${r.code === 0 ? "complete" : r.code === 3 ? "PAUSED (cap)" : "refused/failed (exit " + r.code + ")"}`);
  P(`requests ${reqs.length} (HTTP ${JSON.stringify(statuses)}); retries ${done.reduce((s, d) => s + d.attempts - 1, 0)} (items needing one: ${done.filter((d) => d.attempts > 1).length})`);
  P(`latency ms: median ${pct(lat, 0.5)} p95 ${pct(lat, 0.95)} (max ${lat.length ? Math.max(...lat) : null})`);
  P(`schema failures: ${reqs.filter((q) => q.content_json === false).length} replies not JSON; final item status ${JSON.stringify(finalStatus)}`);
  P(`usage (response bodies): models ${JSON.stringify(models)}; prompt ${sum("prompt_tokens")} completion ${sum("completion_tokens")} reasoning ${sum("reasoning_tokens")} tokens`);
  P(`uncertain: any ${unc.any}/${n}; answer_first ${unc.af}/${n}; by code ${JSON.stringify(unc.byCode)}`);
  if (fj) P(`fake judge checks: bad auth ${fj.seen.badAuth}, model != ${judgeModel} ${fj.seen.badModel}, temperature != 0 ${fj.seen.badTemp}`);
  const jp = readJsonl<Pred>(join(dir, "predictions.jsonl")), mp = readJsonl<Pred>(join(mdir, "predictions.jsonl"));
  if (r.code === 0 && jp.length) {
    const J = score(jp, gold), M = score(mp, gold), f = (x: number, d: number) => (d ? (x / d).toFixed(3) : "  n/a");
    P(`\ncode           pos | judge  tp  fp  fn      P      R | mock   tp  fp  fn      P      R`);
    for (const c of Object.keys(J)) { const x = J[c]!, y = M[c]!; P(`${c.padEnd(14)} ${String(x.pos).padStart(3)} |      ${String(x.tp).padStart(3)} ${String(x.fp).padStart(3)} ${String(x.fn).padStart(3)}  ${f(x.tp, x.tp + x.fp)}  ${f(x.tp, x.tp + x.fn)} |      ${String(y.tp).padStart(3)} ${String(y.fp).padStart(3)} ${String(y.fn).padStart(3)}  ${f(y.tp, y.tp + y.fp)}  ${f(y.tp, y.tp + y.fn)}`); }
    P(`(answer_first scored on reply units with context only, as the R4 baseline; mock = MockJudgeBackend, tuned on R4: in-sample)`);
  } else P("no predictions (run not complete): no P/R. Rerun the same command to resume from the checkpoint.");
  writeFileSync(join(dir, "report.txt"), lines.join("\n") + "\n");
  process.exit(r.code === 0 ? 0 : r.code === 3 ? 3 : 1);
}

if (cmd === "inputs") makeInputs();
else if (cmd === "run") await run();
else die("usage: ad-r4-live-check.ts inputs | run (--fake-judge | --live --approved-token-use) [--judge-model gemma4:cloud] [--max-calls 35]");
