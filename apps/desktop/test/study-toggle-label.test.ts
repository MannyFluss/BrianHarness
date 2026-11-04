// Settings study button: while the open chat is practice / plain it names the NEXT study session; once a study
// session is open it names that session. Never the arm. Driven through the real transport (context() + status()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV } from "@brianharness/core/browser";
import { studyToggleLabel } from "../src/components/StudyData.tsx";
import { createInProcessTransport } from "../src/transport/in-process.ts";

test("studyToggleLabel: next slot while practice / plain is open, the session's index while a study session is open", () => {
  const st = { enabled: true, next: 1, total: 10 };
  assert.equal(studyToggleLabel(st, { inStudy: false, index: null }, false), "Study on · next: session 1/10 · stop");
  assert.equal(studyToggleLabel(st, null, false), "Study on · next: session 1/10 · stop", "unknown open chat: never claims a study session");
  assert.equal(studyToggleLabel({ ...st, next: 2 }, { inStudy: true, index: 1 }, false), "Study 1/10 · stop");
  assert.equal(studyToggleLabel({ ...st, next: 4 }, { inStudy: false, index: null }, false), "Study on · next: session 4/10 · stop");
  assert.equal(studyToggleLabel({ enabled: false, next: 1, total: 10 }, null, false), "Start study");
  assert.equal(studyToggleLabel({ enabled: false, next: 1, total: 10 }, null, true), "Tap again to start the 10-session study");
  assert.equal(studyToggleLabel({ enabled: false, next: 11, total: 10 }, null, false), "Study complete");
  for (const l of [studyToggleLabel(st, { inStudy: true, index: 3 }, false), studyToggleLabel(st, null, false)]) assert.doesNotMatch(l, /adaptive|baseline|arm|condition/i);
});

test("transport: plain chat open -> 'Study on · next: session 1/10'; study session 1 open -> 'Study 1/10'", async () => {
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/models") return json({ data: [{ id: "gpt-oss:20b-cloud" }] });
    if (u.pathname === "/v1/chat/completions") return json({ choices: [{ message: { content: "Hi! What's up?" }, finish_reason: "stop" }] });
    return json({}, 404);
  }) as typeof fetch;
  const kv = () => new MemoryKV();
  const t = createInProcessTransport({ storageKV: kv(), settingsKV: kv(), secretKV: kv(), uploadKV: kv(), credentials: new KVCredentialStore(kv()), fetchImpl: f, nativeFetch: true, streaming: false, platform: "test", uploadAutoSchedule: false, download: () => true });
  await t.providers.setApiKey("spider", "bhd_fake_label"); // fake literal
  await t.newSession(); // plain chat (study off)
  assert.deepEqual(await t.study!.enable(), { ok: true });
  const label = async () => studyToggleLabel(await t.study!.status(), (await t.feedback!.context()).study, false);
  assert.equal(await label(), "Study on · next: session 1/10 · stop", "plain chat still open");
  await t.newSession(); // study session 1
  assert.equal(await label(), "Study 1/10 · stop");
});
