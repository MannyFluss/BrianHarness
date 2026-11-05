// E7: replay tool. off/shadow/on over the R2 synthetic files for all three layouts (iPhone, iPad, Mac); a logged
// session round-trips (shadow replay reproduces the source's Director inputs byte for byte); a candidate prompt id
// lands in session_start; pairwise sampling; zero network; every replayed line validates against bh-ad/1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AjvMod from "ajv";
import { candidateDirectorPrompt, loadO200k, replayLog, replayR2, REPLAY_MODES, MockPairwiseJudge, replyTurnOf, type ReplayRun } from "../src/actor-director/index.ts";
import { OPENER_CUE } from "../src/backends.ts";
import type { BhAdEvent } from "../src/ad-contracts/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";
import { guardNetwork, loadR2, R2_LAYOUTS } from "../../../scripts/ad-replay.ts";

const R2 = "/workspace/actor-director/research/R2";
const HAVE_R2 = existsSync(join(R2, "gaze-replays"));
const counter = loadO200k();
const DIR = join(import.meta.dirname, "..", "src", "ad-contracts", "schemas");
const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;
const ajv = new (Ajv as unknown as new (o: object) => { addSchema(s: object): void; getSchema(r: string): ((v: unknown) => boolean) & { errors?: unknown } | undefined })({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
for (const f of ["gaze-sample.schema.json", "gaze-plugin.schema.json", "note.schema.json", "bh-ad-events.schema.json", "worker.schema.json"]) ajv.addSchema(JSON.parse(readFileSync(join(DIR, f), "utf8")));
const ev = ajv.getSchema("https://brianharness.app/contracts/v1/bh-ad-events.schema.json")!;
const of = <T extends BhAdEvent["type"]>(lines: BhAdEvent[], t: T) => lines.filter((l) => l.type === t) as Array<Extract<BhAdEvent, { type: T }>>;
function assertValid(lines: BhAdEvent[]) { for (const l of lines) assert.ok(ev(l), `${l.type}: ${JSON.stringify(ev.errors)}`); }

test("replyTurnOf: opener cue is turn 0, else the user-message count", () => {
  const sys = { role: "system" as const, content: "s" };
  assert.equal(replyTurnOf({ messages: [sys, { role: "user", content: OPENER_CUE }] } as never), 0);
  assert.equal(replyTurnOf({ messages: [sys, { role: "assistant", content: "a0" }, { role: "user", content: "u0" }] } as never), 1);
});

for (const [layout, names] of Object.entries(R2_LAYOUTS)) {
  test(`R2 ${layout}: off / shadow / on, zero network`, { skip: !HAVE_R2 && "R2 replays not present" }, async () => {
    const net = guardNetwork();
    try {
      const reps = loadR2(R2, names);
      const runs: Record<string, ReplayRun> = {};
      for (const mode of REPLAY_MODES) runs[mode] = await replayR2(reps, { mode, counter, kv: new MemoryKV(), turns: 12, name: layout, networkCalls: net.calls });
      const { off, shadow, on } = runs as Record<"off" | "shadow" | "on", ReplayRun>;
      for (const r of [off, shadow, on]) { assertValid(r.lines); assert.equal(r.summary.network_calls, 0); assert.equal(r.summary.turns, 12); }
      // off: Director never called; the skip is logged with its root cause
      assert.equal(off.summary.director_calls, 0);
      assert.equal(of(off.lines, "director_call").length, 0);
      assert.ok(off.summary.health.includes("director.kill_switch"));
      assert.equal(off.summary.injected + off.summary.shadow, 0);
      // shadow: Director runs, nothing reaches the Actor
      assert.ok(shadow.summary.director_calls > 0 && shadow.summary.notes > 0);
      assert.equal(shadow.summary.injected, 0);
      assert.ok(shadow.summary.shadow > 0);
      assert.ok(of(shadow.lines, "injection").every((i) => i.decision === "shadow"));
      assert.equal(shadow.summary.session_share, 0);
      // on: rails-passed notes are injected
      assert.ok(on.summary.injected > 0);
      assert.equal(on.summary.injected, of(on.lines, "injection").filter((i) => i.decision === "inject").length);
      assert.ok(on.summary.rails_passed >= on.summary.injected);
      assert.ok((on.summary.session_share ?? 0) > 0);
      // the per-note Actor pair is recorded for every rails-passed note; mock pairwise judge is labelled as such
      assert.equal(on.summary.pairwise.sampled, on.summary.rails_passed);
      assert.equal(on.summary.pairwise.judge, new MockPairwiseJudge().id);
      assert.equal(on.summary.pairwise.injected + on.summary.pairwise.plain + on.summary.pairwise.tie, on.summary.pairwise.sampled);
      assert.equal(net.calls(), 0);
    } finally { net.restore(); }
  });
}

test("log replay round-trip: shadow reproduces every source Director input; off/on summarised; candidate prompt id", { skip: !HAVE_R2 && "R2 replays not present" }, async () => {
  const net = guardNetwork();
  try {
    const src = await replayR2(loadR2(R2, R2_LAYOUTS.mac!), { mode: "shadow", counter, kv: new MemoryKV(), turns: 10, name: "mac" });
    const json = src.lines.map((l) => JSON.parse(JSON.stringify(l)) as BhAdEvent); // as read back from a JSONL file
    const sh = await replayLog(json, { mode: "shadow", counter, kv: new MemoryKV() });
    assertValid(sh.lines);
    assert.equal(sh.summary.director_calls, src.summary.director_calls);
    assert.equal(sh.summary.director_inputs_matching_source, src.summary.director_calls, "every Director input byte-identical to the source");
    assert.deepEqual(of(sh.lines, "director_call").map((d) => d.input_sha256), of(src.lines, "director_call").map((d) => d.input_sha256));
    const on = await replayLog(json, { mode: "on", counter, kv: new MemoryKV() });
    assert.ok(on.summary.injected > 0);
    assert.ok((on.summary.director_inputs_matching_source ?? 0) < on.summary.director_calls, "injected replies change later inputs");
    const off = await replayLog(json, { mode: "off", counter, kv: new MemoryKV() });
    assert.equal(off.summary.director_calls, 0);
    // candidate Director prompt: id has the contract shape, lands in session_start, and changes the call's prompt sha
    const cand = candidateDirectorPrompt("You are a candidate Director. Reply with one JSON note.");
    assert.match(cand.id, /^dir0-[0-9a-f]{8}$/);
    const c = await replayLog(json, { mode: "shadow", counter, kv: new MemoryKV(), directorPrompt: cand });
    assertValid(c.lines);
    const st = of(c.lines, "session_start")[0]!;
    assert.equal(st.director_prompt_id, cand.id);
    assert.equal(c.summary.director_prompt_id, cand.id);
    assert.notEqual(st.director_assembled_sha8, of(sh.lines, "session_start")[0]!.director_assembled_sha8);
    assert.equal(net.calls(), 0);
  } finally { net.restore(); }
});

test("pairwise sampling: pairSample 0 samples none; a custom judge is used; any fetch is counted and fails the run", { skip: !HAVE_R2 && "R2 replays not present" }, async () => {
  const reps = loadR2(R2, R2_LAYOUTS.iphone!);
  const none = await replayR2(reps, { mode: "on", counter, kv: new MemoryKV(), turns: 8, pairSample: 0 });
  assert.equal(none.summary.pairwise.sampled, 0);
  const seen: string[] = [];
  const judge = { id: "test-judge", compare: (x: { hint: string; injected: string; plain: string }) => { seen.push(x.hint); assert.notEqual(x.injected, x.plain); return { winner: "injected" as const, why: "t" }; } };
  const r = await replayR2(reps, { mode: "on", counter, kv: new MemoryKV(), turns: 8, pairwise: judge });
  assert.equal(r.summary.pairwise.judge, "test-judge");
  assert.equal(r.summary.pairwise.injected, r.summary.pairwise.sampled);
  assert.ok(seen.length > 0 && seen.every((h) => h.length > 0));
  const net = guardNetwork();
  try {
    await assert.rejects(fetch("https://example.invalid/"), /not allowed in a replay/);
    assert.equal(net.calls(), 1);
  } finally { net.restore(); }
});
