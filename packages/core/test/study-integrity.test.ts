// Study integrity (freeze, after E): progress in the secure store next to the schedule (read-back), migration from
// the settings KV, recovery after a storage eviction (never reuse a valid index), "progress lost" block + setNext,
// Keychain-fail path unchanged. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HarnessHost, MemoryHarnessStorage, MemoryKV, MockBackend, StudyController, UploadQueue, recoverNextIndex, setNextPhrase,
  STUDY_PROGRESS_KEY, STUDY_PROGRESS_LOST_NOTE, STUDY_PROTOCOL_VERSION, STUDY_SCHEDULE_KEY, type StudySessionRecord, type TypingEvent,
} from "../src/index.js";

const typed = (from: number, n: number, step = 200): TypingEvent[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + (i + 1) * step, kind: "insert" as const, len: i + 1 }));
const meta = { appVersion: "0.0.0-test", platform: "test" };
const queue = (kv: MemoryKV) => new UploadQueue(kv, { meta, autoSchedule: false, target: async () => null });

async function runSession(host: HarnessHost, turns: number, rated: boolean) {
  const { sessionId } = await host.newSession();
  for (let i = 0; i < turns; i++) await host.reply({ text: `tell you about my garden plot ${i}`, events: typed(Date.now(), 3) });
  if (rated) await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2 });
  return sessionId;
}
const starts = (storage: MemoryHarnessStorage) =>
  [...storage.listSessions()].reverse().map((id) => storage.readSession(id).find((e) => e.type === "session_start") as unknown as Record<string, unknown> & { study?: { index: number } });

test("progress lives in the secure store (read-back), not in the settings KV", async () => {
  const secret = new MemoryKV(), settings = new MemoryKV();
  const study = new StudyController(secret, settings, { randomSeed: () => 3 });
  await study.enable();
  await study.assign("s1", () => ({ userTurns: 8, sessionRated: true }));
  assert.equal(await settings.get(STUDY_PROGRESS_KEY), null);
  const p = JSON.parse((await secret.get(STUDY_PROGRESS_KEY))!);
  assert.deepEqual(p, { enabled: true, next: 2, last: { sessionId: "s1", index: 1 } });
  assert.ok(!/adaptive|baseline|adaptation|order|seed/.test(await secret.get(STUDY_PROGRESS_KEY) ?? ""), "progress never carries the mode");
  // a secure store that does not keep the value -> fails loudly (no silent restart later)
  const lossy = { get: async (k: string) => (k === STUDY_PROGRESS_KEY ? null : secret.get(k)), set: async () => {} };
  await assert.rejects(new StudyController(lossy, new MemoryKV()).enable(), /read-back/);
});

test("migration: old settings-KV progress is copied into the secure store and the old copy removed", async () => {
  const secret = new MemoryKV(), settings = new MemoryKV();
  const old = new StudyController(secret, new MemoryKV(), { randomSeed: () => 4 });
  const { scheduleHash } = await old.enable();
  for (let i = 1; i <= 3; i++) await old.assign(`s${i}`, () => ({ userTurns: 8, sessionRated: true }));
  // simulate the E build layout: progress in settings, nothing in the secure store
  const legacy = { enabled: true, next: 4, last: { sessionId: "s3", index: 3 }, manualReissue: 2, manualReissueReason: "wifi" };
  await settings.set(STUDY_PROGRESS_KEY, JSON.stringify(legacy));
  await secret.remove(STUDY_PROGRESS_KEY);
  const study = new StudyController(secret, settings, { recover: async () => { throw new Error("recovery must not run when a legacy copy exists"); } });
  const st = await study.status();
  assert.equal(st.next, 4); assert.equal(st.enabled, true); assert.equal(st.pendingReissue, 2); assert.equal(st.progressRecovered, undefined);
  assert.deepEqual(JSON.parse((await secret.get(STUDY_PROGRESS_KEY))!), legacy);
  assert.equal(await settings.get(STUDY_PROGRESS_KEY), null, "old copy removed");
  const a = await study.assign("s4", () => ({ userTurns: 8, sessionRated: true }));
  assert.equal(a!.index, 2); assert.equal(a!.reissueReason, "wifi"); assert.equal(a!.progressRecovered, undefined);
  assert.equal(a!.scheduleHash, scheduleHash);
  // web build: secret store and settings are the same KV -> the read hits the secure key, nothing is removed
  const same = new MemoryKV();
  const w = new StudyController(same, same, { randomSeed: () => 4 });
  await w.enable();
  assert.equal((await w.status()).enabled, true);
});

