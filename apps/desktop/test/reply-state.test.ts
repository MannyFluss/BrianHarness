// P0 Nov 2 2026: a turn that fails mid-stream must never leave a frozen (still "streaming") bubble, and a reply cut
// off by max_tokens (finish_reason "length") is flagged so Message renders "Reply cut off".
import { test } from "node:test";
import assert from "node:assert/strict";
import { completeReply, failStreaming } from "../src/reply-state.ts";
import type { ChatMsg } from "../src/components/Message.tsx";

test("completeReply: caret off; cutOff only when truncated", () => {
  const m: ChatMsg[] = [{ id: "u", role: "user", text: "hi" }, { id: "r", role: "assistant", text: "Hel", streaming: true }];
  const done = completeReply(m, "r", "Hello?");
  assert.deepEqual(done[1], { id: "r", role: "assistant", text: "Hello?", streaming: false });
  const cut = completeReply(m, "r", "Hello th", true);
  assert.equal(cut[1]!.cutOff, true); assert.equal(cut[1]!.streaming, false);
  assert.deepEqual(completeReply([], "r", "x", true), [{ id: "r", role: "assistant", text: "x", cutOff: true }]);
});

test("failStreaming: every streaming bubble stops and is marked failed, plus a visible error message", () => {
  const m: ChatMsg[] = [{ id: "a", role: "assistant", text: "Earlier." }, { id: "r", role: "assistant", text: "Half a", streaming: true }];
  const out = failStreaming(m, "the reply stream ended before it finished (connection dropped)", "e1");
  assert.ok(out.every((x) => !x.streaming), "no frozen caret");
  assert.equal(out[1]!.failed, true); assert.equal(out[1]!.text, "Half a");
  assert.equal(out[0]!.failed, undefined);
  assert.deepEqual(out[2], { id: "e1", role: "assistant", text: "⚠ the reply stream ended before it finished (connection dropped)" });
});
