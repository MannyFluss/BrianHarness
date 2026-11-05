/** Ruling A4: the leak-judge freeze run (resumable, hard per-run cap, durable checkpoint, refuse-on-mismatch, all-or-nothing output). Mock judge only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FreezeRefused, LEAK_JUDGE_PROMPT_ID, LeakGate, MockJudgeBackend, WorkerHttpError, predictAll, runFreeze } from "../src/actor-director/index.ts";
import type { AdChatBackend, AdChatRequest, PredictInput } from "../src/actor-director/index.ts";

const all: PredictInput[] = readFileSync(join(import.meta.dirname, "fixtures/r4-dev.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .map((it: any) => ({ id: it.id, unit: it.unit, context: it.context, note: it.note || null, text: it.text }));
const items = all.filter((it) => it.unit === "reply").slice(0, 12);
const text = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
const cfg = { commit: "c0ffee1", judge_model: "gemma4:cloud", actor_model: "gpt-oss:120b-cloud", uncertain_policy: "positive" as const, backend: "mock" };

class Recording implements AdChatBackend {
  readonly id = "rec"; readonly reqs: AdChatRequest[] = []; private inner = new MockJudgeBackend();
  constructor(private fail: (n: number) => Error | null = () => null) {}
  async complete(req: AdChatRequest) {
    this.reqs.push(req);
    const e = this.fail(this.reqs.length); if (e) throw e;
    const r = await this.inner.complete(req);
    return { ...r, model: req.model, usage: { prompt_tokens: 100, completion_tokens: r.usage.completion_tokens, reasoning_tokens: null }, headers: { "x-ratelimit-remaining": String(1000 - this.reqs.length) } };
  }
}

test("freeze run: two-day split with a hard per-run cap, one joint call per item at temperature 0, output only when complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ljf-")), ck = join(dir, "ck"), out = join(dir, "preds.jsonl");
  const b1 = new Recording();
  const r1 = await runFreeze({ items, inputsText: text, config: cfg, backend: b1, checkpointDir: ck, outPath: out, maxCalls: 5 });
  assert.equal(r1.status, "paused"); assert.equal(r1.stopped, "max_calls");
  assert.equal(r1.callsThisRun, 5); assert.equal(b1.reqs.length, 5); assert.equal(r1.doneTotal, 5);
  assert.ok(!existsSync(out), "no partial predictions"); assert.ok(!existsSync(out.replace(".jsonl", ".meta.json")));
  for (const q of b1.reqs) { assert.equal(q.temperature, 0); assert.equal(q.model, "gemma4:cloud"); assert.equal(q.role, "judge"); }
  assert.equal(statSync(join(ck, "done.jsonl")).mode & 0o077, 0, "checkpoint is private");
  // a resume with a different prompt id / model / commit / inputs is refused before any call
  const b0 = new Recording();
  await assert.rejects(runFreeze({ items, inputsText: text, config: { ...cfg, judge_model: "deepseek-v3.1:671b-cloud" }, backend: b0, checkpointDir: ck, outPath: out, maxCalls: 5 }), /judge_model/);
  await assert.rejects(runFreeze({ items, inputsText: text, config: { ...cfg, commit: "deadbee" }, backend: b0, checkpointDir: ck, outPath: out, maxCalls: 5 }), /commit/);
  await assert.rejects(runFreeze({ items, inputsText: text, config: { ...cfg, leak_judge_prompt_id: "lj1-11631f45" }, backend: b0, checkpointDir: ck, outPath: out, maxCalls: 5 }), FreezeRefused);
  await assert.rejects(runFreeze({ items: items.slice(1), inputsText: text.split("\n").slice(1).join("\n"), config: cfg, backend: b0, checkpointDir: ck, outPath: out, maxCalls: 5 }), /inputs_sha256/);
  await assert.rejects(runFreeze({ items, inputsText: text, config: { ...cfg, judge_model: "gpt-oss:20b-cloud" }, backend: b0, checkpointDir: ck, outPath: out, maxCalls: 5 }), /different model family/);
  assert.equal(b0.reqs.length, 0);
  // a torn last line (crash mid-write) only redoes that item
  appendFileSync(join(ck, "done.jsonl"), '{"id":"torn');
  const b2 = new Recording();
  const r2 = await runFreeze({ items, inputsText: text, config: cfg, backend: b2, checkpointDir: ck, outPath: out, maxCalls: 5 });
  assert.equal(r2.status, "paused"); assert.equal(r2.doneTotal, 10); assert.ok(!existsSync(out));
  const b3 = new Recording();
  const r3 = await runFreeze({ items, inputsText: text, config: cfg, backend: b3, checkpointDir: ck, outPath: out, maxCalls: 5 });
  assert.equal(r3.status, "complete"); assert.equal(b3.reqs.length, 2);
  const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), items.map((i) => i.id), "input order");
  for (const l of lines) assert.deepEqual(Object.keys(l), ["id", "codes", "answer_first"]);
  // identical to an uninterrupted batch run
  const ref = await predictAll(items, new LeakGate({ backend: new MockJudgeBackend(), model: "gemma4:cloud", actorModel: "gpt-oss:120b-cloud", deadlineMs: 60_000 }));
  assert.deepEqual(lines, ref.map((p) => ({ id: p.id, codes: p.codes, answer_first: p.answer_first })));
  const meta = JSON.parse(readFileSync(out.replace(".jsonl", ".meta.json"), "utf8"));
  assert.equal(meta.leak_judge_prompt_id, LEAK_JUDGE_PROMPT_ID); assert.equal(meta.temperature, 0); assert.equal(meta.requests_total, 12);
  assert.equal(meta.runs.length, 3); assert.deepEqual(meta.usage_total.models, { "gemma4:cloud": 12 }); assert.equal(meta.usage_total.prompt_tokens, 1200);
  assert.ok("mind_reading" in meta.uncertain.byCode && typeof meta.uncertain.answer_first === "number");
  assert.ok(!readdirSync(dir).some((f) => /partial|\.tmp$/.test(f)));
});

test("freeze run: one retry counts against the cap; a Worker 429 stops the run and the item is redone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ljf-")), ck = join(dir, "ck"), out = join(dir, "p.jsonl");
  // call 2 errors: item 2 costs 2 calls; with cap 3, item 3's... cap hits after item 2's retry
  const b = new Recording((n) => (n === 2 ? new Error("socket hang up") : null));
  const r = await runFreeze({ items, inputsText: text, config: cfg, backend: b, checkpointDir: ck, outPath: out, maxCalls: 3 });
  assert.equal(r.callsThisRun, 3); assert.equal(r.doneTotal, 2); assert.equal(r.usage.errors, 1);
  // first attempt fails and the cap leaves no retry: not recorded
  const b2 = new Recording((n) => (n === 1 ? new Error("timeout-ish") : null));
  const r2 = await runFreeze({ items, inputsText: text, config: cfg, backend: b2, checkpointDir: ck, outPath: out, maxCalls: 1 });
  assert.equal(r2.callsThisRun, 1); assert.equal(r2.doneTotal, 2);
  const capErr = new WorkerHttpError(429, "role_cap_judge", "judge", null);
  const b3 = new Recording((n) => (n === 2 ? capErr : null));
  const r3 = await runFreeze({ items, inputsText: text, config: cfg, backend: b3, checkpointDir: ck, outPath: out, maxCalls: 50 });
  assert.equal(r3.stopped, "worker_cap"); assert.equal(r3.callsThisRun, 2); assert.equal(r3.doneTotal, 3); assert.ok(!existsSync(out));
  const r4 = await runFreeze({ items, inputsText: text, config: cfg, backend: new Recording(), checkpointDir: ck, outPath: out, maxCalls: 50 });
  assert.equal(r4.status, "complete"); assert.equal(r4.callsThisRun, 9);
  // both retries failing: the fail-safe reading (uncertain -> positive) is recorded, counted as uncertain
  const ck2 = join(dir, "ck2"), out2 = join(dir, "q.jsonl");
  const r5 = await runFreeze({ items: items.slice(0, 1), inputsText: text.split("\n")[0] + "\n", config: cfg, backend: new Recording(() => new Error("down")), checkpointDir: ck2, outPath: out2, maxCalls: 5 });
  assert.equal(r5.status, "complete"); assert.equal(r5.callsThisRun, 2); assert.equal(r5.uncertain!.answer_first, 1); assert.ok(r5.uncertain!.byCode.mind_reading >= 1);
  assert.deepEqual(JSON.parse(readFileSync(out2, "utf8")).answer_first, true, "positive policy: uncertain answer_first counts as a violation");
});

test("freeze CLI: refuses a wrong prompt id / same-family judge / unapproved live judge; never prints a token", () => {
  const root = join(import.meta.dirname, "../../..");
  const dir = mkdtempSync(join(tmpdir(), "ljf-")), inp = join(dir, "in.jsonl"), out = join(dir, "out.jsonl"), ck = join(dir, "ck");
  writeFileSync(inp, items.slice(0, 3).map((i) => JSON.stringify(i)).join("\n") + "\n");
  const secret = "bhd_SECRET_SHOULD_NOT_PRINT";
  const cli = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/ad-leak-freeze.ts"), ...a], { cwd: root, encoding: "utf8", env: { ...process.env, BH_JUDGE_TOKEN: secret, BH_WORKER_URL: "http://127.0.0.1:9" } });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const base = ["--in", inp, "--out", out, "--checkpoint", ck, "--commit", head];
  const runs = [
    [cli(...base, "--prompt-id", "lj1-11631f45", "--judge-model", "gemma4:cloud"), /prompt-id/],
    [cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID), /--judge-model required/],
    [cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID, "--judge-model", "gemma4:cloud", "--judge", "worker"), /approved-token-use|not clean/],
  ] as const;
  for (const [r, re] of runs) { assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, re); assert.ok(!(r.stdout + r.stderr).includes(secret)); }
  const ok = cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID, "--judge-model", "gemma4:cloud", "--max-calls", "2");
  assert.ok(!(ok.stdout + ok.stderr).includes(secret));
  if (ok.status === 3) {
    assert.match(ok.stdout, /2 requests \(cap 2/); assert.ok(!existsSync(out));
    const same = cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID, "--judge-model", "deepseek-v3.1:671b-cloud");
    assert.equal(same.status, 2); assert.match(same.stderr, /refusing to resume/);
    const fin = cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID, "--judge-model", "gemma4:cloud");
    assert.equal(fin.status, 0, fin.stderr); assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 3);
    const sm = cli(...base, "--prompt-id", LEAK_JUDGE_PROMPT_ID, "--judge-model", "gpt-oss:20b-cloud", "--checkpoint", join(dir, "ck3"));
    assert.equal(sm.status, 2); assert.match(sm.stderr, /different model family/);
  } else assert.match(ok.stderr, /not clean/, "only a dirty predictor tree may refuse: " + ok.stderr);
});
