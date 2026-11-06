// Step 2 Mac pointer path: PointerCapture emission rules, session_start pointer fields, model_change, digests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/ad-contracts/index.ts";
import { PointerCapture, emptyModeDigest, isPointerTargetAoi, mergedDwellMs } from "../src/actor-director/pointer.ts";
import { renderDirectorInput, evidenceIdsIn, runRails } from "../src/actor-director/index.ts";
import { ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, loadO200k } from "../src/actor-director/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";

test("pointer: interactive-only; paragraph hover/dwell never emit p*", () => {
  const batches: unknown[] = [];
  const cap = new PointerCapture(C.DEFAULT_POINTER_CONFIG, { onBatch: (b) => batches.push(b) });
  cap.setInteractive([
    { aoi: "a3.c1", msg: "a3", excerpt: "Show the math" },
    { aoi: "a3.p2.s1", msg: "a3", excerpt: "autolyse first" },
  ]);
  assert.equal(isPointerTargetAoi("a3.p1", cap.interactiveSet()), false);
  assert.equal(isPointerTargetAoi("composer", new Set(["composer"])), false);
  assert.equal(cap.enter("a3.p1", 100), null, "paragraph enter: no hover");
  assert.equal(cap.enter("composer", 110), null);
  assert.equal(cap.click("a3.p1", 120), null);
  assert.equal(cap.takePending().length, 0);

  const h = cap.enter("a3.c1", 200);
  assert.ok(h && h.kind === "pointer_hover" && h.id === "p1" && !("x" in h));
  const click = cap.click("a3.c1", 250);
  assert.ok(click && click.kind === "pointer_click");
  const sel = cap.select("a3.p2.s1", 300);
  assert.ok(sel && sel.kind === "pointer_select" && sel.aoi === "a3.p2.s1");
});

test("pointer: dwell merges gaps ≤100ms and requires ≥500ms; brief pass is silent", () => {
  assert.equal(mergedDwellMs([[0, 200], [250, 600]], 100), 600);
  assert.equal(mergedDwellMs([[0, 200], [400, 600]], 100), 400); // gap 200 > 100: two spans

  const cap = new PointerCapture(C.DEFAULT_POINTER_CONFIG);
  cap.setInteractive([{ aoi: "a3.c1", msg: "a3", excerpt: "Show the math" }]);
  cap.enter("a3.c1", 0);
  cap.tick(200);
  cap.leave("a3.c1", 200);
  const brief = cap.closeWindow(200);
  assert.ok(!brief.pointer.some((p) => p.kind === "pointer_dwell"), "200ms < 500: no dwell");

  const cap2 = new PointerCapture(C.DEFAULT_POINTER_CONFIG);
  cap2.setInteractive([{ aoi: "a3.c1", msg: "a3", excerpt: "Show the math" }]);
  cap2.enter("a3.c1", 1000);
  cap2.tick(1300);
  cap2.leave("a3.c1", 1300);
  cap2.enter("a3.c1", 1380); // gap 80 ≤ 100: merge, no second hover
  cap2.tick(1600);
  const { pointer } = cap2.closeWindow(1600);
  const dwells = pointer.filter((p) => p.kind === "pointer_dwell");
  assert.equal(dwells.length, 1);
  assert.ok((dwells[0]!.dwell_ms as number) >= 500, JSON.stringify(dwells[0]));
  assert.equal(pointer.filter((p) => p.kind === "pointer_hover").length, 1, "merged resume: one hover");
});

test("pointer: closeWindow digest has input_mode+pointer; no gaze paras; paragraph never in pointer[]", () => {
  const cap = new PointerCapture();
  cap.setInteractive([{ aoi: "a1.c1", msg: "a1", excerpt: "Skip" }]);
  cap.enter("a1.c1", 10);
  cap.tick(600);
  const { pointer } = cap.closeWindow(620);
  assert.ok(pointer.some((p) => p.kind === "pointer_hover"));
  assert.ok(pointer.some((p) => p.kind === "pointer_dwell"));
  const dig = emptyModeDigest("a1", 610, "pointer", pointer);
  assert.equal(dig.input_mode, "pointer");
  assert.equal(dig.paras.length, 0);
  assert.equal(dig.events.length, 0);
  assert.equal(dig.lookBacks.length, 0);
  assert.ok(!pointer.some((p) => p.aoi === "a1.p1"));
  const none = emptyModeDigest("a1", 100, "none");
  assert.equal(none.input_mode, "none");
  assert.deepEqual(none.pointer, []);
});

