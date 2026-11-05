// contract-v1 (Actor/Director): every example validates against its JSON Schema, the schemas match their builder,
// examples/*.json and README.md carry exactly the examples, TS enums match schema enums, negative cases fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import AjvMod from "ajv";
import * as C from "../src/ad-contracts/index.ts";
import * as X from "../src/ad-contracts/examples.ts";
import { exampleFiles } from "./ad-contracts-examples.ts";

const DIR = join(import.meta.dirname, "..", "src", "ad-contracts");
const BASE = "https://brianharness.app/contracts/v1/";
const FILES = ["gaze-sample.schema.json", "gaze-plugin.schema.json", "note.schema.json", "bh-ad-events.schema.json", "worker.schema.json"];
const Ajv = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;
const ajv = new (Ajv as unknown as new (o: object) => { addSchema(s: object): void; getSchema(r: string): ((v: unknown) => boolean) & { errors?: unknown } | undefined })({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
const schemas: Record<string, Record<string, unknown>> = {};
for (const f of FILES) { schemas[f] = JSON.parse(readFileSync(join(DIR, "schemas", f), "utf8")); ajv.addSchema(schemas[f]!); }
const validator = (file: string, def: string | null) => {
  const v = ajv.getSchema(BASE + file + (def ? "#/definitions/" + def : ""));
  assert.ok(v, `schema ${file} ${def}`);
  return v!;
};
const valid = (file: string, def: string | null, value: unknown) => { const v = validator(file, def); const ok = v(value); return { ok, errors: v.errors }; };
const EV = "bh-ad-events.schema.json";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("contract version and frozen date", () => {
  assert.equal(C.CONTRACT_VERSION, "contract-v1.2");
  assert.equal(C.CONTRACT_FROZEN, "2026-11-04");
  assert.equal(C.BH_AD_SCHEMA, "bh-ad/1");
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  assert.match(readme, /contract-v1/);
  assert.match(readme, /Frozen: 2026-11-04/);
});

test("committed *.schema.json files equal build-schemas.mjs output", async () => {
  const mod = (await import(join(DIR, "schemas", "build-schemas.mjs"))) as { SCHEMAS: Record<string, unknown>; serialize: (s: unknown) => string };
  assert.deepEqual(Object.keys(mod.SCHEMAS).sort(), [...FILES].sort());
  for (const f of FILES) assert.equal(readFileSync(join(DIR, "schemas", f), "utf8"), mod.serialize(mod.SCHEMAS[f]), f + " is stale: run node build-schemas.mjs");
});

test("every example validates against its schema, and examples/*.json are in sync", () => {
  const ex = exampleFiles();
  const onDisk = readdirSync(join(DIR, "examples")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(onDisk, Object.keys(ex).sort(), "examples/ is stale: npx tsx scripts/ad-contracts-sync.ts");
  for (const [name, { schema, def, value }] of Object.entries(ex)) {
    const r = valid(schema, def, value);
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(JSON.parse(readFileSync(join(DIR, "examples", name + ".json"), "utf8")), JSON.parse(JSON.stringify(value)), name);
  }
});

test("README embeds every example payload verbatim and each one validates", () => {
  const readme = readFileSync(join(DIR, "README.md"), "utf8");
  const ex = exampleFiles();
  const re = /<!-- example: ([a-z0-9-]+) -->\s*```json\n([\s\S]*?)\n```/g;
  const seen = new Set<string>();
  for (const m of readme.matchAll(re)) {
    const ref = ex[m[1]!];
    assert.ok(ref, "README names unknown example " + m[1]);
    const v = JSON.parse(m[2]!);
    assert.deepEqual(v, JSON.parse(JSON.stringify(ref!.value)), "README example drifted: " + m[1]);
    assert.ok(valid(ref!.schema, ref!.def, v).ok, m[1]!);
    seen.add(m[1]!);
  }
  for (const need of ["gaze-sample", "plugin-start-options", "plugin-gaze-event", "director-output-note", "event-session-start-blinded-main", "event-context-share", "upload-envelope"]) assert.ok(seen.has(need), "README lacks example " + need);
});

test("TS enums equal schema enums", () => {
  const defs = (f: string) => (schemas[f] as { definitions: Record<string, { enum?: string[] }> }).definitions;
  assert.deepEqual(defs("gaze-plugin.schema.json").HealthCode!.enum, [...C.HEALTH_CODES]);
  assert.deepEqual(defs(EV).HealthCode!.enum, [...C.HEALTH_CODES]);
  assert.deepEqual(defs("note.schema.json").RailCode!.enum, [...C.RAIL_CODES]);
  assert.deepEqual(defs("note.schema.json").LeakCode!.enum, [...C.LEAK_CODES]);
  assert.deepEqual(defs("note.schema.json").SuggestionMove!.enum, [...C.SUGGESTION_MOVES]);
  assert.deepEqual(defs("worker.schema.json").Role!.enum, [...C.ROLES]);
  assert.deepEqual(defs("worker.schema.json").WorkerErrorCode!.enum, [...C.WORKER_ERROR_CODES]);
  const hc = (defs(EV) as unknown as Record<string, { properties: { check: { enum: string[] } } }>).ev_health!.properties.check.enum;
  assert.deepEqual(hc, [...C.HEALTH_CHECKS]);
  for (const k of Object.values(C.WORKER_CAP_TO_HEALTH)) assert.ok((C.HEALTH_CODES as readonly string[]).includes(k));
  for (const r of C.ROLES) assert.ok(`role_cap_${r}` in C.WORKER_CAP_TO_HEALTH && (C.WORKER_ERROR_CODES as readonly string[]).includes(`role_cap_${r}`));
  assert.equal(C.ROLE_CAPS.director, 100);
  assert.deepEqual([...C.SAFETY_LEAKS, ...C.QUALITY_LEAKS], [...C.LEAK_CODES]);
});

test("gaze: numbers only, never images; null estimate rules; rates 30/15", () => {
  const G = "gaze-sample.schema.json";
  assert.ok(!valid(G, null, { ...X.gazeSample, image: "data:image/jpeg;base64,/9j/" }).ok, "extra field (an image) is rejected");
  assert.ok(!valid(G, null, { ...X.gazeSample, x: null }).ok, "x null needs y null and conf 0");
  assert.ok(!valid(G, null, { ...X.gazeSampleNoFace, conf: 0.4 }).ok);
  assert.ok(!valid(G, null, { ...X.gazeSampleNoFace, head: X.gazeSample.head }).ok, "no head pose without a face");
  assert.ok(!valid(G, null, { ...X.gazeSample, conf: 1.2 }).ok);
  assert.ok(!valid(G, null, { ...X.gazeSample, src: "camera" }).ok);
  const P = "gaze-plugin.schema.json";
  assert.ok(!valid(P, "GazeBatchEvent", { ...X.pluginGazeBatch, frame: [1, 2, 3] }).ok, "no frame on a gaze event");
  assert.ok(!valid(P, "GazeBatchEvent", { ...X.pluginGazeBatch, hz: 60 }).ok, "30 or 15 Hz only");
  assert.ok(!valid(P, "GazeBatchEvent", { ...X.pluginGazeBatch, samples: [{ ...X.gazeSample, pixels: "AAAA" }] }).ok);
  assert.ok(!valid(P, "StartResult", { ...X.pluginStartResult, snapshot: "x" }).ok);
  assert.ok(!valid(P, "GazeStatus", { ...X.pluginStatusPaused, preview: true }).ok);
  // v1.0.1: getStatus() resolves to GazeStatus itself (gaze-plugin.ts); stop/pause/resume resolve to {status}
  assert.ok(valid(P, "StatusResult", X.pluginStatusPaused).ok);
  assert.ok(!valid(P, "StatusResult", { status: X.pluginStatusPaused }).ok);
  assert.ok(valid(P, "StopPauseResumeResult", { status: X.pluginStatusPaused }).ok);
  assert.ok(!valid(P, "StartOptions", { mode: "synthetic", webNow: 1 }).ok, "synthetic needs a source");
  assert.ok(!valid(P, "StartOptions", { mode: "camera", webNow: 1, synthetic: { file: "a.json" } }).ok);
  assert.ok(!valid(P, "SyntheticSource", { file: "/etc/passwd.json" }).ok, "bundle-relative path only");
  assert.ok(!valid(P, "SyntheticSource", { file: "../x.json" }).ok);
  assert.ok(!valid(P, "CalibrateOptions", { phase: "begin", orientation: "portrait", targets: [] }).ok);
  assert.equal(C.GAZE_HZ_NORMAL, 30); assert.equal(C.GAZE_HZ_HOT, 15);
});

test("note: rendered actor_text is the spec's exact bytes; validity rules", () => {
  assert.equal(X.actorText,
    "[Context for your next reply. Soft hints: answer the person first, use only what fits.\nDon't quote this or say where it came from.]\n" +
    "- They seem most drawn to why rye ferments faster; the hydration numbers landed flat.\n" +
    "- If it fits after answering them: go deeper on why rye ferments faster, and skip more ratios. (h:e31,e32,e33)");
  assert.ok(C.actorTextWords(X.actorText) <= C.MAX_ACTOR_TEXT_WORDS);
  assert.equal(C.actorTextWords(X.actorText), 14 + 6 + 11);
  assert.equal(C.renderActorText({ suggestion: { move: "check_in", text: "  ask how   it went? " }, evidence: ["u3", "e9"] }), C.HINT_HEADER + "\n- If it fits after answering them: ask how it went? (h:u3,e9)");
  assert.equal(C.noteKind(X.directorOutputNote.note), "both");
  const N = "note.schema.json";
  const o = clone(X.directorOutputNote);
  assert.ok(!valid(N, null, { ...o, no_note_reason: "x" }).ok, "note and a no-note reason");
  assert.ok(!valid(N, null, { ...X.directorOutputNoNote, no_note_reason: "" }).ok);
  assert.ok(!valid(N, null, { ...X.directorOutputNoNote, no_note_reason: null }).ok);
  const bare = clone(o); delete (bare.note as Partial<typeof bare.note>).observation; delete (bare.note as Partial<typeof bare.note>).suggestion;
  assert.ok(!valid(N, null, bare).ok, "neither observation nor suggestion");
  assert.ok(!valid(N, null, { ...o, note: { ...o.note, evidence: [] } }).ok);
  assert.ok(!valid(N, null, { ...o, note: { ...o.note, evidence: ["gaze:paragraph2"] } }).ok);
  assert.ok(!valid(N, null, { ...o, note: { ...o.note, actor_text: "x" } }).ok, "the model never writes actor_text");
  assert.ok(!valid(N, null, { ...o, note: { ...o.note, expires_after_turns: 2 } }).ok);
  assert.ok(!valid(N, null, { ...o, note: { ...o.note, suggestion: { move: "pivot", text: "x" } } }).ok);
});

test("DIRECTOR_OUTPUT_FORMAT_TEXT names every schema field and enum value", () => {
  const t = C.DIRECTOR_OUTPUT_FORMAT_TEXT;
  const defs = (schemas["note.schema.json"] as { definitions: Record<string, { properties?: Record<string, unknown> }> }).definitions;
  for (const d of ["DirectorNote", "DirectorSuggestion", "ContextUpdate"]) for (const k of Object.keys(defs[d]!.properties!)) assert.ok(t.includes(`"${k}"`), k);
  for (const k of ["context_update", "intent", "note", "no_note_reason", "label", "conf"]) assert.ok(t.includes(`"${k}"`), k);
  for (const m of C.SUGGESTION_MOVES) assert.ok(t.includes(`"${m}"`), m);
  assert.ok(t.length < 1400, "compact");
});

test("bh-ad/1 blinded main log: no arm, no tab-only fields; tab_visible never sealed", () => {
  const E = X.events;
  assert.ok(!valid(EV, null, { ...E.session_start_blinded_main, arm: "on" }).ok);
  assert.ok(!valid(EV, null, { ...E.session_start_blinded_main, p_inject: 0.5 }).ok);
  assert.ok(!valid(EV, null, { ...E.session_start_blinded_main, tab: "visible" }).ok);
  assert.ok(!valid(EV, null, { ...E.session_start_tab_visible, sealed: true }).ok);
  assert.ok(!valid(EV, null, { ...E.session_start_tab_visible, tab: "hidden" }).ok);
  assert.ok(!valid(EV, null, { ...E.actor_turn_blinded_main, note_id: "n5" }).ok);
  assert.ok(!valid(EV, null, { ...E.actor_turn_blinded_main, note_id: null }).ok);
  assert.ok(!valid(EV, null, { ...E.actor_turn_blinded_main, usage: { ...E.actor_turn.usage } }).ok, "prompt_tokens null when blinded");
  assert.ok(!valid(EV, null, { ...E.actor_turn, sealed: true }).ok);
  // the protocol-4 check_blinding key set never appears in a blinded main log
  const ARM_KEYS = /^(?:adaptation|study[_-]?mode|study[_-]?arm|arm|condition|assignment|schedule|order|seed|p_inject|decision|note_id|actor_request_sha256)$/i;
  const keys = (v: unknown, out: string[] = []): string[] => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); } return out; };
  for (const e of [E.session_start_blinded_main, E.actor_turn_blinded_main]) for (const k of keys(e)) assert.ok(!ARM_KEYS.test(k), k);
  for (const [k, v] of Object.entries(C.TAB_ONLY_FIELDS)) for (const f of v) assert.ok(!(f in (k === "session_start" ? E.session_start_blinded_main : E.actor_turn_blinded_main)));
});

