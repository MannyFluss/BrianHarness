// Read-only past-session viewer (report d2bd6006 P4): sessionTranscript(id) returns only the visible user /
// Director turns, never writes, and is refused while a study session is in progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, OPENER_CUE, type ExportFile } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { transcriptAllowed, transcriptTurns } from "../src/transcript.ts";
import { sessionRowLabel } from "../src/components/Sidebar.tsx";

const LEAKY = /stateNote|"plan"|DIRECTOR STATE|sealed|rating|blindGuess|study|schedule|adaptive|baseline|"mode"|engagement|events|\(session start\)/i;

function app() {
  const downloads: ExportFile[][] = [];
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
    fetchImpl: (async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch, streaming: false, platform: "ios-tablet", uploadAutoSchedule: false,
    download: (files) => (downloads.push(files), true),
  });
  const logs = async () => { await t.exportLogs!(); return downloads.pop()!.filter((f) => f.name.endsWith(".jsonl")).map((f) => f.content).sort(); };
  return { t, logs };
}
const say = (t: ReturnType<typeof app>["t"], text: string) => t.reply({ text, events: [], sentAt: Date.now(), shownAt: Date.now() - 900 });

test("transcriptTurns keeps only user turns and visible Director replies", () => {
  const ev = [
    { type: "session_start", t: "2026-11-03T23:36:47.479Z", study: { index: 1, total: 10, scheduleHash: "h" }, adaptation: "adaptive" },
    { type: "director_turn", turn: 0, plan: { topic: "_open" }, stateNote: "[DIRECTOR STATE · turn 0]", text: "Hi! What's up?", opener_cue: true },
    { type: "user_turn", turn: 1, text: "I am in lecture", events: [{ t: 1, kind: "insert", len: 1 }], engagement: 0.4 },
    { type: "director_turn", turn: 1, sealed: "x", text: "Cool. What's next?", truncated: true },
    { type: "director_turn", turn: 2, text: "", error: "empty_completion" },
    { type: "rating", scope: "session", value: 4, blindGuess: "adaptive" },
    { type: "feedback_open", ts: 1 },
  ];
  assert.deepEqual(transcriptTurns(ev), [
    { role: "assistant", text: "Hi! What's up?" },
    { role: "user", text: "I am in lecture" },
    { role: "assistant", text: "Cool. What's next?", cutOff: true },
  ]);
});

test("transcriptAllowed: blocked in a study session, while busy, over a rating step or the Report sheet", () => {
  const ok = { canOpen: true, studyActive: false, busy: false, ratingCardOpen: false, turnProbeOpen: false, reportOpen: false };
  assert.equal(transcriptAllowed(ok), true);
  for (const k of ["studyActive", "busy", "ratingCardOpen", "turnProbeOpen", "reportOpen"] as const) assert.equal(transcriptAllowed({ ...ok, [k]: true }), false, k);
  assert.equal(transcriptAllowed({ ...ok, canOpen: false }), false);
});

test("row labels: date + turns only, never the title (user text)", () => {
  const s = { startedAt: "2026-11-03T23:36:47.479Z", turns: 4, active: false };
  assert.match(sessionRowLabel(s, false), /^Open past chat, .*4 turns$/);
  assert.match(sessionRowLabel({ ...s, active: true }, false), /^Current chat, /);
  assert.match(sessionRowLabel(s, true), /^Viewing past chat, /);
});

test("sessionTranscript: a past session's turns, read-only (every session log byte-identical), no hidden data", async () => {
  const { t, logs } = app();
  await t.providers.select("mock");
  const first = await t.newSession();
  await say(t, "I am in lecture learning about NLP");
  await say(t, "Repeat this phrase I am ai");
  await t.newSession();
  await say(t, "a second chat");
  const before = { logs: await logs(), sessions: await t.sessions(), hud: await t.hud() };
  const tr = await t.sessionTranscript!(first.sessionId);
  assert.ok(tr);
  assert.equal(tr.id, first.sessionId);
  assert.deepEqual(tr.turns.map((x) => x.role), ["assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(tr.turns[1]!.text, "I am in lecture learning about NLP");
  assert.equal(tr.turns[3]!.text, "Repeat this phrase I am ai");
  assert.ok(!tr.turns.some((x) => x.text === OPENER_CUE));
  assert.deepEqual(Object.keys(tr).sort(), ["id", "startedAt", "title", "turns"]);
  assert.doesNotMatch(JSON.stringify(tr), LEAKY);
  assert.equal(await t.sessionTranscript!("no-such-session"), null);
  assert.deepEqual({ logs: await logs(), sessions: await t.sessions(), hud: await t.hud() }, before, "nothing written, nothing started or ended");
});

test("sessionTranscript is refused while a study session is in progress; logs, study status and schedule unchanged", async () => {
  const { t, logs } = app();
  await t.providers.select("mock");
  const practice = await t.newSession();
  await say(t, "a practice chat about gardens");
  await t.providers.setApiKey("spider", "bhd_fake_past_session_token");
  await t.providers.select("mock");
  assert.deepEqual(await t.study!.enable(), { ok: true });
  await t.newSession();
  assert.ok((await t.hud())?.study, "study session running");
  await say(t, "study turn one");
  const before = { logs: await logs(), status: await t.study!.status(), hash: await t.study!.hash!(), sessions: await t.sessions() };
  assert.equal(await t.sessionTranscript!(practice.sessionId), null);
  assert.deepEqual({ logs: await logs(), status: await t.study!.status(), hash: await t.study!.hash!(), sessions: await t.sessions() }, before);
});
