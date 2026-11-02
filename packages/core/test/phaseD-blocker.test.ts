// Researcher blocker (Nov 2): extractor enthusiasm logging features, session file names, plan.mode in study logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessHost, HarnessSession, LlmInterestExtractor, MemoryHarnessStorage, MemoryKV, MockBackend, StudyController, sessionExportName } from "../src/index.js";

const answers = [
  { interests: [{ label: "sourdough baking", confidence: 0.82, turns: [1, 2, 3] }, { label: "rye flour", confidence: 0.4, turns: [3] }] },
  null, // 2nd call fails (HTTP 500 x3) -> carried forward
  { interests: [{ label: "bread scoring", confidence: 0.66, turns: [8, 9] }] },
];
function fake() {
  let i = 0;
  return (async () => {
    const a = answers[Math.min(i, answers.length - 1)];
    if (a === null) { i += 1 / 3; return new Response("boom", { status: 500 }); } // 3 attempts per logical call
    i = Math.round(i) + 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(a) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
}
const TEXTS = ["my starter bubbled over", "the crumb is open", "i fed it rye", "work was ok", "oven spring", "hydration 80",
  "anyway", "i scored a wheat stalk", "the ear was huge", "lunch"];

async function run(adaptation: "adaptive" | "baseline") {
  const storage = new MemoryHarnessStorage();
  const tagger = new LlmInterestExtractor({ api: "openai", baseUrl: "http://w", apiKey: "k", everyN: 3, fetchImpl: fake(), retryDelayMs: 1 });
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: storage, seed: 3, tagger, adaptation });
  await s.start();
  const frames: Array<Record<string, number>> = [];
  for (const t of TEXTS) frames.push({ ...(await s.reply(t, [], 1000)).user.frame.features });
  await s.end();
  const turns = storage.readSession(s.id).filter((e) => e.type === "user_turn") as unknown as Array<{ features: Record<string, number>; engagement: number }>;
  return { turns, frames };
}

test("user_turn.features extractor.enthusiasm / top1_turns / n_labels: absent before the first answer, carried forward, logging only, same in baseline + adaptive", async () => {
  const a = await run("adaptive"), b = await run("baseline");
  const pick = (f: Record<string, number>) => [f["extractor.enthusiasm"], f["extractor.top1_turns"], f["extractor.n_labels"]];
  const want = [
    ...Array(2).fill([undefined, undefined, undefined]),
    ...Array(6).fill([0.82, 3, 2]), // turn 3 answer; turn 6 call failed -> carried forward
    ...Array(2).fill([0.66, 2, 1]), // turn 9 answer
  ];
  assert.deepEqual(a.turns.map((t) => pick(t.features)), want);
  assert.deepEqual(b.turns.map((t) => pick(t.features)), want, "identical in baseline");
  for (const f of [...a.frames, ...b.frames]) assert.ok(!Object.keys(f).some((k) => k.startsWith("extractor.")), "never in frame.features (engagement / Director inputs)");
  // engagement never sees them (and the tagger runs identically in both arms)
  assert.deepEqual(a.turns.map((t) => t.engagement), b.turns.map((t) => t.engagement));
});

test("study session files are bh-session-<idx>-<startISO>-<tag>.jsonl (index only); non-study bh-session-<startISO>-<tag>.jsonl", async () => {
  const sid = "2026-11-02T22-37-24-806Z-q7xw";
  assert.equal(sessionExportName({ t: "2026-11-02T22:37:24.806Z", study: { index: 3 } }, sid), "bh-session-03-20261102T223724Z-6Zq7xw.jsonl");
  assert.equal(sessionExportName({ t: "2026-11-02T22:37:24.806Z" }, sid), "bh-session-20261102T223724Z-6Zq7xw.jsonl");
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 5 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const r = await host.newSession();
  const f = host.sessionFile(r.sessionId)!;
  assert.match(f.name, /^sessions\/bh-session-01-\d{8}T\d{6}Z-[A-Za-z0-9]{6}\.jsonl$/);
  assert.ok(!/adaptive|baseline/.test(f.name));
});

test("tools/phaseD/check_blinding.mjs: a study export passes (plan omitted, blindGuess allowed); a plan in a study session fails", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const storage = new MemoryHarnessStorage();
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 5 });
  await study.enable();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  const r = await host.newSession();
  for (let i = 0; i < 3; i++) await host.reply({ text: `my garden ${i}` });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2, blindGuess: "baseline" });
  await host.end();
  const dir = mkdtempSync(join(tmpdir(), "bh-blind-"));
  const content = host.sessionFile(r.sessionId)!.content;
  writeFileSync(join(dir, "s.jsonl"), content);
  const tool = join(import.meta.dirname, "../../../tools/phaseD/check_blinding.mjs");
  const ok = spawnSync(process.execPath, [tool, dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /1 study \(0 practice.*1 blindGuess.*0 leaks/);
  writeFileSync(join(dir, "s.jsonl"), content.replace('"sealed":true', '"plan":{"mode":"explore"}'));
  const bad = spawnSync(process.execPath, [tool, dir], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.match(bad.stdout, /LEAK/);
});

test("schedule export file = exact Keychain string, no trailing newline; sha256(file bytes) === scheduleHash; export-ratings accepts it", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { scheduleExportFile, UNSEAL_PHRASE } = await import("../src/index.js");
  const { readScheduleFile } = await import("../../sim/src/export-ratings.ts");
  const secret = new MemoryKV();
  const study = new StudyController(secret, new MemoryKV(), { randomSeed: () => 31337 });
  const { scheduleHash } = await study.enable();
  const un = await study.unseal(UNSEAL_PHRASE);
  assert.equal(un.raw, await secret.get("study/phaseD/schedule"));
  assert.ok(!un.raw.endsWith("\n"));
  const f = scheduleExportFile(un);
  assert.equal(f.content, un.raw);
  const dir = mkdtempSync(join(tmpdir(), "bh-sched-"));
  const p = join(dir, f.name);
  writeFileSync(p, f.content);
  assert.equal(createHash("sha256").update(readFileSync(p)).digest("hex"), scheduleHash, "sha256 of the exported file = scheduleHash");
  const rs = readScheduleFile(p);
  assert.equal(rs.scheduleHash, scheduleHash); assert.deepEqual(rs.order, un.order);
  writeFileSync(join(dir, "u.json"), JSON.stringify({ ...un, scheduleHash: "0".repeat(64) }));
  assert.throws(() => readScheduleFile(join(dir, "u.json")), /does not match/);
});