test("bh-ad/1 event rules: envelope, unknown types, gaze_l1 rate cap, leaks unique, role cap health", () => {
  const E = X.events;
  assert.ok(!valid(EV, null, { ...E.session_end, type: "director_turn" }).ok, "unknown type");
  assert.ok(!valid(EV, null, { ...E.session_end, schema: "bh-ad/2" }).ok);
  assert.ok(!valid(EV, null, { ...E.session_end, t: "yesterday" }).ok);
  assert.ok(!valid(EV, null, { ...E.session_end, sessionId: "../x" }).ok, "Worker sessionId rule");
  assert.ok(!valid(EV, null, { ...E.session_end, extra: 1 }).ok);
  const f = E.gaze_l1.fixations[0]!;
  assert.ok(!valid(EV, null, { ...E.gaze_l1, fixations: Array.from({ length: 21 }, (_, i) => ({ ...f, id: "f" + i })) }).ok, "<= 20 fixations / batch (about 4 Hz)");
  assert.ok(!valid(EV, null, { ...E.gaze_l1, saccades: [{ ...E.gaze_l1.saccades[0]!, dir: "fwd" }] }).ok, "forward saccades are implied, not logged");
  assert.ok(!valid(EV, null, { ...E.note_outcome, leaks: ["sensor", "sensor"] }).ok);
  assert.ok(!valid(EV, null, { ...E.health, code: "budget.whatever" }).ok);
  assert.ok(!valid(EV, null, { ...E.health, role: "narrator" }).ok);
  assert.equal(E.health.code, C.WORKER_CAP_TO_HEALTH[E.health.worker_code]);
  assert.equal(C.ROLE_HEADER, "X-BH-Role");
});

