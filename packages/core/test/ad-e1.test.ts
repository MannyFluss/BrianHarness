// E1 (Actor/Director): mode storage, bh-ad/1 logger + blinded redaction, the client-side blinded guard (fail closed,
// shared arm-key list), the .sealed base rule, check_blinding's bh-ad/1 extension (parity with the guard), the
// @brianharness/core/ad-contracts export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as C from "../src/ad-contracts/index.ts";
import * as X from "../src/ad-contracts/examples.ts";
import { MemoryKV } from "../src/platform/kv.ts";
import { AdSessionLog, AdStorage, buildAdUpload, ManualClock, redactForMain } from "../src/actor-director/index.ts";
import type { BhAdEventBody } from "../src/ad-contracts/index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOOL = join(ROOT, "tools", "phaseD", "check_blinding.mjs");
const E = X.events;
const body = <T extends Record<string, unknown>>(e: T) => { const { schema: _s, t: _t, mono: _m, sessionId: _i, seq: _q, ...b } = e; return b as unknown as BhAdEventBody; };
const SID = "ad-2026-11-04-7f3a";

test("shared arm-key list: exactly protocol 4's ARM_KEYS, and events.ts constants equal blinding.json", () => {
  assert.equal(C.armKeyRegExp().source, /^(?:adaptation|study[_-]?mode|study[_-]?arm|arm|condition|assignment|schedule|order|seed)$/i.source);
  assert.equal(C.armKeyRegExp().flags, "i");
  const j = JSON.parse(readFileSync(join(ROOT, "packages/core/src/ad-contracts/blinding.json"), "utf8"));
  assert.deepEqual(j.sealedOnlyTypes, [...C.SEALED_ONLY_TYPES]);
  assert.deepEqual(j.tabOnlyFields, JSON.parse(JSON.stringify(C.TAB_ONLY_FIELDS)));
  assert.equal(j.sealedSessionSuffix, C.SEALED_SESSION_SUFFIX);
  // check_blinding reads the same file (no private copy of the list)
  const tool = readFileSync(TOOL, "utf8");
  assert.match(tool, /ad-contracts\/blinding\.json/);
  assert.doesNotMatch(tool, /adaptation\|study/);
  assert.ok(C.HEALTH_CODES.includes("upload.blinded_guard"));
});

function blindedSession() {
  const kv = new MemoryKV();
  return AdStorage.open(kv).then((st) => ({ kv, st, clock: new ManualClock(), log: null as AdSessionLog | null }));
}
const fullBlindedRun = (log: AdSessionLog) => {
  for (const e of [E.session_start_blinded_sealed, E.gaze_quality, E.user_turn, E.director_call, E.rail_check, E.injection, E.context_share, E.actor_turn, E.note_outcome,
    { ...E.health, code: "director.leak_breaker", check: "director.leak_breaker", detail: "2 safety leaks", http_status: undefined, worker_code: undefined, role: undefined }, E.health, E.session_share, E.session_end]) {
    const b = body(JSON.parse(JSON.stringify(e)));
    log.emit(b);
  }
};

test("blinded logger: sealed log has everything; main log is redacted, seq 0..n without gaps, passes the guard", async () => {
  const { st, clock } = await blindedSession();
  const log = new AdSessionLog(st, SID, "blinded", clock);
  fullBlindedRun(log);
  await st.flush();
  const sealed = st.read("sealed", SID)!.trim().split("\n").map((l) => JSON.parse(l));
  const main = st.read("blinded", SID)!.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sealed.length, 13);
  assert.deepEqual(main.map((e) => e.type), ["session_start", "gaze_quality", "user_turn", "actor_turn", "health", "session_end"]);
  assert.deepEqual(main.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(sealed.map((e) => e.seq), [...sealed.keys()]);
  assert.equal(main[0].arm, undefined); assert.equal(main[0].p_inject, undefined); assert.equal(sealed[0].arm, "off");
  assert.equal(main[3].usage.prompt_tokens, null); assert.equal(main[3].sealed, true); assert.ok(!("note_id" in main[3]));
  assert.equal(log.guardDrops, 0);
  assert.deepEqual(C.blindedGuard(SID, st.read("blinded", SID)!), { ok: true });
  assert.deepEqual(C.blindedGuard(SID + ".sealed", st.read("sealed", SID)!, st.read("blinded", SID)), { ok: true });
  assert.equal(st.list("visible").length, 0);
  assert.deepEqual(st.list("blinded"), [SID]);
});

