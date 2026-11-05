// The Mac judge runner (scripts/judge-mac): builds the BUNDLE, copies it outside the repo and runs it with plain
// `node` from a temp HOME against a local fake judge (127.0.0.1). Never the real Worker, never a real token.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockJudgeBackend } from "../src/actor-director/leak-judge.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
const PIN = join(ROOT, "../wt-freeze-3b425dd");
const HAVE = existsSync(join(PIN, "packages/core/src/actor-director/leak-freeze.ts")) && existsSync(join(ROOT, "../research-runs/r4-live-check/inputs.jsonl"));
const NODE = process.env.BH_JM_NODE || process.execPath; // BH_JM_NODE=/path/to/node18 checks the minimum version
const FAKE = "tok_FAKE_judgecal_9f8e7d6c5b4a3210";
let T = "", BUNDLE = "", server: Server, URL_ = "";
// fake judge behaviour
const S = { model: "gemma4:31b" as string | null, status: [] as number[], body500: "", requests: 0, bad: [] as string[] };
const reset = () => { S.model = "gemma4:31b"; S.status = []; S.body500 = ""; S.requests = 0; S.bad = []; };
const mock = new MockJudgeBackend();

before(async () => {
  if (!HAVE) return;
  T = mkdtempSync(join(tmpdir(), "bh-jm-test-"));
  const { buildBundle } = await import("../../../scripts/judge-mac/build.ts");
  const b = await buildBundle(join(T, "build"), { tar: true, allowDirty: true });
  // unpack the tarball somewhere with no node_modules anywhere above it
  mkdirSync(join(T, "mac"));
  await new Promise<void>((res, rej) => execFile("tar", ["-xzf", b.tarPath!, "-C", join(T, "mac")], (e) => (e ? rej(e) : res())));
  BUNDLE = join(T, "mac/brianharness-judge-runner/runner.mjs");
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      S.requests++;
      if (req.url !== "/v1/chat/completions" || req.headers["x-bh-role"] !== "judge" || req.headers.authorization !== `Bearer ${FAKE}`) S.bad.push(`${req.url} ${String(req.headers["x-bh-role"])} auth-ok=${req.headers.authorization === `Bearer ${FAKE}`}`);
      const j = JSON.parse(body) as { model: string; temperature: number; messages: Array<{ role: "system" | "user"; content: string }>; max_tokens: number; stream: boolean };
      if (j.model !== "gemma4:cloud" || j.temperature !== 0 || j.stream !== false) S.bad.push(`model ${j.model} t ${j.temperature}`);
      const st = S.status.length ? S.status.shift()! : 200;
      if (st !== 200) { res.writeHead(st, { "content-type": "application/json" }); res.end(S.body500 || JSON.stringify({ error: { code: st === 429 ? "judge_cap" : "upstream", role: "judge", message: "x" } })); return; }
      const r = await mock.complete({ role: "judge", model: j.model, messages: j.messages, maxTokens: j.max_tokens });
      res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": "50" });
      res.end(JSON.stringify({ ...(S.model ? { model: S.model } : {}), choices: [{ message: { content: r.text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  URL_ = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server?.close(); if (T) rmSync(T, { recursive: true, force: true }); });

let n = 0;
function home(tokenMode = 0o600, token = FAKE + "\n") {
  const h = join(T, `home${++n}`);
  mkdirSync(join(h, ".config/brianharness"), { recursive: true });
  if (token !== null) { writeFileSync(join(h, ".config/brianharness/judge-cal-token"), token); chmodSync(join(h, ".config/brianharness/judge-cal-token"), tokenMode); }
  return h;
}
const all: string[] = [];
function run(h: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile(NODE, [BUNDLE, ...args], { cwd: h, env: { PATH: process.env.PATH ?? "", HOME: h, BH_WORKER_URL: URL_, ...env } }, (e, so, se) => {
      const out = so + se; all.push(out);
      res({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out });
    });
  });
}
const ledger = (h: string) => JSON.parse(readFileSync(join(h, ".config/brianharness/judge-cal-ledger.json"), "utf8"));
const summary = (h: string, st = "verify") => JSON.parse(readFileSync(join(h, "BrianHarness/judge-runs", st, "summary.json"), "utf8"));
function seed(h: string, l: object) { writeFileSync(join(h, ".config/brianharness/judge-cal-ledger.json"), JSON.stringify({ schema: "bh-judge-ledger/1", tz: "America/Los_Angeles", caps: { verify_total: 35, per_day: 95 }, verify_total: 0, r4c_total: 0, days: {}, updated: null, ...l })); }
function r4cInputs(h: string, k = 30) {
  const lines = readFileSync(join(ROOT, "../research-runs/r4-live-check/inputs.jsonl"), "utf8").split("\n").filter(Boolean).slice(0, k).map((l, i) => JSON.stringify({ ...JSON.parse(l), id: `fake-r4c-${i}` }));
  const p = join(h, "fake-r4c.jsonl"); writeFileSync(p, lines.join("\n") + "\n"); return p;
}
const D1 = "2026-11-05T07:30:00Z" /* 23:30 Nov 4 Pacific */, D2 = "2026-11-05T08:30:00Z" /* 00:30 Nov 5 Pacific */;
function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); }

test("JM.1 bundled runner, temp HOME, fake judge: verify completes, 30 requests counted, report + summary, gemma4:31b accepted", { skip: !HAVE }, async () => {
  reset(); const h = home();
  const r = await run(h, ["verify", "--judge-model", "gemma4:cloud"], { BH_JUDGE_TEST_NOW: D1 });
  assert.equal(r.code, 0, r.out);
  assert.equal(S.requests, 30); assert.deepEqual(S.bad, []);
  const s = summary(h);
  assert.equal(s.exit_code, 0); assert.equal(s.requests_this_run, 30); assert.deepEqual(s.models_seen, { "gemma4:31b": 30 });
  assert.deepEqual(s.today, { date_pacific: "2026-11-04", requests: 30, cap: 95 }); assert.deepEqual(s.verify_total, { requests: 30, cap: 35 });
  assert.deepEqual(s.tokens_this_run, { prompt: 3000, completion: 600, reasoning: 0 }); assert.equal(s.manifest_match, true);
  const out = join(h, "BrianHarness/judge-runs/verify");
  for (const f of ["predictions.jsonl", "predictions.meta.json", "mock-predictions.jsonl", "report.txt", "requests.jsonl", "summary.json", "ckpt/done.jsonl"]) assert.ok(existsSync(join(out, f)), f);
  assert.match(readFileSync(join(out, "report.txt"), "utf8"), /sensor .*\|/);
  assert.equal(readFileSync(join(out, "predictions.jsonl"), "utf8"), readFileSync(join(out, "mock-predictions.jsonl"), "utf8")); // the fake judge IS the mock
  assert.equal(statSync(join(h, ".config/brianharness/judge-cal-ledger.json")).mode & 0o777, 0o600);
  assert.equal(ledger(h).verify_total, 30);
  assert.match(r.out, /STOP here and send the outputs back/);
  // rerun: complete already, nothing sent
  reset(); const r2 = await run(h, ["verify"], { BH_JUDGE_TEST_NOW: D1 });
  assert.equal(r2.code, 0, r2.out); assert.equal(S.requests, 0);
});

test("JM.2 verify cap 35 ever: a pre-seeded 30 allows 5 more, then exit 3 with nothing sent", { skip: !HAVE }, async () => {
  reset(); const h = home(); seed(h, { verify_total: 30, days: { "2026-11-03": { requests: 30, verify: 30, r4c: 0, r4c_runs: 0 } } });
  const r = await run(h, ["verify"], { BH_JUDGE_TEST_NOW: D1 });
  assert.equal(r.code, 3, r.out); assert.equal(S.requests, 5); assert.equal(ledger(h).verify_total, 35);
  assert.match(r.out, /verify total 35\/35/);
  reset(); const r2 = await run(h, ["verify"], { BH_JUDGE_TEST_NOW: D2 });
  assert.equal(r2.code, 3, r2.out); assert.equal(S.requests, 0); assert.equal(summary(h).requests_this_run, 0);
});

test("JM.3 95/day across runs and stages (Pacific day); rollover with an injected clock; one R4c run per day", { skip: !HAVE }, async () => {
  reset(); const h = home(); const inp = r4cInputs(h);
  seed(h, { days: { "2026-11-04": { requests: 90, verify: 0, r4c: 90, r4c_runs: 0 } } });
  const v = await run(h, ["verify"], { BH_JUDGE_TEST_NOW: D1 });
  assert.equal(v.code, 3, v.out); assert.equal(S.requests, 5); assert.equal(ledger(h).days["2026-11-04"].requests, 95);
  reset(); const r = await run(h, ["r4c", "--in", inp], { BH_JUDGE_TEST_NOW: D1 });
  assert.equal(r.code, 3, r.out); assert.equal(S.requests, 0); // the day is spent: nothing sent, and no R4c run counted
  // the next Pacific day: R4c runs (capped by --max-calls), then a second R4c run that day is refused
  reset(); const r2 = await run(h, ["r4c", "--in", inp, "--max-calls", "4"], { BH_JUDGE_TEST_NOW: D2 });
  assert.equal(r2.code, 3, r2.out); assert.equal(S.requests, 4);
  const l = ledger(h); assert.deepEqual(l.days["2026-11-05"], { requests: 4, verify: 0, r4c: 4, r4c_runs: 1 }); assert.equal(l.days["2026-11-04"].requests, 95);
  reset(); const r3 = await run(h, ["r4c", "--in", inp], { BH_JUDGE_TEST_NOW: D2 });
  assert.equal(r3.code, 2, r3.out); assert.match(r3.out, /one R4c run per day/); assert.equal(S.requests, 0);
  // the day after: resumes from the frozen checkpoint and completes
  reset(); const r4 = await run(h, ["r4c", "--in", inp], { BH_JUDGE_TEST_NOW: "2026-11-06T18:00:00Z" });
  assert.equal(r4.code, 0, r4.out); assert.equal(S.requests, 26);
  assert.equal(readFileSync(join(h, "BrianHarness/judge-runs/r4c/predictions.jsonl"), "utf8").split("\n").filter(Boolean).length, 30);
  // drifted inputs on resume: the frozen tool refuses
  writeFileSync(inp, readFileSync(inp, "utf8").replace("fake-r4c-0", "fake-r4c-x"));
  reset(); const r5 = await run(h, ["r4c", "--in", inp], { BH_JUDGE_TEST_NOW: "2026-11-07T18:00:00Z" });
  assert.equal(r5.code, 2, r5.out); assert.match(r5.out, /refusing to resume/); assert.equal(S.requests, 0);
});

test("JM.4 model allowlist: --judge-model other refused; a non-gemma4 or missing response model tag stops at once (exit 5)", { skip: !HAVE }, async () => {
  reset(); const h = home();
  const r = await run(h, ["verify", "--judge-model", "gpt-oss:120b-cloud"]);
  assert.equal(r.code, 2); assert.match(r.out, /only gemma4:cloud/); assert.equal(S.requests, 0);
  reset(); S.model = "qwen3:32b";
  const r2 = await run(h, ["verify"]);
  assert.equal(r2.code, 5, r2.out); assert.equal(S.requests, 1); assert.match(r2.out, /"qwen3:32b" is not gemma4/);
  assert.deepEqual(summary(h).models_seen, { "qwen3:32b": 1 });
  const h2 = home(); reset(); S.model = null;
  const r3 = await run(h2, ["verify"]);
  assert.equal(r3.code, 5, r3.out); assert.equal(S.requests, 1); assert.match(r3.out, /\(missing\)/);
});

test("JM.5 token file: missing, empty, group/world-readable refused with chmod 600 hint; nothing sent", { skip: !HAVE }, async () => {
  reset();
  const a = await run(home(0o600, null as unknown as string), ["verify"]); assert.equal(a.code, 2); assert.match(a.out, /does not exist/);
  const b = await run(home(0o600, "  \n"), ["verify"]); assert.equal(b.code, 2); assert.match(b.out, /is empty/);
  const c = await run(home(0o644), ["verify"]); assert.equal(c.code, 2); assert.match(c.out, /chmod 600/);
  const d = await run(home(0o640), ["verify"]); assert.equal(d.code, 2); assert.match(d.out, /chmod 600/);
  const h = home(); const alt = join(h, "elsewhere-token"); writeFileSync(alt, FAKE); chmodSync(alt, 0o600);
  rmSync(join(h, ".config/brianharness/judge-cal-token"));
  const e = await run(h, ["verify", "--max-calls", "1"], { BH_JUDGE_TOKEN_FILE: alt, BH_JUDGE_TEST_NOW: D1 });
  assert.equal(e.code, 3, e.out); assert.equal(S.requests, 1); assert.deepEqual(S.bad, []);
  const u = await run(home(), ["verify"], { BH_WORKER_URL: "http://judge.example.invalid" }); assert.equal(u.code, 2); assert.match(u.out, /https/);
  const k = await run(home(), ["verify"], { BH_WORKER_URL: "https://judge.example.invalid", BH_JUDGE_TEST_NOW: D1 }); assert.equal(k.code, 2); assert.match(k.out, /loopback/);
  const w = await run(home(), ["verify"], { BH_WORKER_URL: "" }); assert.equal(w.code, 2); assert.match(w.out, /no Worker URL/);
});

test("JM.6 a 5xx storm stops (exit 4), retries counted; a 429 stops (exit 4); the token in an error body is never echoed", { skip: !HAVE }, async () => {
  reset(); S.status = [500, 502, 503, 503, 503]; S.body500 = JSON.stringify({ error: { code: "upstream", message: `echo Bearer ${FAKE}` } });
  const h = home();
  const r = await run(h, ["verify"]);
  assert.equal(r.code, 4, r.out); assert.equal(S.requests, 3); assert.equal(ledger(h).verify_total, 3);
  assert.deepEqual(summary(h).http_status, { "500": 1, "502": 1, "503": 1 });
  reset(); S.status = [429];
  const h2 = home(); const r2 = await run(h2, ["verify"]);
  assert.equal(r2.code, 4, r2.out); assert.equal(S.requests, 1); assert.match(r2.out, /429/);
  // the paused run resumes later
  reset(); const r3 = await run(h2, ["verify"]); assert.equal(r3.code, 0, r3.out); assert.equal(S.requests, 30); assert.equal(ledger(h2).verify_total, 31);
});

test("JM.7 tampered bundle refused; manifest pins every frozen module to 3b425dd", { skip: !HAVE }, async () => {
  const mf = JSON.parse(readFileSync(join(T, "mac/brianharness-judge-runner/MANIFEST.json"), "utf8"));
  assert.equal(mf.frozen_commit, "3b425dda90116f5cda7e0ca0d5f99625688888b5");
  for (const f of mf.frozen_modules) assert.equal(f.sha256, f.sha256_at_frozen_commit, f.path);
  for (const p of ["leak-judge", "leaks", "leak-predict", "leak-freeze", "director"]) assert.ok(mf.frozen_modules.some((f: { path: string }) => f.path === `packages/core/src/actor-director/${p}.ts`));
  assert.deepEqual(mf.wrapper_modules.map((w: { path: string }) => w.path).filter((p: string) => !p.startsWith("bundle:data")), ["scripts/judge-mac/runner.ts"]);
  const d = join(T, "tampered"); cpSync(join(T, "mac/brianharness-judge-runner"), d, { recursive: true });
  writeFileSync(join(d, "runner.mjs"), readFileSync(join(d, "runner.mjs"), "utf8") + "\n// x\n");
  reset(); const h = home();
  const r = await new Promise<{ code: number; out: string }>((res) => execFile(NODE, [join(d, "runner.mjs"), "verify"], { cwd: h, env: { PATH: process.env.PATH ?? "", HOME: h, BH_WORKER_URL: URL_ } }, (e, so, se) => { all.push(so + se); res({ code: e ? Number((e as { code?: number }).code) : 0, out: so + se }); }));
  assert.equal(r.code, 2, r.out); assert.match(r.out, /altered/); assert.equal(S.requests, 0);
});

test("JM.8 the fake token never appears in any output or any file the runner wrote", { skip: !HAVE }, async () => {
  assert.ok(all.length > 20);
  for (const o of all) assert.ok(!o.includes(FAKE), "token in output");
  for (const f of walk(T)) {
    if (f.endsWith("judge-cal-token") || f.endsWith("elsewhere-token")) continue;
    assert.ok(!readFileSync(f).includes(FAKE), `token in ${f}`);
  }
});
