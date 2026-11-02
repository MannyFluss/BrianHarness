// Keystroke audit (features, flags, down-weighting, privacy), absorption ratings (evaluation only),
// the no-adaptation baseline and the blinded Phase D study schedule, and the export zip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessHost, HarnessSession, InterestMap, MemoryKV, MemoryHarnessStorage, MockBackend, OPEN_TOPIC, StudyController, STUDY_PROTOCOL_VERSION, TOPICS, UNSEAL_PHRASE,
  estimateEngagement, generateSchedule, keyGaps, sanitizeTypingEvents, sha256HexSync, summarizeTyping, zipFiles, type TypingEvent,
} from "../src/index.js";

const typed = (from: number, n: number, step = 200, source?: TypingEvent["source"]): TypingEvent[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + (i + 1) * step, kind: "insert" as const, len: i + 1, ...(source ? { source } : {}) }));

test("audit: explicit reply latencies (completeAt -> first key, -> submit) and the inter-key gap summary", () => {
  const ev = [...typed(1000, 4, 250), { t: 4000, kind: "insert" as const, len: 5 }, { t: 4500, kind: "submit" as const, len: 5 }];
  const f = summarizeTyping(ev, { from: 1000, to: 4500 });
  assert.equal(f["typing.latencyToFirstKeyMs"], 250);
  assert.equal(f["typing.latencyToSubmitMs"], 3500);
  assert.equal(f["typing.replyLatencyMs"], 250, "legacy name kept (engagement input)");
  assert.equal(f["typing.gapCount"], 4);
  assert.equal(f["typing.gapMedianMs"], 250);
  assert.deepEqual(keyGaps(ev, { from: 1000, to: 4500 }), [250, 250, 250, 2000]);
  assert.equal(f["typing.timingReliability"], 1);
  assert.equal(f["typing.dictated"], 0);
  assert.equal(f["typing.pasted"], 0);
  assert.equal(f["typing.autocorrections"], 0);
});

test("audit: dictation / paste / autocorrect / predictive flags; IME composition deletes are not deletions", () => {
  const ev: TypingEvent[] = [
    ...typed(0, 10, 150, "soft-keyboard"),
    { t: 2000, kind: "insert", len: 16, source: "autocorrect", chars: 6 },
    { t: 2100, kind: "insert", len: 22, source: "predictive", chars: 6 },
    { t: 2500, kind: "insert", len: 52, source: "dictation", chars: 30 },
    { t: 3000, kind: "paste", len: 72, source: "paste", chars: 20 },
    { t: 3100, kind: "delete", len: 71, source: "composition" },
    { t: 3200, kind: "delete", len: 70, source: "soft-keyboard" },
  ];
  const f = summarizeTyping(ev, { from: 0, to: 4000 });
  assert.equal(f["typing.dictated"], 1);
  assert.equal(f["typing.pasted"], 1);
  assert.equal(f["typing.autocorrections"], 1);
  assert.equal(f["typing.predictive"], 1);
  assert.equal(f["typing.deletions"], 1, "composition rewrite is not a user deletion");
  assert.ok(Math.abs(f["typing.timingReliability"]! - 10 / 72) < 1e-9, String(f["typing.timingReliability"]));
});

test("down-weighting: r=1 (or absent: sim / old logs) is bit-identical; r=0 drops fluency + hesitation", () => {
  const base = { "text.words": 12, "text.topicHits": 1, "text.questions": 0, "typing.replyLatencyMs": 3000, "typing.pauses": 3, "typing.deletionRatio": 0.4 };
  const old = estimateEngagement(base).score;
  assert.equal(estimateEngagement({ ...base, "typing.timingReliability": 1 }).score, old);
  const dictated = estimateEngagement({ ...base, "typing.timingReliability": 0 });
  assert.notEqual(dictated.score, old);
  assert.equal(dictated.parts.timingReliability, 0);
  // pauses/deletions no longer move the score: changing them does nothing at r=0
  assert.equal(estimateEngagement({ ...base, "typing.pauses": 0, "typing.deletionRatio": 0, "typing.timingReliability": 0 }).score, dictated.score);
  const half = estimateEngagement({ ...base, "typing.timingReliability": 0.5 }).score;
  assert.ok((half - old) * (dictated.score - old) > 0 && Math.abs(half - old) < Math.abs(dictated.score - old), "monotone in r");
});

