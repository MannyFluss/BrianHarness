// contract-v1.5: upload event-type allowlist, gaze_raw / sim-marker / long-id rejection, main-before-sealed order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLINDING_CONTRACT, BLINDED_GUARD_CODES, CONTRACT_VERSION, EVENT_TYPES, MAX_BASE_SESSION_ID_LENGTH, AD_BASE_SESSION_ID_MAX, AD_SESSION_ID_PATTERN, SEALED_SESSION_SUFFIX, WORKER_ERROR_CODES, blindedGuard } from "../src/ad-contracts/index.ts";

const EX = new URL("../src/ad-contracts/examples/", import.meta.url).pathname;
const ROOT = new URL("../../..", import.meta.url).pathname;
const ex = (n: string) => JSON.parse(readFileSync(join(EX, n + ".json"), "utf8"));
const ID = "ad-v15-test";
const L = (o: Record<string, unknown>) => JSON.stringify({ schema: "bh-ad/1", t: "2026-11-04T23:10:00.000Z", mono: 0, sessionId: ID, seq: 0, ...o });
const startVisible = () => L({ ...ex("event-session-start-tab-visible"), sessionId: ID });
const log = (...rest: string[]) => [startVisible(), ...rest].join("\n") + "\n";

test("v1.5: blinding.json contract equals CONTRACT_VERSION; codes exported", () => {
  assert.equal(CONTRACT_VERSION, "contract-v1.5"); assert.equal(BLINDING_CONTRACT, CONTRACT_VERSION);
  for (const c of ["unknown_event_type", "gaze_raw_forbidden", "sim_marker", "session_id_too_long"]) assert.ok((BLINDED_GUARD_CODES as readonly string[]).includes(c));
  assert.ok((WORKER_ERROR_CODES as readonly string[]).includes("blinded_guard"));
});

