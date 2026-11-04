// Plain-chat profile (report d2bd6006, Nov 3 2026). A session with no study assignment is plain chat: the request is
// ONE leading system message (the plain prompt), the transcript, and on turn 0 the opener cue, so the latest user
// message is always last and nothing trails it. No tagger / extractor call, no interest-map write, profile:"plain" on
// session_start only. Replays Manny's d2bd6006 turns through the real in-process transport with a fake Worker fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, OPENER_CUE, PLAIN_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, DIRECTOR_SYSTEM_PROMPT, StudyController, STUDY_PROGRESS_KEY } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";

const TOKEN = "bhd_fake_plain"; // fake literal
const USER = ["I am in lecture learning about NLP", "Test", "Repeat this phrase I am ai", "Test", "what should I focus on?", "explain how a sourdough starter works"];
type Msg = { role: string; content: string };

function setup(secret = new MemoryKV()) {
  const reqs: Array<{ model: string; messages: Msg[] }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/models") return json({ data: [{ id: "gpt-oss:20b-cloud" }, { id: "gpt-oss:120b-cloud" }] });
    if (u.pathname === "/v1/chat/completions") {
      const b = JSON.parse(String(init?.body));
      reqs.push({ model: b.model, messages: b.messages });
      return json({ choices: [{ message: { content: `reply ${reqs.length}` }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const kv = { settings: new MemoryKV(), cred: new MemoryKV(), secret, upload: new MemoryKV(), storage: new MemoryKV() };
  let exported: Array<{ name: string; content: string }> = [];
  const t = createInProcessTransport({ storageKV: kv.storage, settingsKV: kv.settings, secretKV: kv.secret, uploadKV: kv.upload, credentials: new KVCredentialStore(kv.cred), fetchImpl: f, nativeFetch: true, streaming: false, platform: "test", uploadAutoSchedule: false, download: (files) => ((exported = files as typeof exported), true) });
  return { t, reqs, kv, exported: () => exported };
}
const logs = (files: Array<{ name: string; content: string }>) => files.filter((x) => x.name.endsWith(".jsonl")).map((x) => x.content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));

test("plain chat replay (d2bd6006 turns): plain prompt, no trailing note, latest user message last, no extractor", async () => {
  const { t, reqs, exported } = setup();
  await t.providers.setApiKey("spider", TOKEN);
  await t.newSession();
  let now = Date.now();
  for (const [i, text] of USER.entries()) {
    if (i === 2) await t.providers.select("spider-cloud", "gpt-oss:120b-cloud"); // Manny switched before "Repeat this phrase"
    now += 8000;
    await t.reply({ text, events: [], sentAt: now, shownAt: now - 6000 });
  }
  assert.equal(reqs.length, 1 + USER.length, "one request per turn: no extractor / tagger calls");
  for (const [n, r] of reqs.entries()) {
    const m = r.messages;
    assert.equal(m[0]!.role, "system"); assert.equal(m[0]!.content, PLAIN_SYSTEM_PROMPT);
    assert.equal(m.filter((x) => x.role === "system").length, 1, `request ${n}: exactly one (leading) system message`);
    assert.ok(!m.some((x) => x.content.includes("[DIRECTOR STATE ·") || x.content === DIRECTOR_SYSTEM_PROMPT), "no state note, no Director prompt");
    assert.equal(m.at(-1)!.role, "user");
    assert.equal(m.at(-1)!.content, n === 0 ? OPENER_CUE : USER[n - 1], `request ${n}: the latest user message is last`);
    if (n > 0) assert.ok(!m.some((x) => x.content === OPENER_CUE), "cue on the opener only");
  }
  assert.equal(reqs[3]!.model, "gpt-oss:120b-cloud");
  await t.newSession();
  await t.exportLogs();
  const first = logs(exported()).find((ls) => ls.some((l) => l.type === "final"))!;
  const start = first.find((l) => l.type === "session_start")!;
  assert.equal(start.profile, "plain");
  assert.ok(!("study" in start));
  assert.ok(first.filter((l) => l.type !== "session_start").every((l) => !("profile" in l)), "profile on session_start only");
  assert.ok(first.filter((l) => l.type === "director_turn").every((l) => !("plan" in l) && !("stateNote" in l)));
  assert.ok(first.filter((l) => l.type === "user_turn").every((l) => Array.isArray(l.mentionedTopics) && (l.mentionedTopics as unknown[]).length === 0), "no topics: command words never become topics");
  assert.ok(!first.some((l) => l.type === "interest_update"), "nothing learned in plain chat");
  assert.ok(!JSON.stringify(first).includes(TOKEN));
  // the saved interest map is untouched by plain chat
  assert.ok(!exported().some((x) => x.name.startsWith("saves/") && /kp:|"test"/i.test(x.content) && /turns": [1-9]/.test(x.content)));
});

test("plain profile is chosen once from the study controller: off / finished -> plain; error / lost / study session -> never plain", async () => {
  // study off (never started): plain
  { const { t, reqs } = setup(); await t.providers.setApiKey("spider", TOKEN); await t.newSession(); assert.equal(reqs[0]!.messages[0]!.content, PLAIN_SYSTEM_PROMPT); }
  // secure store error: Director profile, never plain
  {
    const broken = { get: async () => { throw new Error("keychain"); }, set: async () => { throw new Error("keychain"); }, remove: async () => {}, keys: async () => [] };
    const { t, reqs } = setup(broken as unknown as MemoryKV); await t.providers.setApiKey("spider", TOKEN); await t.newSession();
    // protocol 4: the same prompt with the state note appended inside the leading system message
    assert.ok(reqs[0]!.messages[0]!.content.startsWith(CHAT_SYSTEM_PROMPT + "\n\n[DIRECTOR STATE"));
  }
  // study on -> a study session: Director prompt + note, never plain
  {
    const secret = new MemoryKV();
    await new StudyController(secret, new MemoryKV(), { randomSeed: () => 5 }).enable();
    const { t, reqs } = setup(secret); await t.providers.setApiKey("spider", TOKEN); const s = await t.newSession();
    assert.ok((s.hud as { study?: unknown }).study);
    assert.notEqual(reqs[0]!.messages[0]!.content, PLAIN_SYSTEM_PROMPT);
  }
  // lost progress (schedule without progress, nothing to recover): never plain
  {
    const secret = new MemoryKV();
    await new StudyController(secret, new MemoryKV(), { randomSeed: () => 5 }).enable();
    await secret.set(STUDY_PROGRESS_KEY, "");
    const { t, reqs } = setup(secret); await t.providers.setApiKey("spider", TOKEN); await t.newSession();
    assert.notEqual(reqs[0]!.messages[0]!.content, PLAIN_SYSTEM_PROMPT);
  }
});

test("StudyController.noStudyReason: off, finished, lost, error, and null after an assignment", async () => {
  const last = () => ({ userTurns: 8, sessionRated: true });
  const off = new StudyController(new MemoryKV(), new MemoryKV());
  assert.equal(await off.assign("a", last), null); assert.equal(off.noStudyReason(), "off");
  const secret = new MemoryKV();
  const on = new StudyController(secret, new MemoryKV(), { randomSeed: () => 5 });
  await on.enable();
  assert.ok(await on.assign("b", last)); assert.equal(on.noStudyReason(), null);
  await secret.set(STUDY_PROGRESS_KEY, JSON.stringify({ enabled: true, next: 11 }));
  assert.equal(await on.assign("c", last), null); assert.equal(on.noStudyReason(), "finished");
  const broken = { get: async () => { throw new Error("keychain"); }, set: async () => { throw new Error("keychain"); }, remove: async () => {}, keys: async () => [] };
  const err = new StudyController(broken as unknown as MemoryKV, new MemoryKV());
  assert.equal(await err.assign("d", last), null); assert.equal(err.noStudyReason(), "error");
  const s2 = new MemoryKV();
  await new StudyController(s2, new MemoryKV(), { randomSeed: () => 5 }).enable();
  await s2.set(STUDY_PROGRESS_KEY, "");
  const lost = new StudyController(s2, new MemoryKV());
  assert.equal(await lost.assign("e", last), null); assert.equal(lost.noStudyReason(), "lost");
});

test("plain prompt names the opener cue verbatim", () => {
  assert.ok(PLAIN_SYSTEM_PROMPT.includes(`"${OPENER_CUE}"`));
  assert.equal(PLAIN_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, "protocol 4: plain = the shared prompt with no note");
  assert.notEqual(CHAT_SYSTEM_PROMPT, DIRECTOR_SYSTEM_PROMPT);
});