test("privacy: events are whitelisted to {t, kind, len, source, chars}; no text reaches the log", async () => {
  const leaky = [{ t: 1, kind: "insert", len: 1, data: "S", key: "S", text: "SECRETWORD" }, { t: 2, kind: "bogus", len: 2 }, { t: 3, kind: "insert", len: 2, source: "evil" }];
  assert.deepEqual(sanitizeTypingEvents(leaky), [{ t: 1, kind: "insert", len: 1 }, { t: 3, kind: "insert", len: 2 }]);
  const storage = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: storage, logRawEvents: true, clock: () => 10 });
  await s.start();
  s.markShown(0);
  await s.reply("hello there", leaky as unknown as TypingEvent[], 5);
  const log = JSON.stringify(storage.readSession(s.id).filter((e) => e.type === "user_turn"));
  assert.ok(!log.includes("SECRETWORD") && !log.includes('"data"') && !log.includes('"key"'), log);
  const ut = storage.readSession(s.id).find((e) => e.type === "user_turn");
  assert.ok(ut && ut.type === "user_turn" && Array.isArray(ut.keyGaps));
});

test("ratings are evaluation-only: one log line, nothing else changes; skipped prompts are logged", async () => {
  const storage = new MemoryHarnessStorage();
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: storage, seed: 3 });
  await s.start();
  await s.reply("I love restoring old watches and gears", typed(Date.now(), 5));
  const before = JSON.stringify({ map: s.map.toJSON(), frame: s.frame, ctx: s.engagementCtx, plans: s.plans, turn: s.turn, hud: s.hud() });
  s.logRating({ scope: "turn", turn: 1, value: 4, shownAt: 100, answeredAt: 900, dismissed: false });
  s.logRating({ scope: "turn", turn: 1, value: null, shownAt: 1000, answeredAt: null, dismissed: true, reason: "typed" });
  s.logRating({ scope: "session", turn: 1, value: 7 as never, shownAt: 2000, answeredAt: 2100, hooked: "  the gears  " });
  assert.equal(JSON.stringify({ map: s.map.toJSON(), frame: s.frame, ctx: s.engagementCtx, plans: s.plans, turn: s.turn, hud: s.hud() }), before);
  const r = storage.readSession(s.id).filter((e) => e.type === "rating");
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.type === "rating" && [x.scope, x.value, x.dismissed, x.answeredAt]), [["turn", 4, false, 900], ["turn", null, true, null], ["session", null, true, null]]);
  assert.equal(r[1]!.type === "rating" && r[1]!.reason, "typed");
  assert.equal(r[2]!.type === "rating" && r[2]!.hooked, "the gears");
  assert.equal(r[2]!.type === "rating" && "blindGuess" in r[2]!, false, "no blinding check outside study sessions");
  // the next turn is computed exactly as without ratings
  const twin = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: new MemoryHarnessStorage(), seed: 3 });
  await twin.start();
  const evs = typed(Date.now(), 5);
  await twin.reply("I love restoring old watches and gears", evs);
  assert.deepEqual(twin.map.toJSON().topics, s.map.toJSON().topics);
});