test("v1.5: the allowlist is exactly the event types of events.ts and of the examples", () => {
  const src = readFileSync(new URL("../src/ad-contracts/events.ts", import.meta.url), "utf8");
  const fromCode = [...new Set([...src.matchAll(/type: "([a-z_0-9]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...EVENT_TYPES].sort(), fromCode); assert.equal(EVENT_TYPES.length, 23); // 21 + pointer_l1, model_change (Nov 5)
  const fromEx = new Set(readdirSync(EX).filter((f) => f.startsWith("event-")).map((f) => JSON.parse(readFileSync(join(EX, f), "utf8")).type));
  for (const t of fromEx) assert.ok(EVENT_TYPES.includes(t), t);
});

test("v1.5: every v1.x event type except gaze_raw passes in a tab_visible main upload or its sealed companion", () => {
  const sealedOnly = ["director_call", "rail_check", "injection", "note_dropped", "leak_judge", "tab_occluded", "context_share", "note_outcome", "session_share"];
  const base = log();
  for (const t of EVENT_TYPES) {
    if (t === "gaze_raw" || t === "session_start" || t === "pointer_l1") continue; // pointer_l1: pointer-mode sessions only (ad-v15-pointer.test.ts)
    const line = L({ type: t, turn: 1 });
    if (t === "leak_judge" || sealedOnly.includes(t)) {
      assert.deepEqual(blindedGuard(ID + SEALED_SESSION_SUFFIX, log(line), base), { ok: true }, t);
      if (t !== "leak_judge" && t !== "note_dropped") assert.deepEqual(blindedGuard(ID, log(line)), { ok: true }, t);
    } else assert.deepEqual(blindedGuard(ID, log(line)), { ok: true }, t);
  }
});

test("v1.5: unknown type, gaze_raw and sim markers rejected with their codes on main and sealed uploads", () => {
  const base = log();
  for (const [line, code] of [[L({ type: "survey" }), "unknown_event_type"], [L({ type: "made_up" }), "unknown_event_type"], [L({ type: "gaze_raw", samples: [] }), "gaze_raw_forbidden"],
    [L({ type: "health", check: "gaze", ok: true, code: null, detail: "aid bh-ad-sim-walk/1" }), "sim_marker"], [L({ type: "health", check: "gaze", ok: true, code: null, detail: "bh-ad-sim-look/1" }), "sim_marker"],
    [L({ type: "scroll", samples: [], marker: "bh-ad-sim-future/2" }), "sim_marker"]] as const) {
    assert.deepEqual(blindedGuard(ID, log(line)), { ok: false, code, line: 2 }, line);
    assert.deepEqual(blindedGuard(ID + SEALED_SESSION_SUFFIX, log(line), base), { ok: false, code, line: 2 }, line);
  }
});

test("v1.5: base session id <= 121 so <id>.sealed fits the 128 id pattern", () => {
  assert.equal(MAX_BASE_SESSION_ID_LENGTH, 121); assert.equal(AD_BASE_SESSION_ID_MAX, 121);
  const re = new RegExp(AD_SESSION_ID_PATTERN);
  const ok = "a".repeat(121), bad = "a".repeat(122);
  assert.ok(re.test(ok + SEALED_SESSION_SUFFIX)); assert.ok(!re.test(bad + SEALED_SESSION_SUFFIX));
  const mk = (id: string) => [L({ ...ex("event-session-start-tab-visible"), sessionId: id }).replace(`"sessionId":"${ID}"`, "")].join("\n");
  const one = (id: string) => JSON.stringify({ ...JSON.parse(mk(id)), sessionId: id }) + "\n";
  assert.deepEqual(blindedGuard(ok, one(ok)), { ok: true });
  assert.deepEqual(blindedGuard(bad, one(bad)), { ok: false, code: "session_id_too_long", line: 1 });
  assert.deepEqual(blindedGuard(bad + SEALED_SESSION_SUFFIX, one(bad), one(bad)), { ok: false, code: "session_id_too_long", line: 1 });
});

test("v1.5: check_blinding.mjs flags unknown types, gaze_raw and sim markers", () => {
  const d = mkdtempSync(join(tmpdir(), "bh-v15-"));
  writeFileSync(join(d, "s.jsonl"), log(L({ type: "made_up" }), L({ type: "gaze_raw", samples: [] }), L({ type: "health", detail: "bh-ad-sim-walk/1" })));
  let out = "";
  try { out = execFileSync("node", [join(ROOT, "tools/phaseD/check_blinding.mjs"), d], { encoding: "utf8" }); } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  assert.match(out, /unknown_event_type made_up/); assert.match(out, /gaze_raw_forbidden/); assert.match(out, /sim_marker/);
});

test("v1.5: buildAdUploads returns the main log before its .sealed companion; no sealed if main fails", async () => {
  const { AdStorage } = await import("../src/actor-director/storage.ts");
  const { buildAdUploads } = await import("../src/actor-director/upload.ts");
  const m = new Map<string, string>();
  const kv = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, keys: async (p: string) => [...m.keys()].filter((k) => k.startsWith(p)), delete: async (k: string) => { m.delete(k); } };
  const s = await AdStorage.open(kv as never);
  s.appendLine("visible", ID, startVisible()); s.appendLine("sealed", ID, startVisible()); s.appendLine("sealed", ID, L({ type: "leak_judge", turn: 1 }));
  const clock = { now: () => 0, mono: () => 0 };
  const r = buildAdUploads(s, ID, { appVersion: "0.1.0", platform: "mac" }, clock as never);
  assert.deepEqual(r.map((x) => x.ns), ["visible", "sealed"]);
  assert.ok(r[0]!.result.ok && r[1]!.result.ok);
  assert.equal((r[0]!.result as { envelope: { sessionId: string } }).envelope.sessionId, ID);
  assert.equal((r[1]!.result as { envelope: { sessionId: string } }).envelope.sessionId, ID + ".sealed");
  s.appendLine("visible", ID, L({ type: "made_up" }));
  const r2 = buildAdUploads(s, ID, { appVersion: "0.1.0", platform: "mac" }, clock as never);
  assert.equal(r2.length, 1); assert.equal(r2[0]!.result.ok, false);
});