test("eviction: progress + local logs wiped, schedule kept -> rebuilt from the durable upload ledger; progressRecovered logged; no valid index reused", async () => {
  const secret = new MemoryKV(), ledgerKV = new MemoryKV(); // Keychain + Documents/pending-uploads survive
  const q = queue(ledgerKV);
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(secret, new MemoryKV(), { randomSeed: () => 11 });
  const { scheduleHash } = await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const ids = [await runSession(host, 8, true), await runSession(host, 8, true), await runSession(host, 8, true), await runSession(host, 7, true)]; // 1,2,3 valid; 4 invalid
  await host.newSession(); // ends #4; this one gets index 4 again (reissue), stays empty
  for (const id of ids) await q.enqueueSession(host.sessionFile(id)!);
  const recs = await q.studyRecords();
  assert.deepEqual(recs.map((r) => [r.index, r.valid]), [[1, true], [2, true], [3, true], [4, false]]);
  assert.ok(recs.every((r) => r.scheduleHash === scheduleHash));
  assert.ok(!/adaptive|baseline|adaptation/.test(await ledgerKV.get("uploads/index") ?? ""), "ledger never carries the mode");

  // eviction: IndexedDB/localStorage gone (progress + session logs); Keychain schedule + Documents ledger kept
  await secret.remove(STUDY_PROGRESS_KEY);
  const storage2 = new MemoryHarnessStorage();
  let host2!: HarnessHost;
  const study2 = new StudyController(secret, new MemoryKV(), { recover: async () => [...host2.studyRecords(), ...(await q.studyRecords())] });
  host2 = new HarnessHost({ userId: "u", storage: storage2, backend: async () => new MockBackend(1), study: study2, seed: () => 5 });
  const st = await study2.status();
  assert.equal(st.next, 4, "index 4 was invalid -> owed again"); assert.equal(st.progressRecovered, true); assert.equal(st.progressLost, undefined);
  await runSession(host2, 8, true);
  await runSession(host2, 8, true);
  await host2.newSession();
  const s2 = starts(storage2).sort((x, y) => x.study!.index - y.study!.index); // same-ms sessions: order by index
  assert.deepEqual(s2.map((s) => s.study?.index), [4, 5, 6]);
  assert.equal(s2[0]!.progressRecovered, true, "first session after recovery logs progressRecovered");
  assert.equal(s2[1]!.progressRecovered, undefined, "only once");
  const line = JSON.stringify(s2[0]);
  assert.ok(!/adaptive|baseline|adaptation/.test(line), "no mode in session_start");
  assert.equal((await study2.hash()), scheduleHash, "schedule untouched");
});

test("eviction on desktop-like storage: local logs survive -> rebuilt from them (highest index invalid -> same index)", async () => {
  const secret = new MemoryKV();
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(secret, new MemoryKV(), { randomSeed: () => 12 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  await runSession(host, 8, true); await runSession(host, 3, false); await runSession(host, 8, true); // 1 valid, 2 invalid, 2 again valid
  await host.newSession(); // index 3, empty (open)
  await secret.remove(STUDY_PROGRESS_KEY);
  let host2!: HarnessHost;
  const study2 = new StudyController(secret, new MemoryKV(), { recover: async () => host2.studyRecords() });
  host2 = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study: study2, seed: () => 5 });
  // highest index found = 3 (the open empty session: invalid) -> 3 again; 1 and 2 are valid and never reused
  const a = await study2.assign("x", () => ({ userTurns: 0, sessionRated: false }));
  assert.equal(a!.index, 3); assert.equal(a!.progressRecovered, true);
});