test("baseline (no-adaptation): fixed rotation, plan-only state note, ledger untouched; adaptive is the default", async () => {
  const map = InterestMap.fresh("u");
  for (let i = 0; i < 6; i++) map.observeTopic("cooking", 0.95, 1);
  const storage = new MemoryHarnessStorage();
  storage.saveMap(map);
  const savedBefore = JSON.stringify(storage.loadMap("u").toJSON());
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: storage, seed: 9, adaptation: "baseline" });
  await s.start();
  const topics: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await s.reply("cooking cooking I love cooking so much, recipes and kitchens", typed(Date.now(), 8));
    topics.push(r.director.plan.topic);
    assert.ok(!r.director.stateNote.includes("Interest map") && !r.director.stateNote.includes("engagement") && !r.director.stateNote.includes("Typing"), r.director.stateNote);
  }
  const probed = topics.filter((t) => t !== OPEN_TOPIC);
  assert.equal(new Set(probed).size, probed.length, `rotation never repeats early: ${probed}`);
  assert.ok(probed.every((t) => TOPICS.includes(t)));
  assert.ok(topics.includes(OPEN_TOPIC), "same periodic open question as adaptive");
  assert.equal(JSON.stringify(storage.loadMap("u").toJSON()), savedBefore, "ledger off: saved map untouched");
  assert.ok(storage.readSession(s.id).some((e) => e.type === "interest_update"), "shadow updates still logged");
  // default session: adaptive (exploits the strong topic)
  const a = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: new MemoryHarnessStorage(), map: InterestMap.fromJSON(map.toJSON()), seed: 9 });
  await a.start();
  const ar = await a.reply("cooking cooking I love cooking so much, recipes and kitchens", typed(Date.now(), 8));
  assert.ok(ar.director.stateNote.includes("Interest map"));
  const log = JSON.stringify(storage.readSession(s.id));
  assert.ok(!/"adaptation"|"mode":"(adaptive|baseline)"|:"(adaptive|baseline)"/.test(log), "the mode is never logged");
});

test("Phase D schedule: exactly 5/5, seeded; secure store only; sessions log index + hash, never the mode", async () => {
  for (const seed of [1, 2, 3, 77, 123456]) {
    const o = generateSchedule(seed);
    assert.equal(o.length, 10);
    assert.equal(o.filter((x) => x === "adaptive").length, 5);
    assert.deepEqual(generateSchedule(seed), o);
  }
  assert.notDeepEqual(generateSchedule(1), generateSchedule(2));
  for (const t of ["", "abc", "x".repeat(55), "y".repeat(64), "🎻".repeat(40)]) assert.equal(sha256HexSync(t), createHash("sha256").update(t).digest("hex"));

  const secret = new MemoryKV();
  const settings = new MemoryKV();
  const study = new StudyController(secret, settings, { randomSeed: () => 4242 });
  assert.equal((await study.status()).enabled, false);
  const { scheduleHash } = await study.enable();
  assert.equal(scheduleHash, await study.hash());
  assert.equal((await study.enable()).scheduleHash, scheduleHash, "never regenerated");
  assert.ok((await secret.get("study/phaseD/schedule"))!.includes("4242"));
  assert.ok(!JSON.stringify([...settings.data]).match(/adaptive|baseline|order/), "settings hold progress only");
  await assert.rejects(study.unseal("please"), /UNSEAL phaseD/);

  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const order = generateSchedule(4242);
  const r1 = await host.newSession(); // index 1, abandoned with 0 replies -> index reused
  const r1b = await host.newSession();
  for (let i = 0; i < 8; i++) await host.reply({ text: `hi I like chess ${i}`, events: typed(Date.now(), 4) });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2, blindGuess: "no-idea" }); // valid: >= 8 turns + rating
  const r2 = await host.newSession();
  const starts = [r1.sessionId, r1b.sessionId, r2.sessionId].map((id) => storage.readSession(id).find((e) => e.type === "session_start"));
  assert.deepEqual(starts.map((e) => e && e.type === "session_start" && e.study?.index), [1, 1, 2]);
  assert.ok(starts.every((e) => e && e.type === "session_start" && e.study?.scheduleHash === scheduleHash));
  const hud = host.hud()!;
  assert.deepEqual([hud.plan, hud.hypothesis, hud.topTopics, hud.study], [null, null, [], { index: 2, total: 10 }]);
  await host.reply({ text: "chess openings are great", events: typed(Date.now(), 4) });
  await host.rate({ scope: "session", value: 3, shownAt: 1, answeredAt: 2, blindGuess: "no-idea", hooked: "x" });
  const files = host.exportFiles();
  const all = files.map((f) => f.content).join("\n");
  assert.ok(!/"adaptation"|:"(adaptive|baseline)"|"order"|"seed"/.test(all), "exports never contain the mode or the schedule");
  assert.ok(all.includes('"sealed":true') && !all.includes('"stateNote"'), "plans / state notes sealed in study logs");
  assert.ok(all.includes('"blindGuess":"no-idea"'));
  const un = await study.unseal(UNSEAL_PHRASE);
  assert.deepEqual(un.order, order);
  assert.equal(un.scheduleHash, scheduleHash);
  // the Director actually ran each session's mode (index 2 = order[1])
  const dts = storage.readSession(r2.sessionId);
  assert.ok(dts.length > 0);
});

