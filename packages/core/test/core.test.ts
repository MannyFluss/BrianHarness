import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeEegSource, HarnessSession, InterestMap, MockBackend, OPEN_TOPIC, SessionStore,
  buildStateNote, createBackendFromEnv, detectTopics, estimateEngagement, makeRng, planTurn,
  summarizeTyping, textFeatures, type TypingEvent,
} from "../src/index.js";

test("summarizeTyping computes latency, deletions, edits, pauses", () => {
  const ev: TypingEvent[] = [
    { t: 1000, kind: "insert", len: 1 },
    { t: 1100, kind: "insert", len: 2 },
    { t: 1200, kind: "delete", len: 1 },
    { t: 1300, kind: "insert", len: 2 },
    { t: 4000, kind: "insert", len: 3 }, // 2.7s pause
    { t: 4100, kind: "submit", len: 3 },
  ];
  const f = summarizeTyping(ev, { from: 0, to: 4100 });
  assert.equal(f["typing.replyLatencyMs"], 1000);
  assert.equal(f["typing.deletions"], 1);
  assert.equal(f["typing.edits"], 1);
  assert.equal(f["typing.pauses"], 1);
  assert.equal(f["typing.longestPauseMs"], 2700);
  assert.equal(f["typing.finalLength"], 3);
});

test("engagement: long, fast, on-topic beats short, slow, hesitant", () => {
  const hot = estimateEngagement({ ...textFeatures("I love telescopes and planets, last night I saw Mars and three stars in orbit near the galaxy edge, wild?"), "typing.replyLatencyMs": 800, "typing.pauses": 0, "typing.deletionRatio": 0.05 });
  const cold = estimateEngagement({ ...textFeatures("idk"), "typing.replyLatencyMs": 14000, "typing.pauses": 3, "typing.deletionRatio": 0.5 });
  assert.ok(hot.score > 0.6, `hot ${hot.score}`);
  assert.ok(cold.score < 0.25, `cold ${cold.score}`);
});

test("detectTopics finds lexicon topics", () => {
  assert.deepEqual(detectTopics("I bake bread and play guitar").sort(), ["cooking", "music"]);
});

test("interest map: updates, hypothesis needs evidence, save file round-trips", () => {
  const m = InterestMap.fresh("u1");
  m.observeTopic("space", 0.9);
  assert.equal(m.hypothesis(), null, "one observation is not enough");
  m.observeTopic("space", 0.85);
  m.observeTopic("sports", 0.2);
  assert.equal(m.hypothesis(), "space");
  const dir = mkdtempSync(join(tmpdir(), "eeg-"));
  const store = new SessionStore(dir);
  store.saveMap(m);
  const back = store.loadMap("u1");
  assert.deepEqual(back.toJSON(), m.toJSON());
  assert.throws(() => InterestMap.fromJSON({ nope: 1 }));
});

test("director: opener is open; strong hypothesis gets exploited", () => {
  const m = InterestMap.fresh("u");
  const rng = makeRng(1);
  const p0 = planTurn(0, m, null, [], rng);
  assert.equal(p0.topic, OPEN_TOPIC);
  assert.equal(p0.style, "open");
  m.observeTopic("music", 0.9); m.observeTopic("music", 0.9); m.observeTopic("art", 0.2);
  const frame = { turn: 1, engagement: 0.8, baseline: 0.6, lift: 0.2, features: {}, mentionedTopics: [] };
  const p = planTurn(3, m, frame, [p0], rng);
  assert.equal(p.mode, "exploit");
  assert.equal(p.topic, "music");
  const note = buildStateNote(frame, m, p);
  assert.match(note, /DIRECTOR STATE/);
  assert.match(note, /EXPLOIT music/);
});

test("backend selection never goes paid by accident", () => {
  assert.equal(createBackendFromEnv({}).id, "mock");
  assert.equal(createBackendFromEnv({ OPENAI_API_KEY: "sk-x" }).id, "mock", "key alone must not enable paid calls");
  assert.equal(createBackendFromEnv({ EEG_BACKEND: "openai" }).id, "mock", "no key -> mock");
  const b = createBackendFromEnv({ EEG_BACKEND: "openai", EEG_API_KEY: "sk-x", EEG_MODEL: "m1" });
  assert.equal(b.id, "openai-compatible:m1");
  assert.equal(b.paid, true);
});

test("session writes JSONL log and autosaves the interest map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eeg-"));
  const store = new SessionStore(dir);
  let now = 10_000;
  const s = new HarnessSession({ userId: "manny", backend: new MockBackend(1), store, clock: () => now });
  const d0 = await s.start();
  assert.ok(d0.text.length > 0);
  now += 3000;
  const ev: TypingEvent[] = [{ t: 11_000, kind: "insert", len: 1 }, { t: 12_000, kind: "insert", len: 20 }];
  const { user, director } = await s.reply("I make indie games and write shaders in my engine", ev, now);
  assert.ok(user.frame.mentionedTopics.includes("games"));
  assert.equal(user.frame.features["typing.replyLatencyMs"], 1000);
  assert.ok(director.stateNote.includes("User brought up"));
  await s.end();
  const events = store.readSession(s.id).map((e) => e.type);
  assert.deepEqual(events, ["session_start", "director_turn", "user_turn", "interest_update", "director_turn", "final", "session_end"]);
  assert.ok(existsSync(store.savePath("manny")));
  const save = JSON.parse(readFileSync(store.savePath("manny"), "utf8"));
  assert.ok(save.topics.games.mean > 0);
});

test("fake EEG source produces an engagement index that tracks hidden truth", () => {
  let truth = 0.1;
  const eeg = new FakeEegSource(() => truth, { seed: 3, noise: 0.05 });
  eeg.generate({ from: 0, to: 5000 });
  const low = eeg.summarize({ from: 0, to: 5000 })["eeg.engagementIndex"]!;
  truth = 0.9;
  eeg.generate({ from: 6000, to: 11000 });
  const high = eeg.summarize({ from: 6000, to: 11000 })["eeg.engagementIndex"]!;
  assert.ok(high > low + 0.3, `${low} -> ${high}`);
});