test("pointer: Director input lists p* ids; rails accept p* in pointer mode and reject e*", () => {
  const dig = emptyModeDigest("a3", 5000, "pointer", [
    { id: "p5", kind: "pointer_dwell", aoi: "a3.c1", excerpt: "Show the math", dwell_ms: 880 },
    { id: "p6", kind: "pointer_select", aoi: "a3.p2.s1", excerpt: "autolyse first" },
  ]);
  const input = renderDirectorInput({
    chat: [{ id: "u3", role: "user", text: "ok" }, { id: "a3", role: "assistant", text: "Here is the math.\n\nMore." }],
    digest: dig, events: [], faceFrac: null, baselineParagraphs: 0,
    footprint: { actor_turns: 1, notes_injected: 0, notes_shadowed: 0, notes_blocked: 0, session_share: 0, session_dynamic_share: 0, recent: [] },
  });
  assert.match(input, /pointer/);
  assert.ok(evidenceIdsIn(input).has("p5") && evidenceIdsIn(input).has("p6"));
  assert.ok(!/DEEP|skim|skipped/.test(input));
  const note = { id: "n1", rationale: "r", observation: "The math control held them.", value: "v", evidence: ["p5", "a3.p1"], confidence: 0.6, expires_after_turns: 1 as const };
  const out = { context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "i", note, no_note_reason: null };
  assert.ok(!runRails(out, { input, previousActorTexts: [], directorEnabled: true, cameraConsent: false, leakBreakerTripped: false, inputMode: "pointer" }).blocked_by.includes("evidence_unknown"));
  assert.ok(runRails({ ...out, note: { ...note, evidence: ["e31"] } }, { input: input + " e31", previousActorTexts: [], directorEnabled: true, cameraConsent: false, leakBreakerTripped: false, inputMode: "pointer" }).blocked_by.includes("evidence_unknown"));
});


test("pointer: session_start writes input_mode, pointer_config, actor_model / director_model", async () => {
  const o200k = loadO200k();
  const storage = await AdStorage.open(new MemoryKV());
  const log = new AdSessionLog(storage, "s-mac-start", "tab_visible", new ManualClock());
  const mock = new MockAdBackend([], () => ({ text: "hi" }));
  const s = new ActorDirectorSession({
    log, userId: "u", sessionType: "tab_visible", arm: "on", actor: mock, director: mock, counter: o200k,
    consent: { camera: false, rawGaze: false }, inputMode: "pointer",
    models: { actor: C.DEFAULT_ACTOR_MODEL, director: C.DEFAULT_DIRECTOR_MODEL },
  });
  s.start();
  const ss = log.lines[0] as Extract<C.BhAdEvent, { type: "session_start" }>;
  assert.equal(ss.input_mode, "pointer");
  assert.deepEqual(ss.pointer_config, C.DEFAULT_POINTER_CONFIG);
  assert.equal(ss.actor_model, C.DEFAULT_ACTOR_MODEL);
  assert.equal(ss.director_model, C.DEFAULT_DIRECTOR_MODEL);
  assert.equal(ss.models.actor, ss.actor_model);
  assert.equal(ss.models.director, ss.director_model);
});

test("pointer: modelRefusal + changeModel emit model_change; non-cloud refused", async () => {
  const o200k = loadO200k();
  const storage = await AdStorage.open(new MemoryKV());
  const log = new AdSessionLog(storage, "s-mac-models", "tab_visible", new ManualClock());
  const mock = new MockAdBackend([], () => ({ text: "hi" }));
  const s = new ActorDirectorSession({
    log, userId: "u", sessionType: "tab_visible", arm: "on", actor: mock, director: mock, counter: o200k,
    consent: { camera: false, rawGaze: false }, inputMode: "pointer",
    models: { actor: C.DEFAULT_ACTOR_MODEL, director: C.DEFAULT_DIRECTOR_MODEL },
  });
  s.start();
  assert.ok(s.changeModel("actor", "llama3.2"));
  assert.equal(log.lines.filter((l) => l.type === "model_change").length, 0);
  assert.equal(s.changeModel("director", "gpt-oss:20b-cloud"), null);
  const mc = log.lines.find((l) => l.type === "model_change") as Extract<C.BhAdEvent, { type: "model_change" }>;
  assert.ok(mc);
  assert.equal(mc.role, "director");
  assert.equal(mc.from, C.DEFAULT_DIRECTOR_MODEL);
  assert.equal(mc.to, "gpt-oss:20b-cloud");
  assert.equal(s.models.director, "gpt-oss:20b-cloud");
  assert.equal(s.models.actor, C.DEFAULT_ACTOR_MODEL); // session continues
  // still one session_start
  assert.equal(log.lines.filter((l) => l.type === "session_start").length, 1);
});

test("pointer: director_format_id lists p* (format text updated)", async () => {
  assert.match(C.DIRECTOR_OUTPUT_FORMAT_TEXT, /"p<k>" \(pointer\)/);
  const { DIRECTOR_FORMAT_SLOT } = await import("../src/actor-director/director-prompt.ts");
  assert.match(DIRECTOR_FORMAT_SLOT.id, /^fmt1-[0-9a-f]{8}$/);
  assert.equal(DIRECTOR_FORMAT_SLOT.text, C.DIRECTOR_OUTPUT_FORMAT_TEXT);
});
