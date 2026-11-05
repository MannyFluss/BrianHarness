// contract-v1.5 Mac release additions: input_mode, p<k> pointer evidence (interactive AOIs only, dwell >= 500 ms),
// choosable Actor / Director models (actor_model / director_model + model_change), cloud-only refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvMod from "ajv";
import * as C from "../src/ad-contracts/index.ts";
import * as X from "../src/ad-contracts/examples.ts";
import { runRails } from "../src/actor-director/rails.ts";
import { isCloudModelTag } from "../src/llm-extractor.ts";

const DIR = join(import.meta.dirname, "..", "src", "ad-contracts");
const BASE = "https://brianharness.app/contracts/v1/";
const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;
const ajv = new (Ajv as unknown as new (o: object) => { addSchema(s: object): void; getSchema(r: string): ((v: unknown) => boolean) | undefined })({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
for (const f of ["gaze-sample.schema.json", "gaze-plugin.schema.json", "note.schema.json", "bh-ad-events.schema.json", "worker.schema.json"]) ajv.addSchema(JSON.parse(readFileSync(join(DIR, "schemas", f), "utf8")));
const ev = (v: unknown) => ajv.getSchema(BASE + "bh-ad-events.schema.json")!(v);
const note = (v: unknown) => ajv.getSchema(BASE + "note.schema.json")!(v);
const E = X.events;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const SID = E.session_start_pointer.sessionId;
const jsonl = (...lines: object[]) => lines.map((l, i) => JSON.stringify({ ...l, seq: i })).join("\n") + "\n";
const ok = { ok: true };

test("v1.5 pointer: p<k> is evidence; prefixes name the source; no evidence_source field", () => {
  const re = new RegExp(C.EVIDENCE_ID_PATTERN);
  for (const id of ["p4", "e31", "u12", "a7", "a7.p2", "a7.p2.s1"]) assert.ok(re.test(id), id);
  for (const id of ["p", "pp4", "a7.p", "q3"]) assert.ok(!re.test(id), id);
  assert.deepEqual(["e3", "p4", "a7.p2", "u1"].map(C.evidenceSource), ["gaze", "pointer", "chat", "chat"]);
  const n = clone(X.directorOutputNote); n.note.evidence = ["p5", "a3.p2.s1"];
  assert.ok(note(n), "a note citing p ids validates");
  assert.ok(!JSON.stringify(readFileSync(join(DIR, "schemas", "note.schema.json"), "utf8")).includes("evidence_source"));
});

test("v1.5 pointer: session_start input_mode / pointer_config / model fields (schema)", () => {
  assert.ok(ev(E.session_start_pointer)); assert.ok(ev(E.session_start_tab_visible));
  assert.equal(E.session_start_pointer.pointer_config.id, C.pointerConfigId(500, 100));
  assert.deepEqual(C.DEFAULT_POINTER_CONFIG, { id: "pc1-d500-g100", dwell_ms: 500, merge_gap_ms: 100 });
  const s = clone(E.session_start_pointer) as Record<string, unknown>;
  for (const k of ["input_mode", "actor_model", "director_model"]) { const t = { ...s }; delete t[k]; assert.ok(!ev(t), `v1.5 requires ${k}`); }
  const noCfg = { ...s }; delete noCfg.pointer_config; assert.ok(!ev(noCfg), "pointer mode requires pointer_config");
  assert.ok(!ev({ ...clone(E.session_start_tab_visible), pointer_config: C.DEFAULT_POINTER_CONFIG }), "pointer_config only in pointer mode");
  assert.ok(!ev({ ...s, input_mode: "mouse" }));
  // a v1.4 line without the new fields still validates (absent input_mode = gaze)
  const old = clone(E.session_start_tab_visible) as Record<string, unknown>; delete old.input_mode; delete old.actor_model; delete old.director_model; old.contract = "contract-v1.4";
  assert.ok(ev(old)); assert.equal(C.LEGACY_INPUT_MODE, "gaze");
});

test("v1.5 pointer: pointer_l1 / digest / aoi_layout shapes", () => {
  for (const e of [E.pointer_l1, E.attention_digest_pointer, E.aoi_layout_pointer, E.model_change]) assert.ok(ev(e), e.type);
  const p = E.pointer_l1.events;
  assert.ok(!ev({ ...E.pointer_l1, events: [{ ...p[0]!, kind: "pointer_scroll" }] }), "four kinds only");
  assert.ok(!ev({ ...E.pointer_l1, events: [{ ...p[0]!, dwell_ms: 900 }] }), "dwell_ms only on pointer_dwell");
  const { dwell_ms: _d, ...noDwell } = p[1]!; assert.ok(!ev({ ...E.pointer_l1, events: [noDwell] }), "pointer_dwell needs dwell_ms");
  assert.ok(!ev({ ...E.pointer_l1, events: [{ ...p[0]!, id: "e4" }] }), "pointer ids are p<k>");
  assert.ok(!ev({ ...E.pointer_l1, events: Array.from({ length: 21 }, (_, i) => ({ ...p[0]!, id: "p" + i })) }), "<= 20 per batch");
  assert.ok(!ev({ ...E.pointer_l1, events: [{ ...p[0]!, x: 10, y: 20 }] }), "no coordinates");
  assert.ok(!ev({ ...E.model_change, role: "judge" }), "the judge is not in the picker");
  assert.ok(C.EVENT_TYPES.includes("pointer_l1") && C.EVENT_TYPES.includes("model_change"));
});

test("v1.5 pointer: interactive-only, no text presence, dwell >= threshold (pointerEventViolation)", () => {
  const inter = new Set(["a3.c1", "a3.p2.s1"]);
  const base = { id: "p1", msg: "a3", t0: 1, t1: 1 } as const;
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_click", aoi: "a3.c1" }, inter), null);
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_select", aoi: "a3.p2.s1" }, inter), null);
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_hover", aoi: "a3.c9" }, inter), "pointer_not_interactive");
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_click", aoi: "a3.p1" }, inter), "pointer_not_interactive");
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_dwell", aoi: "a3.p1", dwell_ms: 900 }, new Set(["a3.p1"])), "pointer_text_presence", "paragraph dwell even if mis-marked");
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_hover", aoi: "composer" }, new Set(["composer"])), "pointer_text_presence");
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_dwell", aoi: "a3.c1", dwell_ms: 499 }, inter), "pointer_dwell_short");
  assert.equal(C.pointerEventViolation({ ...base, kind: "pointer_dwell", aoi: "a3.c1", dwell_ms: 320 }, inter, { dwell_ms: 300 }), null, "threshold from pointer_config");
});

test("v1.5 pointer: the upload guard fences input modes and pointer evidence", () => {
  const start = E.session_start_pointer, lay = E.aoi_layout_pointer, pl = E.pointer_l1, dg = E.attention_digest_pointer;
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, lay, pl, dg, E.model_change)), ok);
  // gaze lines in pointer mode; pointer lines in gaze mode; either in none
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, lay, E.gaze_l1)), { ok: false, code: "input_mode_mismatch", line: 3 });
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, lay, E.attention_digest)), { ok: false, code: "input_mode_mismatch", line: 3 });
  const gazeStart = E.session_start_tab_visible;
  assert.deepEqual(C.blindedGuard(SID, jsonl(gazeStart, lay, pl)), { ok: false, code: "input_mode_mismatch", line: 3 });
  assert.deepEqual(C.blindedGuard(SID, jsonl(gazeStart, E.attention_digest)), ok);
  const noneStart = { ...clone(gazeStart), input_mode: "none" };
  assert.deepEqual(C.blindedGuard(SID, jsonl(noneStart, lay, pl)), { ok: false, code: "input_mode_mismatch", line: 3 });
  assert.deepEqual(C.blindedGuard(SID, jsonl(noneStart, dg)), { ok: false, code: "input_mode_mismatch", line: 2 });
  const emptyDigest = { ...clone(dg), digest: { ...clone(dg.digest), input_mode: "none", pointer: [] } };
  assert.deepEqual(C.blindedGuard(SID, jsonl(noneStart, emptyDigest)), ok);
  // a mid-session mode switch is a new session, not a second session_start
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, { ...clone(start), input_mode: "gaze" })), { ok: false, code: "input_mode_mismatch", line: 2 });
  // pointer events: layout must come first and mark the AOI interactive
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, pl)), { ok: false, code: "pointer_not_interactive", line: 2 });
  const textLay = { ...clone(lay), boxes: lay.boxes.map((b) => ({ ...b, interactive: undefined })) };
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, textLay, pl)), { ok: false, code: "pointer_not_interactive", line: 3 });
  const paraDwell = { ...clone(pl), events: [{ id: "p9", kind: "pointer_dwell", aoi: "a3.p1", msg: "a3", t0: 1, t1: 901, dwell_ms: 900 }] };
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, lay, paraDwell)), { ok: false, code: "pointer_text_presence", line: 3 });
  const short = { ...clone(pl), events: [{ id: "p9", kind: "pointer_dwell", aoi: "a3.c1", msg: "a3", t0: 1, t1: 300, dwell_ms: 299 }] };
  assert.deepEqual(C.blindedGuard(SID, jsonl(start, lay, short)), { ok: false, code: "pointer_invalid", line: 3 });
  // and the guard codes are exported
  for (const c of ["input_mode_mismatch", "pointer_not_interactive", "pointer_text_presence", "pointer_invalid"]) assert.ok((C.BLINDED_GUARD_CODES as readonly string[]).includes(c));
});