test("tab_visible logger: one visible log, arm kept, guard passes", async () => {
  const st = await AdStorage.open(new MemoryKV());
  const log = new AdSessionLog(st, SID, "tab_visible", new ManualClock());
  log.emit(body(E.session_start_tab_visible)); log.emit(body(E.injection)); log.emit(body(E.session_end));
  const lines = st.read("visible", SID)!.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].arm, "on");
  assert.deepEqual(C.blindedGuard(SID, st.read("visible", SID)!), { ok: true });
  assert.deepEqual(st.list("blinded"), []);
});

test("storage: ad/ namespaces survive a reopen and never touch protocol-4 keys", async () => {
  const kv = new MemoryKV();
  await kv.set("sessions/abc", "{}");
  const st = await AdStorage.open(kv);
  new AdSessionLog(st, SID, "blinded", new ManualClock()).emit(body(E.session_start_blinded_sealed));
  await st.flush();
  assert.deepEqual((await kv.keys()).sort(), ["ad/blinded/" + SID, "ad/sealed/" + SID, "sessions/abc"]);
  const re = await AdStorage.open(kv);
  assert.equal(re.read("sealed", SID), st.read("sealed", SID));
  const log2 = new AdSessionLog(re, SID, "blinded", new ManualClock());
  log2.emit(body(E.session_end));
  assert.equal(JSON.parse(re.read("blinded", SID)!.trim().split("\n")[1]!).seq, 1, "seq continues after reopen");
});

const mk = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const clean = [E.session_start_blinded_main, E.user_turn, E.actor_turn_blinded_main, E.session_end];
const DIRTY: Array<[string, object[], C.BlindedGuardCode]> = [
  ["arm in session_start", [{ ...E.session_start_blinded_main, arm: "on" }, E.session_end], "arm_field"],
  ["p_inject", [{ ...E.session_start_blinded_main, p_inject: 0.5 }], "arm_field"],
  ["note_id on actor_turn", [E.session_start_blinded_main, { ...E.actor_turn_blinded_main, note_id: "n5" }], "tab_only_field"],
  ["request sha", [E.session_start_blinded_main, { ...E.actor_turn_blinded_main, actor_request_sha256: "0".repeat(64) }], "tab_only_field"],
  ["sealed type", [E.session_start_blinded_main, E.injection], "sealed_type"],
  ["context_share", [E.session_start_blinded_main, E.context_share], "sealed_type"],
  ["prompt tokens", [E.session_start_blinded_main, { ...E.actor_turn_blinded_main, usage: E.actor_turn.usage }], "prompt_tokens"],
  ["leak breaker health", [E.session_start_blinded_main, { ...E.health, check: "director.leak_breaker", code: "director.leak_breaker" }], "sealed_health"],
  ["nested arm key", [E.session_start_blinded_main, { ...E.gaze_quality, calib: { ...E.gaze_quality.calib, condition: "x" } }], "arm_key"],
  ["arm key deep in array", [E.session_start_blinded_main, { ...E.scroll, samples: [{ t: 1, top: 2, Study_Arm: "y" }] }], "arm_key"],
  ["seed key", [E.session_start_blinded_main, { ...E.session_end, seed: 4 }], "arm_key"],
  ["no session_start", [E.user_turn, E.session_end], "no_session_start"],
  ["other session", [E.session_start_blinded_main, { ...E.session_end, sessionId: "other" }], "session_id_mismatch"],
];

test("blinded guard: clean main passes; every dirty kind is rejected with its code (fail closed)", () => {
  assert.deepEqual(C.blindedGuard(SID, mk(clean)), { ok: true });
  for (const [name, lines, code] of DIRTY) {
    const r = C.blindedGuard(SID, mk(lines));
    assert.equal(r.ok, false, name);
    assert.equal((r as { code: string }).code, code, name);
  }
  assert.equal((C.blindedGuard(SID, "not json\n") as { code: string }).code, "not_bh_ad");
  assert.equal((C.blindedGuard(SID, mk([{ ...E.session_start_blinded_main, session_type: "mystery" }])) as { code: string }).code, "no_session_start");
});

test(".sealed upload: rejected unless both its own session_start and the base main log are blinded", () => {
  const sealed = mk([E.session_start_blinded_sealed, E.injection]);
  assert.deepEqual(C.blindedGuard(SID + ".sealed", sealed, mk(clean)), { ok: true });
  for (const [s, base] of [[sealed, null], [sealed, mk([E.session_start_tab_visible])], [mk([E.session_start_tab_visible]), mk(clean)], [sealed, mk([{ ...E.session_start_blinded_main, sessionId: "zzz" }])]] as const) {
    const r = C.blindedGuard(SID + ".sealed", s, base);
    assert.equal((r as { code: string }).code, "sealed_base_not_blinded");
  }
});