test("study index never passes 10: reissue reuses the index, and after 10 valid sessions assign() returns null", async () => {
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 12 });
  await study.enable();
  const valid = { userTurns: 8, sessionRated: true }, invalid = { userTurns: 12, sessionRated: false };
  const info = new Map<string, { userTurns: number; sessionRated: boolean }>();
  const seen: Array<[number, string | null]> = [];
  let n = 0;
  for (;;) {
    const id = `s${++n}`;
    const a = await study.assign(id, (prev) => info.get(prev)!);
    if (!a) break;
    assert.ok(a.index >= 1 && a.index <= 10);
    seen.push([a.index, a.reissueOf ?? null]);
    info.set(id, n % 3 === 0 ? invalid : valid); // every 3rd session invalid -> reissued
    assert.ok(n < 40, "terminates");
  }
  assert.deepEqual([...new Set(seen.map(([i]) => i))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(seen.some(([, r]) => r), "reissues happened");
  for (let k = 1; k < seen.length; k++) if (seen[k]![1]) assert.equal(seen[k]![0], seen[k - 1]![0], "reissue = same index");
  assert.equal(await study.assign("again", () => valid), null, "finished: null");
  assert.equal((await study.status()).next, 11);
  // the last session (index 10) invalid -> index 10 is reissued, never 11
  const s2 = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 13 });
  await s2.enable();
  for (let i = 1; i <= 10; i++) await s2.assign(`t${i}`, () => valid);
  const r = await s2.assign("t11", (prev) => (prev === "t10" ? invalid : valid));
  assert.deepEqual([r?.index, r?.reissueOf], [10, "t10"]);
  assert.equal(await s2.assign("t12", () => valid), null);
});

test("upload bodies: exactly the Worker f71cc53 allowlist; jsonl byte-identical; committed sample agrees", async () => {
  const { readFileSync } = await import("node:fs");
  const { sessionUploadBody, studyStartUploadBody, SESSION_UPLOAD_KEYS, STUDY_START_UPLOAD_KEYS, findUploadSecret } = await import("../src/index.js");
  const jsonl = readFileSync(new URL("../../../docs/samples/phaseD_sample_export.jsonl", import.meta.url), "utf8");
  const sample = JSON.parse(readFileSync(new URL("../../../docs/samples/phaseD_sample_upload.json", import.meta.url), "utf8"));
  const b = sessionUploadBody(jsonl, { appVersion: "0.1.0", platform: "ios", build: 1439 });
  assert.deepEqual(b, sample);
  assert.equal(b.jsonl, jsonl);
  for (const k of Object.keys(b)) assert.ok((SESSION_UPLOAD_KEYS as readonly string[]).includes(k), k);
  assert.equal(findUploadSecret(JSON.stringify(b)), null);
  const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.filter((e) => e.type === "user_turn").length >= 8);
  assert.ok(lines.some((e) => e.type === "rating" && e.scope === "session" && e.value != null));
  assert.equal(lines[0].study.protocol, 2);
  assert.ok(lines.some((e) => e.type === "user_turn" && typeof e.features["extractor.enthusiasm"] === "number"));
  const fin = lines.find((e) => e.type === "final");
  for (const k of ["protocol", "extractorCalls", "effectiveTagger", "fallback"]) assert.ok(k in fin, k);
  const bare = sessionUploadBody([JSON.stringify({ ...lines[0], study: undefined }), ...jsonl.split("\n").slice(1)].join("\n"), { appVersion: "0.1.0", platform: "desktop" });
  assert.ok(!("studyIndex" in bare) && !("scheduleHash" in bare) && !("build" in bare));
  const s = studyStartUploadBody({ scheduleHash: "a".repeat(64), nSessions: 10, createdAt: "2026-11-02T00:00:00.000Z" }, { appVersion: "0.1.0", platform: "ios", build: 1439 });
  assert.deepEqual(Object.keys(s).sort(), [...STUDY_START_UPLOAD_KEYS].sort());
  assert.ok(!("protocol" in s));
  assert.equal(findUploadSecret('{"apiKey":"sk-proj-abcdefghijklmnop1234"}') !== null, true);
});