test("v1.5 pointer: rails block ids outside the session's input mode as evidence_unknown", () => {
  const out = (evidence: string[]) => ({ ...clone(X.directorOutputNote), note: { ...clone(X.directorOutputNote.note), evidence } });
  const ctx = (inputMode: C.InputMode, input: string) => ({ input, previousActorTexts: [], directorEnabled: true, cameraConsent: inputMode === "gaze", leakBreakerTripped: false, inputMode });
  const pointerInput = "pointer: p5 dwell 880 ms on a3.c1 \"Show the math\"; p6 select a3.p2.s1\nu3: ok";
  assert.ok(!runRails(out(["p5", "a3.p2.s1"]), ctx("pointer", pointerInput)).blocked_by.includes("evidence_unknown"));
  assert.ok(runRails(out(["p7"]), ctx("pointer", pointerInput)).blocked_by.includes("evidence_unknown"), "a control never hit");
  assert.ok(runRails(out(["e31"]), ctx("pointer", pointerInput + " e31")).blocked_by.includes("evidence_unknown"), "no e<k> in pointer mode");
  assert.ok(runRails(out(["p5"]), ctx("gaze", pointerInput)).blocked_by.includes("evidence_unknown"), "no p<k> in gaze mode");
  assert.ok(runRails(out(["p5"]), ctx("none", pointerInput)).blocked_by.includes("evidence_unknown"), "none: neither");
  assert.ok(!runRails(out(["u3"]), ctx("none", pointerInput)).blocked_by.includes("evidence_unknown"), "none: chat ids fine");
  assert.deepEqual(C.evidenceOutsideMode("none", ["e1", "p2", "a1.p2", "u4"]), ["e1", "p2"]);
});