test("buildAdUpload: guard refusal writes an upload.blinded_guard health line with the code only; clean logs build envelopes", async () => {
  const st = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const log = new AdSessionLog(st, SID, "blinded", clock);
  fullBlindedRun(log);
  const meta = { appVersion: "0.1.0", platform: "ios", build: "20261104.1335" };
  const a = buildAdUpload(st, "blinded", SID, meta, clock);
  assert.ok(a.ok); assert.equal(a.ok && a.envelope.sessionId, SID);
  const b = buildAdUpload(st, "sealed", SID, meta, clock);
  assert.ok(b.ok); assert.equal(b.ok && b.envelope.sessionId, SID + ".sealed");
  // corrupt the main log by hand: the next upload is refused and says why in plain health
  st.appendLine("blinded", SID, JSON.stringify({ ...E.injection, sessionId: SID, seq: 99 }));
  const c = buildAdUpload(st, "blinded", SID, meta, clock);
  assert.deepEqual(c, { ok: false, code: "sealed_type", line: 7 });
  const last = JSON.parse(st.read("blinded", SID)!.trim().split("\n").pop()!);
  assert.equal(last.code, "upload.blinded_guard"); assert.equal(last.detail, "sealed_type"); assert.equal(last.ok, false);
  // a blinded .sealed upload whose base is not blinded (v1.3: the session types must match)
  const st2 = await AdStorage.open(new MemoryKV());
  st2.appendLine("visible", SID, JSON.stringify({ ...E.session_start_tab_visible, sessionId: SID }));
  st2.appendLine("sealed", SID, JSON.stringify(E.session_start_blinded_sealed));
  assert.equal((buildAdUpload(st2, "sealed", SID, meta, clock) as { code: string }).code, "sealed_base_not_blinded");
  // v1.3: a tab_visible session's sealed companion uploads as <id>.sealed against its tab_visible base
  const st3 = await AdStorage.open(new MemoryKV());
  new AdSessionLog(st3, SID, "tab_visible", clock).emit(body(E.session_start_tab_visible));
  const s3 = buildAdUpload(st3, "sealed", SID, meta, clock);
  assert.ok(s3.ok && s3.envelope.sessionId === SID + ".sealed");
});

test("redactForMain is idempotent and its output always passes the per-line guard rules", () => {
  for (const e of Object.values(E)) {
    const r = redactForMain(body(e as Record<string, unknown>));
    if (!r) continue;
    assert.deepEqual(redactForMain(r), r);
    if (r.type === "session_start") continue; // session_start of a tab_visible example is not a blinded line
    assert.equal(C.blindedMainLineViolation({ ...r } as Record<string, unknown>), null, r.type);
  }
});

test("check_blinding.mjs really checks bh-ad/1 blinded main logs, with the same verdicts as the guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adcb-"));
  const run = () => { try { return { code: 0, out: execFileSync(process.execPath, [TOOL, dir], { encoding: "utf8" }) }; } catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; } };
  writeFileSync(join(dir, SID + ".jsonl"), mk(clean));
  writeFileSync(join(dir, SID + ".sealed.jsonl"), mk([E.session_start_blinded_sealed, E.injection]));
  writeFileSync(join(dir, "vis.jsonl"), mk([E.session_start_tab_visible, E.injection]));
  let r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /bh-ad\/1: 1 blinded main \(checked\), 1 sealed/);
  for (const [name, lines] of DIRTY) {
    if (name === "other session") continue; // a file-level rule of the upload guard only
    writeFileSync(join(dir, SID + ".jsonl"), mk(lines));
    r = run();
    assert.notEqual(r.code, 0, name);
    assert.match(r.out, /LEAK .*bh-ad\/1/, name);
    // same verdict kind as the guard
    const g = C.blindedGuard(SID, mk(lines)) as { code: string };
    if (g.code !== "no_session_start") assert.match(r.out, new RegExp(g.code), name);
  }
});

test("package export @brianharness/core/ad-contracts and ./actor-director", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./ad-contracts"], { types: "./dist/ad-contracts/index.d.ts", import: "./dist/ad-contracts/index.js" });
  assert.ok(pkg.exports["./actor-director"]);
});

test("built dist: import('@brianharness/core/ad-contracts') resolves (pretest build)", async () => {
  const m = await import("@brianharness/core/ad-contracts");
  assert.equal(m.CONTRACT_VERSION, "contract-v1.4");
  assert.equal(typeof m.blindedGuard, "function");
});