test("study: secure store failure -> session runs (adaptive, no study fields)", async () => {
  const broken = { get: async () => { throw Object.assign(new Error("Keychain"), { code: "-34018" }); }, set: async () => { throw new Error("no"); } };
  const st = new StudyController(broken, new MemoryKV());
  assert.match((await st.status()).error ?? "", /Keychain/);
  await assert.rejects(st.enable());
  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study: st });
  const r = await host.newSession();
  assert.ok(!storage.readSession(r.sessionId).some((e) => e.type === "session_start" && e.study));
});

test("export zip: valid archive (python zipfile), UTF-8 names and content round-trip", () => {
  const files = [{ name: "sessions/a.jsonl", content: '{"type":"x","t":"🎻"}\n' }, { name: "saves/u.json", content: "{}\n" }];
  const z = zipFiles(files);
  const dir = mkdtempSync(join(tmpdir(), "bhzip-"));
  writeFileSync(join(dir, "x.zip"), z);
  const out = execFileSync("python3", ["-c", "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))", join(dir, "x.zip")]).toString();
  assert.deepEqual(JSON.parse(out), { "sessions/a.jsonl": files[0]!.content, "saves/u.json": "{}\n" });
});

test("study reissue: < 8 user turns or no answered session rating -> same index (same mode), reissueOf logged; protocol in session_start + final; plan never logged", async () => {
  const secret = new MemoryKV();
  const study = new StudyController(secret, new MemoryKV(), { randomSeed: () => 99 });
  const { scheduleHash } = await study.enable();
  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const reply = async (n: number) => { for (let i = 0; i < n; i++) await host.reply({ text: `tell you about my garden plot ${i}`, events: typed(Date.now(), 3) }); };
  const ids: string[] = [];
  ids.push((await host.newSession()).sessionId); await reply(7); await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2 }); // 7 turns: invalid
  ids.push((await host.newSession()).sessionId); await reply(8); await host.rate({ scope: "session", value: null, shownAt: 1, dismissed: true }); // dismissed rating: invalid
  ids.push((await host.newSession()).sessionId); await reply(8); // no rating at all: invalid
  ids.push((await host.newSession()).sessionId); await reply(8); await host.rate({ scope: "session", value: 2, shownAt: 1, answeredAt: 2 }); // valid
  ids.push((await host.newSession()).sessionId); // index 2
  await host.newSession(); // ends the last one
  const starts = ids.map((id) => storage.readSession(id).find((e) => e.type === "session_start") as unknown as { study: { index: number; protocol: number; scheduleHash: string }; reissueOf?: string });
  assert.deepEqual(starts.map((s) => s.study.index), [1, 1, 1, 1, 2]);
  assert.deepEqual(starts.map((s) => s.reissueOf ?? null), [null, ids[0], ids[1], ids[2], null]);
  assert.ok(starts.every((s) => s.study.protocol === STUDY_PROTOCOL_VERSION && s.study.scheduleHash === scheduleHash));
  const finals = ids.slice(0, 4).map((id) => storage.readSession(id).find((e) => e.type === "final") as unknown as { protocol?: number });
  assert.ok(finals.every((f) => f.protocol === STUDY_PROTOCOL_VERSION));
  const all = ids.map((id) => storage.readSession(id).map((e) => JSON.stringify(e)).join("\n")).join("\n");
  // director_turn.plan.mode (explore/exploit/relax pacing, NOT the study arm) is omitted with the whole plan in study sessions
  assert.ok(!/"plan"|"mode"|"stateNote"|"adaptation"|"order"|"seed"/.test(all), "no plan / mode / schedule in study logs");
  assert.ok(storage.readSession(ids[0]!).filter((e) => e.type === "director_turn").every((e) => (e as { sealed?: boolean }).sealed === true));
  // non-study sessions still log plan.mode (pacing) for sidecar/1 and replays
  const plain = new MemoryHarnessStorage();
  const h2 = new HarnessHost({ userId: "u", storage: plain, backend: async () => new MockBackend(1), seed: () => 5 });
  const p = await h2.newSession();
  const dt = plain.readSession(p.sessionId).find((e) => e.type === "director_turn") as unknown as { plan: { mode: string } };
  assert.ok(["explore", "exploit", "relax"].includes(dt.plan.mode));
});