test("recoverNextIndex never hands out a valid index (exhaustive over small histories)", () => {
  const H = "h";
  for (let mask = 0; mask < 1 << 6; mask++) {
    // a sequential history 1..k with reissues: each index appears 1-2 times; validity from the mask bits
    const recs: StudySessionRecord[] = [];
    let idx = 1, bit = 0;
    while (bit < 6 && idx <= 10) { const valid = !!(mask & (1 << bit++)); recs.push({ index: idx, scheduleHash: H, valid }); if (valid) idx++; }
    const next = recoverNextIndex([...recs, { index: 9, scheduleHash: "other", valid: true }], H)!;
    const validIdx = new Set(recs.filter((r) => r.valid).map((r) => r.index));
    assert.ok(!validIdx.has(next), `mask ${mask}: next ${next} is a valid index`);
    assert.ok([...validIdx].every((v) => v < next), `mask ${mask}: no gap backwards`);
  }
  assert.equal(recoverNextIndex([{ index: 10, scheduleHash: H, valid: true }], H), 11, "finished");
  assert.equal(recoverNextIndex([{ index: 3, scheduleHash: "other", valid: true }], H), null, "other schedule ignored");
});

test("progress lost (schedule kept, nothing to rebuild from): blocking notice, no study sessions until setNext", async () => {
  const secret = new MemoryKV();
  const s0 = new StudyController(secret, new MemoryKV(), { randomSeed: () => 13 });
  const { scheduleHash } = await s0.enable();
  await s0.assign("s1", () => ({ userTurns: 8, sessionRated: true }));
  await secret.remove(STUDY_PROGRESS_KEY);
  const study = new StudyController(secret, new MemoryKV(), { recover: async () => [] });
  const st = await study.status();
  assert.equal(st.progressLost, true); assert.equal(st.error, STUDY_PROGRESS_LOST_NOTE); assert.equal(st.enabled, false); assert.equal(st.scheduled, true);
  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  await host.newSession();
  assert.ok(!starts(storage)[0]!.study, "no study session while lost (never restarts at 1)");
  await assert.rejects(study.enable(), /progress lost/);
  await study.disable();
  assert.equal((await study.status()).progressLost, true, "still blocked after a relaunch-style status");
  assert.equal((await study.requestReissue(1, "REISSUE 1")).ok, false);
  assert.equal((await study.setNext(2, "SET NEXT 3")).ok, false);
  assert.equal((await study.setNext(11, setNextPhrase(11))).ok, false);
  assert.deepEqual(await study.setNext(2, setNextPhrase(2)), { ok: true, index: 2 });
  const st2 = await study.status();
  assert.equal(st2.progressLost, undefined); assert.equal(st2.enabled, true); assert.equal(st2.next, 2);
  await host.newSession();
  const all = starts(storage);
  assert.equal(all.length, 2); assert.equal(all.filter((x) => x.study).length, 1);
  const s = all.find((x) => x.study)!;
  assert.equal(s.study!.index, 2); assert.equal(s.progressRecovered, true);
  assert.equal(await study.hash(), scheduleHash);
  // a recovery source that throws counts as "nothing found" (still blocked, never index 1)
  await secret.remove(STUDY_PROGRESS_KEY);
  const broken = new StudyController(secret, new MemoryKV(), { recover: async () => { throw new Error("disk"); } });
  assert.equal(await broken.assign("z", () => 0), null);
  assert.equal((await broken.status()).progressLost, true);
});