test("v1.5 models: canonical actor_model / director_model equal models; model_change; cloud-only refusal", () => {
  assert.equal(C.sessionModelsViolation(E.session_start_pointer), null);
  assert.equal(C.sessionModelsViolation({ ...clone(E.session_start_pointer), actor_model: "gpt-oss:120b-cloud" }), "actor_model != models.actor");
  assert.equal(C.DEFAULT_ACTOR_MODEL, "gpt-oss:20b-cloud"); assert.equal(C.DEFAULT_DIRECTOR_MODEL, "gpt-oss:120b-cloud"); assert.equal(C.LEAK_JUDGE_MODEL, "gemma4:cloud");
  assert.deepEqual([...C.MODEL_ROLES], ["actor", "director"]);
  for (const t of ["gpt-oss:20b-cloud", "gpt-oss:120b-cloud", "gemma4:cloud", "qwen3-coder:480b-cloud"]) { assert.equal(C.modelRefusal(t), null, t); assert.ok(isCloudModelTag(t)); }
  for (const t of ["gpt-oss:20b", "llama3.2", "gemma4:latest", "cloud", ":cloud", "gpt-oss:20b-cloud ", "gpt-oss:20b-cloud:local"]) { assert.ok(C.modelRefusal(t), t); }
  for (const t of ["gpt-oss:20b", "llama3.2", "gemma4:latest"]) assert.equal(C.isCloudModel(t), isCloudModelTag(t), "same rule as llm-extractor: " + t);
  assert.match(C.modelRefusal("gpt-oss:120b-cloud", ["gpt-oss:20b-cloud"])!, /allowlist/);
  for (const u of ["http://localhost:11434", "http://127.0.0.1:8787", "http://192.168.1.4", "http://mac.local", "https://ollama.internal", "http://[::1]:8080", "https://w.example.com:11434"]) assert.ok(C.localEndpointReason(new URL(u)), u);
  for (const u of ["https://ollama.com", "https://bh-worker.example.workers.dev"]) assert.equal(C.localEndpointReason(new URL(u)), null, u);
});