test("study protocol: a missing / older protocol discards the schedule + progress (fresh hash on Start study); the current one is kept; unseal returns raw", async () => {
  const secret = new MemoryKV(), settings = new MemoryKV();
  let seed = 1;
  const study = new StudyController(secret, settings, { randomSeed: () => seed++ });
  // a practice schedule from build 1438 (no protocol), mid-study
  const practice = JSON.stringify({ study: "phaseD", version: 1, seed: 7, order: generateSchedule(7), createdAt: "2026-11-02T21:00:00.000Z" });
  await secret.set("study/phaseD/schedule", practice);
  await settings.set("study/phaseD/progress", JSON.stringify({ enabled: true, next: 4, last: { sessionId: "s3", index: 3 } }));
  const oldHash = sha256HexSync(practice);
  assert.deepEqual(await study.ensureProtocol(), { reset: true, from: null });
  assert.equal(await study.hash(), null);
  assert.deepEqual(await study.status(), { enabled: false, next: 1, total: 10, scheduled: false });
  const a = await study.enable();
  assert.notEqual(a.scheduleHash, oldHash);
  assert.equal(a.protocol, STUDY_PROTOCOL_VERSION);
  // current protocol: kept across launches
  assert.deepEqual(await study.ensureProtocol(), { reset: false });
  assert.equal((await study.enable()).scheduleHash, a.scheduleHash);
  // an older numbered protocol is discarded too
  const older = JSON.stringify({ study: "phaseD", version: 1, seed: 8, order: generateSchedule(8), createdAt: "2026-11-02T21:00:00.000Z", protocol: 1 });
  await secret.set("study/phaseD/schedule", older);
  assert.deepEqual(await study.ensureProtocol(), { reset: true, from: 1 });
  const b = await study.enable();
  assert.notEqual(b.scheduleHash, a.scheduleHash);
  // unseal: raw is the exact stored string; hash = sha256 hex of it; key order study,version,seed,order,createdAt,protocol
  const un = await study.unseal(UNSEAL_PHRASE);
  assert.equal(un.raw, await secret.get("study/phaseD/schedule"));
  assert.equal(sha256HexSync(un.raw), un.scheduleHash);
  assert.equal(un.raw, JSON.stringify({ study: un.study, version: un.version, seed: un.seed, order: un.order, createdAt: un.createdAt, protocol: un.protocol }));
  assert.equal(new Date(un.createdAt).toISOString(), un.createdAt);
});
