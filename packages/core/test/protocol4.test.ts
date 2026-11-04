// Protocol 4 (report d2bd6006 fix): one shared answer-first prompt, note in the leading system message, and a
// session_start.study block that names the prompt (note excluded) and the placement, identical in both arms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CHAT_SYSTEM_PROMPT, DIRECTOR_PROMPT_ID, HarnessSession, MemoryHarnessStorage, NOTE_PLACEMENT, PLAIN_SYSTEM_PROMPT, STUDY_PROTOCOL_VERSION, leadingSystemMessage, type LogEvent } from "../src/browser.ts";

type Msg = { role: string; content: string };
test("DIRECTOR_PROMPT_ID pins the shared prompt bytes (note excluded): dp4- + first 8 hex of sha256", () => {
  assert.equal(DIRECTOR_PROMPT_ID, "dp4-" + createHash("sha256").update(CHAT_SYSTEM_PROMPT, "utf8").digest("hex").slice(0, 8));
  assert.equal(PLAIN_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT);
  assert.equal(leadingSystemMessage(""), CHAT_SYSTEM_PROMPT);
  assert.equal(leadingSystemMessage("[DIRECTOR STATE · turn 1]\nPlan: x"), CHAT_SYSTEM_PROMPT + "\n\n[DIRECTOR STATE · turn 1]\nPlan: x");
});

test("protocol-4 study session_start: protocol 4, the same director_prompt_id and note_placement in both arms; nothing arm-dependent", async () => {
  const starts: Record<string, Record<string, unknown>> = {};
  const lastMsgs: Record<string, Msg[]> = {};
  for (const adaptation of ["adaptive", "baseline"] as const) {
    const store = new MemoryHarnessStorage();
    const be = { id: "spider-cloud:gpt-oss:20b-cloud", paid: true, generate: async (req: { messages: Msg[] }) => { lastMsgs[adaptation] = req.messages; return { text: "Sure. What else?", finishReason: "stop" }; } };
    const s = new HarnessSession({ userId: "u", backend: be, seed: 1, store, adaptation, study: { id: "phaseD", index: 1, total: 10, scheduleHash: "a".repeat(64), protocol: STUDY_PROTOCOL_VERSION } });
    await s.start();
    await s.reply("Repeat this phrase I am ai");
    const log = store.readSession(s.id);
    const st = log.find((e) => e.type === "session_start") as Extract<LogEvent, { type: "session_start" }>;
    starts[adaptation] = st.study as unknown as Record<string, unknown>;
    assert.equal((st as Record<string, unknown>).profile, undefined, "study sessions carry no profile");
    assert.ok(!/note_?(len|length|hash|chars)/i.test(JSON.stringify(st)), "no note length / hash");
    // the note is inside the leading system message and the user message is last
    const m = lastMsgs[adaptation]!;
    assert.equal(m.filter((x) => x.role === "system").length, 1);
    assert.ok(m[0]!.content.startsWith(CHAT_SYSTEM_PROMPT + "\n\n[DIRECTOR STATE"));
    assert.deepEqual(m.at(-1), { role: "user", content: "Repeat this phrase I am ai" });
  }
  for (const k of ["adaptive", "baseline"]) {
    assert.equal(starts[k]!.protocol, 4);
    assert.equal(starts[k]!.director_prompt_id, DIRECTOR_PROMPT_ID);
    assert.equal(starts[k]!.note_placement, NOTE_PLACEMENT);
    assert.equal(NOTE_PLACEMENT, "leading");
  }
  const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
  assert.deepEqual(keys(starts.adaptive!), keys(starts.baseline!));
  assert.equal(starts.adaptive!.director_prompt_id, starts.baseline!.director_prompt_id, "identical across arms");
});
