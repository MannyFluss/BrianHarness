// Phase D exporter: per-turn typing features x ratings CSV; no mode column unless an unsealed
// schedule (with a matching hash) is passed explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessHost, MemoryHarnessStorage, MemoryKV, MockBackend, StudyController, UNSEAL_PHRASE, type TypingEvent } from "@brianharness/core";
import { ratingsCsv, readSessionLogs } from "../src/export-ratings.ts";

const typed = (t0: number, n: number): TypingEvent[] => [...Array.from({ length: n }, (_, i) => ({ t: t0 + 800 + i * 180, kind: "insert" as const, len: i + 1, source: "hardware-key" as const })), { t: t0 + 800 + n * 180, kind: "submit" as const, len: n }];
const parseCsv = (csv: string) => {
  const [head, ...lines] = csv.trim().split("\n");
  const cols = head!.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v]))) as Array<Record<string, string>>;
};

test("export-ratings: one row per user turn, ratings joined, no mode column; --schedule joins by index", async () => {
  const study = new StudyController(new MemoryKV(), new MemoryKV(), { randomSeed: () => 77 });
  const { scheduleHash } = await study.enable();
  const storage = new MemoryHarnessStorage();
  const host = new HarnessHost({ userId: "u", storage, backend: async () => new MockBackend(1), study, seed: () => 5 });
  await host.newSession();
  for (let i = 0; i < 3; i++) await host.reply({ text: "I really like birdwatching, herons", events: typed(Date.now() - 4000, 6), shownAt: Date.now() - 4000 });
  await host.rate({ scope: "turn", turn: 2, value: 4, shownAt: 10, answeredAt: 12 });
  await host.rate({ scope: "turn", turn: 3, value: null, shownAt: 20, answeredAt: null, dismissed: true, reason: "typed" });
  await host.rate({ scope: "session", turn: 3, value: 5, shownAt: 30, answeredAt: 31, hooked: 'the herons, "really"', blindGuess: "no-idea" });
  await host.newSession();
  await host.reply({ text: "chess now", events: typed(Date.now() - 3000, 4), shownAt: Date.now() - 3000 });
  await host.end();

  const dir = mkdtempSync(join(tmpdir(), "bh-export-"));
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "saves"));
  for (const f of host.exportFiles()) writeFileSync(join(dir, f.name), f.content);
  const csv = ratingsCsv(readSessionLogs([dir]));
  const head = csv.split("\n")[0]!;
  assert.ok(!/\bmode\b|adaptation|adaptive|baseline,|\btext\b,/.test(head.replace(",baseline,", ",")), "no mode / text columns");
  assert.doesNotMatch(csv, /adaptive|"baseline"|birdwatching/, "no mode, no message text");
  for (const c of ["typing.latencyToFirstKeyMs", "typing.latencyToSubmitMs", "typing.gapMedianMs", "typing.timingReliability", "turn_rating", "session_rating", "session_blindGuess"]) assert.ok(head.split(",").includes(c), c);
  const rows = parseCsv(csv.replace(/"[^"]*(""[^"]*)*"/g, "Q")); // quoted cells -> placeholder for the naive split
  assert.equal(rows.length, 4);
  const s1 = rows.filter((r) => r.studyIndex === "1");
  assert.deepEqual(s1.map((r) => r.turn_rating), ["", "4", ""]);
  assert.equal(s1[2]!.turn_rating_dismissed, "true");
  assert.ok(s1.every((r) => r.session_rating === "5" && r.scheduleHash === scheduleHash));
  assert.ok(csv.includes('"the herons, ""really"""'), "CSV-quoted free text");
  assert.ok(!ratingsCsv(readSessionLogs([dir]), { hooked: false }).includes("herons"));

  // unsealed join (explicit, hash-checked)
  const un = await study.unseal(UNSEAL_PHRASE);
  const sched = join(dir, "unsealed.json");
  writeFileSync(sched, JSON.stringify(un));
  const out = join(dir, "r.csv");
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../src/export-ratings.ts"), dir, "--schedule", sched, "-o", out]);
  const joined = parseCsv(ratingsCsv(readSessionLogs([dir]), { schedule: un, hooked: false }));
  assert.deepEqual([...new Set(joined.map((r) => `${r.studyIndex}:${r.mode}`))], [`1:${un.order[0]}`, `2:${un.order[1]}`]);
  assert.throws(() => ratingsCsv(readSessionLogs([dir]), { schedule: { ...un, scheduleHash: "0".repeat(64) } }), /does not match/);
});