test("no schedule + no progress = fresh install: Start study at 1 (not 'lost'); outdated-protocol reset clears the legacy copy too", async () => {
  const secret = new MemoryKV(), settings = new MemoryKV();
  const study = new StudyController(secret, settings, { randomSeed: () => 1, recover: async () => { throw new Error("not needed"); } });
  const st = await study.status();
  assert.equal(st.progressLost, undefined); assert.equal(st.next, 1); assert.equal(st.scheduled, false);
  assert.equal((await study.enable()).protocol, STUDY_PROTOCOL_VERSION);
  assert.equal((await study.assign("a", () => 0))!.index, 1);
  // practice-build schedule (no protocol) + legacy progress -> both discarded
  const s2 = new MemoryKV(), set2 = new MemoryKV();
  await s2.set(STUDY_SCHEDULE_KEY, JSON.stringify({ study: "phaseD", version: 1, seed: 1, order: Array(10).fill("x"), createdAt: "2026-01-01T00:00:00Z" }));
  await set2.set(STUDY_PROGRESS_KEY, JSON.stringify({ enabled: true, next: 6 }));
  const c = new StudyController(s2, set2);
  assert.deepEqual(await c.ensureProtocol(), { reset: true, from: null });
  assert.equal(await set2.get(STUDY_PROGRESS_KEY), null);
  const cs = await c.status();
  assert.equal(cs.next, 1); assert.equal(cs.enabled, false); assert.equal(cs.progressLost, undefined);
});

test("Keychain fail path unchanged: status error, enable rejects, sessions run without study fields, legacy copy untouched", async () => {
  const broken = { get: async () => { throw Object.assign(new Error("Keychain"), { code: "-34018" }); }, set: async () => { throw new Error("no"); } };
  const settings = new MemoryKV();
  await settings.set(STUDY_PROGRESS_KEY, JSON.stringify({ enabled: true, next: 3 }));
  const st = new StudyController(broken, settings, { recover: async () => { throw new Error("must not recover"); } });
  const s = await st.status();
  assert.match(s.error ?? "", /Keychain/); assert.equal(s.scheduled, false); assert.equal(s.progressLost, undefined);
  await assert.rejects(st.enable());
  assert.equal(await st.assign("x", () => 0), null);
  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study: st });
  await host.newSession();
  assert.ok(!starts(storage)[0]!.study);
  assert.equal(await settings.get(STUDY_PROGRESS_KEY), JSON.stringify({ enabled: true, next: 3 }), "not migrated into a failing store, not removed");
});

test("protocol 2 -> 3 (P0 cut-off fix): a sealed v2 study at index 3 restarts cleanly at 1 with a new hash; no lost/recovered", async () => {
  assert.equal(STUDY_PROTOCOL_VERSION, 3);
  const v2raw = JSON.stringify({ study: "phaseD", version: 1, seed: 7, order: [...Array(5).fill("adaptive"), ...Array(5).fill("baseline")], createdAt: "2026-11-02T20:00:00.000Z", protocol: 2 });
  const { sha256HexSync } = await import("../src/study.js");
  const v2hash = sha256HexSync(v2raw);
  const v2records: StudySessionRecord[] = [1, 2].map((index) => ({ sessionId: `v2-${index}`, index, scheduleHash: v2hash, valid: true }));
  for (const progress of [JSON.stringify({ enabled: true, next: 3 }), null]) { // progress present, and evicted (would trigger recovery)
    const secret = new MemoryKV(), settings = new MemoryKV();
    await secret.set(STUDY_SCHEDULE_KEY, v2raw);
    if (progress) await secret.set(STUDY_PROGRESS_KEY, progress);
    let recoverCalls = 0;
    const study = new StudyController(secret, settings, { randomSeed: () => 3, recover: async () => { recoverCalls++; return v2records; } });
    const st = await study.status();
    assert.equal(st.progressLost, undefined); assert.equal(st.progressRecovered, undefined); assert.equal(st.error, undefined);
    assert.equal(st.enabled, false); assert.equal(st.next, 1); assert.equal(st.scheduled, false);
    assert.equal(recoverCalls, 0, "protocol-2 progress is never resurrected");
    const en = await study.enable();
    assert.equal(en.protocol, 3); assert.notEqual(en.scheduleHash, v2hash);
    const a = await study.assign("new-1", () => 0);
    assert.equal(a!.index, 1); assert.equal(a!.protocol, 3); assert.equal(a!.scheduleHash, en.scheduleHash);
    assert.equal(recoverCalls, 0);
  }
});