test("context share example matches the spec's hand-worked turn (S 230, H 1420, U 60, D 41)", () => {
  const c = X.events.context_share;
  assert.equal(c.total, c.system + c.history + c.user + c.director);
  assert.equal(c.total, 1751);
  assert.equal(c.share, 41 / 1751);
  assert.equal(c.dynamic_share, 41 / (1420 + 60 + 41));
  assert.equal(c.share.toFixed(3), "0.023");
  assert.equal(c.dynamic_share.toFixed(3), "0.027");
});

test("upload envelope: Worker keys only; a 20-minute worst-case log at the gaze_l1 cap fits 1 MiB", () => {
  const W = "worker.schema.json";
  assert.ok(!valid(W, "AdUploadEnvelope", { ...X.uploadEnvelope, sessionType: "blinded" }).ok, "Worker rejects unknown fields");
  assert.ok(!valid(W, "AdUploadEnvelope", { ...X.uploadEnvelope, schema: "bh-ad/0" }).ok);
  for (const line of X.uploadEnvelope.jsonl.trim().split("\n")) assert.ok(valid(EV, null, JSON.parse(line)).ok);
  // 20 min = 240 gaze_l1 batches at the cap (20 fixations + 10 saccades + 10 gaps), plus 20 full turns of the other events
  const E = X.events;
  const fx = E.gaze_l1.fixations[0]!, sc = E.gaze_l1.saccades[0]!, gp = E.gaze_l1.gaps[0]!;
  const lines: unknown[] = [E.session_start_tab_visible];
  let seq = 1;
  for (let b = 0; b < 240; b++) lines.push({ ...E.gaze_l1, seq: seq++, fixations: Array.from({ length: 20 }, (_, i) => ({ ...fx, id: `f${b * 20 + i}` })), saccades: Array.from({ length: 10 }, () => sc), gaps: Array.from({ length: 10 }, () => gp) });
  for (let t = 0; t < 20; t++) for (const k of ["gaze_quality", "aoi_layout", "scroll", "aoi_dwell", "attention_digest", "user_turn", "director_call", "rail_check", "injection", "context_share", "actor_turn", "note_outcome"] as const) lines.push({ ...E[k], seq: seq++ });
  lines.push(E.session_share, E.session_end);
  const body = JSON.stringify({ ...X.uploadEnvelope, jsonl: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
  const bytes = Buffer.byteLength(body, "utf8");
  assert.ok(bytes < C.AD_UPLOAD_MAX_BYTES, `${bytes} bytes`);
  console.log(`# worst-case 20-min bh-ad/1 upload at the gaze_l1 cap: ${bytes} bytes (${((100 * bytes) / C.AD_UPLOAD_MAX_BYTES).toFixed(1)}% of 1 MiB)`);
});
