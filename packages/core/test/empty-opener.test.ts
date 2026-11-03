// P0 Nov 3 2026 empty launch opener: the opener was [system prompt, system state note] with no user turn; Ollama Cloud
// answered a single done chunk (no prompt eval, no tokens) -> "" with finish_reason stop. Proposal (a): a fixed hidden
// user cue on the opener only, identical in every arm, not in the transcript, not a user_turn, flagged opener_cue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HarnessSession, MemoryHarnessStorage, MockBackend, OPENER_CUE, OPENER_CUE_ID, type LogEvent } from "../src/browser.ts";

type Msg = { role: string; content: string };
test("opener carries the fixed user cue in both arms; later turns and the transcript never do", async () => {
  const shapes: string[] = [];
  for (const adaptation of ["adaptive", "baseline"] as const) {
    const store = new MemoryHarnessStorage();
    const sent: Msg[][] = [];
    const be = { id: "spider-cloud:gpt-oss:20b-cloud", paid: true, generate: async (req: { messages: Msg[] }) => { sent.push(req.messages.map((m) => ({ ...m }))); return { text: "Hi! What have you been into lately?", finishReason: "stop" }; } };
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, adaptation, study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: 3 } });
    await s.start();
    await s.reply("I bake bread");
    await s.reply("sourdough mostly");
    assert.deepEqual(sent[0]!.map((m) => m.role), ["system", "system", "user"]);
    assert.deepEqual(sent[0]!.at(-1), { role: "user", content: OPENER_CUE });
    for (const m of sent.slice(1)) assert.ok(!m.some((x) => x.content === OPENER_CUE), "cue only on the opener");
    assert.deepEqual(sent[1]!.map((m) => m.role), ["system", "assistant", "user", "system"]);
    const log = store.readSession(s.id);
    const dts = log.filter((e) => e.type === "director_turn") as Extract<LogEvent, { type: "director_turn" }>[];
    assert.deepEqual(dts.map((d) => d.opener_cue), [true, false, false]);
    assert.deepEqual(dts.map((d) => d.opener_cue_id), [OPENER_CUE_ID, null, null]);
    assert.equal(log.filter((e) => e.type === "user_turn").length, 2, "the cue is not a user_turn");
    assert.ok(!JSON.stringify(log).includes(OPENER_CUE), "the cue text is never logged");
    shapes.push(sent[0]!.map((m) => m.role).join(","));
  }
  assert.equal(shapes[0], shapes[1]);
});

test("OPENER_CUE_ID pins the cue bytes: oc1- + first 8 hex of sha256", () => {
  assert.equal(OPENER_CUE, "(session start)");
  assert.equal(OPENER_CUE_ID, "oc1-" + createHash("sha256").update(OPENER_CUE, "utf8").digest("hex").slice(0, 8));
});

test("mock backend output is unchanged by the cue (sim/replays identical)", async () => {
  const run = async (strip: boolean) => {
    const be = new MockBackend(7, { tokenDelayMs: 0 });
    const orig = be.generate.bind(be);
    if (strip) be.generate = (req) => orig({ ...req, messages: req.messages.filter((m) => m.content !== OPENER_CUE) });
    const s = new HarnessSession({ userId: "u", backend: be, seed: 3, store: new MemoryHarnessStorage() });
    const out = [(await s.start()).text];
    out.push((await s.reply("I really like hiking in the mountains with friends")).director.text);
    return out;
  };
  assert.deepEqual(await run(false), await run(true));
});
