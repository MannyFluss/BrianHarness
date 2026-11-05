/** Leak-judge commit set: the frozen predictor's batch path and CLI (scripts/ad-leak-predict.ts). Mock judge only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAK_JUDGE_PROMPT_ID, LeakGate, MockJudgeBackend, predictAll, checkLeaksSync } from "../src/actor-director/index.ts";

test("frozen predictor: predictAll (mock judge path) == the E2 checks on the R4 dev fixture; CLI refuses a wrong commit / unapproved live judge", async () => {
  const items = readFileSync(join(import.meta.dirname, "fixtures/r4-dev.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const preds = await predictAll(items, new LeakGate({ backend: new MockJudgeBackend(), actorModel: "gpt-oss:20b-cloud", deadlineMs: 60_000 }));
  assert.equal(preds.length, items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i], p = preds[i]!, e = checkLeaksSync({ text: it.text, context: it.context, note: it.note, fragment: it.unit !== "reply" });
    assert.deepEqual(p.codes, e.codes, it.id);
    assert.equal(p.answer_first, it.unit === "reply" && !!it.context && e.answeredFirst === false, it.id);
    assert.equal(p.answer_first_violation, p.answer_first);
    assert.deepEqual(Object.keys(p).slice(0, 3), ["id", "codes", "answer_first"]);
  }
  const root = join(import.meta.dirname, "../../..");
  const dir = mkdtempSync(join(tmpdir(), "ljp-")), inp = join(dir, "in.jsonl"), out = join(dir, "out.jsonl");
  writeFileSync(inp, items.slice(0, 5).map((it) => JSON.stringify({ id: it.id, unit: it.unit, context: it.context, note: it.note || null, text: it.text })).join("\n") + "\n");
  const cli = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/ad-leak-predict.ts"), ...a], { cwd: root, encoding: "utf8", env: { ...process.env, BH_JUDGE_TOKEN: "" } });
  const wrong = cli("--in", inp, "--out", out, "--commit", "0000000");
  assert.equal(wrong.status, 2); assert.match(wrong.stderr, /HEAD .* != --commit/);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const live = cli("--in", inp, "--out", out, "--commit", head, "--judge", "worker");
  assert.equal(live.status, 2); assert.ok(!existsSync(out));
  const ok = cli("--in", inp, "--out", out, "--commit", head);
  if (ok.status === 0) {
    const meta = JSON.parse(readFileSync(out.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    assert.equal(meta.commit, head); assert.equal(meta.leak_judge_prompt_id, LEAK_JUDGE_PROMPT_ID); assert.equal(meta.judge, "mock");
    assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 5);
  } else assert.match(ok.stderr, /not clean|!= --commit/, "only a dirty predictor tree may refuse: " + ok.stderr);
});