test("v1.5: ActorDirectorSession.start() writes input_mode, pointer_config, actor_model / director_model; schema + guard pass", async () => {
  const { ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, loadO200k } = await import("../src/actor-director/index.ts");
  const { MemoryKV } = await import("../src/platform/kv.ts");
  const o200k = loadO200k();
  for (const [inputMode, models] of [["pointer", { actor: "gpt-oss:120b-cloud", director: "gpt-oss:20b-cloud" }], ["gaze", undefined], ["none", undefined]] as const) {
    const storage = await AdStorage.open(new MemoryKV());
    const log = new AdSessionLog(storage, "s-v15-" + inputMode, "tab_visible", new ManualClock());
    const mock = new MockAdBackend([], () => ({ text: "hi" }));
    const s = new ActorDirectorSession({ log, userId: "u", sessionType: "tab_visible", arm: "on", actor: mock, director: mock, counter: o200k, consent: { camera: false, rawGaze: false }, inputMode, ...(models ? { models } : {}) });
    s.start();
    const ss = log.lines[0] as Extract<C.BhAdEvent, { type: "session_start" }>;
    assert.ok(ev(ss), inputMode + " session_start validates");
    assert.equal(ss.input_mode, inputMode); assert.equal(ss.actor_model, ss.models.actor); assert.equal(ss.director_model, ss.models.director);
    assert.equal(C.sessionModelsViolation(ss), null);
    if (inputMode === "pointer") { assert.deepEqual(ss.pointer_config, C.DEFAULT_POINTER_CONFIG); assert.equal(ss.actor_model, "gpt-oss:120b-cloud"); } else assert.equal(ss.pointer_config, undefined);
    assert.deepEqual(C.blindedGuard(log.sessionId, log.lines.map((l) => JSON.stringify(l)).join("\n") + "\n"), ok);
  }
});

test("v1.5 pointer: a 20-minute Pointer session at the pointer_l1 cap fits 1 MiB", () => {
  const pe = E.pointer_l1.events[1]!;
  const lines: unknown[] = [E.session_start_pointer];
  let seq = 1;
  for (let b = 0; b < 240; b++) lines.push({ ...E.pointer_l1, seq: seq++, events: Array.from({ length: 20 }, (_, i) => ({ ...pe, id: `p${b * 20 + i}`, aoi: "a3.p2.s1" })) });
  const digest = { ...E.attention_digest_pointer, digest: { ...E.attention_digest_pointer.digest, pointer: Array.from({ length: 24 }, (_, i) => ({ ...E.attention_digest_pointer.digest.pointer[0]!, id: "p" + i })) } };
  for (let t = 0; t < 20; t++) for (const k of ["aoi_layout_pointer", "user_turn", "director_call", "rail_check", "injection", "context_share", "actor_turn", "note_outcome", "model_change"] as const) lines.push({ ...E[k], seq: seq++ });
  for (let t = 0; t < 20; t++) lines.push({ ...digest, seq: seq++ });
  lines.push(E.session_share, E.session_end);
  const bytes = Buffer.byteLength(JSON.stringify({ ...X.uploadEnvelope, jsonl: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" }), "utf8");
  assert.ok(bytes < C.AD_UPLOAD_MAX_BYTES, `${bytes} bytes`);
  console.log(`# worst-case 20-min Pointer upload at the pointer_l1 cap: ${bytes} bytes (${((100 * bytes) / C.AD_UPLOAD_MAX_BYTES).toFixed(1)}% of 1 MiB)`);
});
