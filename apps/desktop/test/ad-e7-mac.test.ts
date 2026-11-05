// E7 Mac gaze path: iris / head-pose features, the ridge calibration, and MediaPipeGazeTracker driven through the
// shared calibration screens with a fake worker + fake camera (no MediaPipe, no camera, no network in tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ScreenInfo } from "@brianharness/core/ad-contracts";
import { LM, extractFeatures, featureVector, fitRidge, headPose, modelFromNumbers, modelToNumbers, predict, type FrameFeatures, type Pt } from "../src/ad/mac/features.ts";
import { MediaPipeGazeTracker, type CameraLike, type MacBridge, type WorkerLike } from "../src/ad/mac/mediapipe-tracker.ts";
import { FACE_MODEL, VISION_WASM, type FromWorker, type ToWorker } from "../src/ad/mac/protocol.ts";
import { runCalibration } from "../src/ad/Calibration.tsx";

const MAC: ScreenInfo = { deviceModel: "Macarm64", platform: "mac", orientation: "landscape_left", widthPt: 1470, heightPt: 956, scale: 2, webview: { x: 0, y: 38, width: 1440, height: 900 }, widthMm: null };

function face(irisR: { x: number; y: number }, irisL: { x: number; y: number }, lidGap = 0.012): Pt[] {
  const lm: Pt[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  lm[LM.rOuter] = { x: 0.40, y: 0.45 }; lm[LM.rInner] = { x: 0.46, y: 0.45 };
  lm[LM.lInner] = { x: 0.54, y: 0.45 }; lm[LM.lOuter] = { x: 0.60, y: 0.45 };
  lm[LM.rUp] = { x: 0.43, y: 0.45 - lidGap / 2 }; lm[LM.rLow] = { x: 0.43, y: 0.45 + lidGap / 2 };
  lm[LM.lUp] = { x: 0.57, y: 0.45 - lidGap / 2 }; lm[LM.lLow] = { x: 0.57, y: 0.45 + lidGap / 2 };
  lm[LM.rIris] = { x: 0.43 + irisR.x, y: 0.45 + irisR.y }; lm[LM.lIris] = { x: 0.57 + irisL.x, y: 0.45 + irisL.y };
  return lm;
}
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -45, 1];

test("E7 mac features: iris offsets in eye widths, same sign for both eyes; blink from lids or blendshapes; head pose from the matrix", () => {
  const W = { width: 640, height: 480 };
  const c = extractFeatures(face({ x: 0, y: 0 }, { x: 0, y: 0 }), W, I4)!;
  assert.ok(Math.abs(c.rx) < 1e-9 && Math.abs(c.lx) < 1e-9);
  const right = extractFeatures(face({ x: 0.006, y: 0 }, { x: 0.006, y: 0 }), W, I4)!;
  assert.ok(right.rx > 0.09 && right.lx > 0.09 && Math.abs(right.rx - right.lx) < 1e-9, `rx ${right.rx} lx ${right.lx}`);
  const down = extractFeatures(face({ x: 0, y: 0.004 }, { x: 0, y: 0.004 }), W, I4)!;
  assert.ok(down.ry > 0 && down.ly > 0);
  assert.equal(c.blink, false);
  assert.equal(extractFeatures(face({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.001), W, I4)!.blink, true, "closed lids");
  assert.equal(extractFeatures(face({ x: 0, y: 0 }, { x: 0, y: 0 }), W, I4, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 })!.blink, true, "blendshapes win");
  assert.equal(extractFeatures(face({ x: 0, y: 0 }, { x: 0, y: 0 }), W, I4, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 })!.blink, false, "one eye is a wink");
  assert.deepEqual(headPose(I4), { yaw: -0, pitch: 0, roll: 0, distCm: 45 });
  const a = (20 * Math.PI) / 180; // rotation about y
  const Ry = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, -50, 1];
  assert.ok(Math.abs(headPose(Ry).yaw - 20) < 1e-9);
  assert.equal(extractFeatures([], W), null);
});

test("E7 mac ridge: recovers a linear map; numbers round-trip; garbage rejected", () => {
  let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const X: number[][] = [], tx: number[] = [], ty: number[] = [];
  for (let i = 0; i < 200; i++) { const v = Array.from({ length: 8 }, rnd); X.push(v); tx.push(700 + 900 * v[0]! + 300 * v[2]! - 50 * v[4]!); ty.push(450 + 600 * v[1]! + 200 * v[3]!); }
  const M = fitRidge(X, tx, ty, 1e-3)!;
  const p = predict(M, X[7]!);
  assert.ok(Math.abs(p.x - tx[7]!) < 1 && Math.abs(p.y - ty[7]!) < 1, JSON.stringify(p));
  const back = modelFromNumbers(modelToNumbers(M))!;
  assert.deepEqual(predict(back, X[3]!), predict(M, X[3]!));
  assert.equal(modelFromNumbers([2, 8]), null);
  assert.equal(modelFromNumbers([1, 8, 1, 2]), null);
  assert.equal(modelFromNumbers([...modelToNumbers(M).slice(0, -1), NaN]), null);
  assert.equal(fitRidge(X.slice(0, 5), tx.slice(0, 5), ty.slice(0, 5)), null, "too few samples");
});

/** a person whose iris offset is linear in where they look (+ small noise); the fake worker "detects" it */
function rig(o: { model?: "ok" | "bad_sha"; perm?: "granted" | "denied" | "prompt"; camera?: "ok" | "denied" } = {}) {
  let gaze = { x: 720, y: 450 };
  let s = 9; const n = () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 0.002; };
  const feats = (): FrameFeatures => {
    const gx = (gaze.x - 720) / 720, gy = (gaze.y - 450) / 450;
    return { rx: -0.1 * gx + n(), ry: 0.06 * gy + n(), lx: -0.1 * gx + n(), ly: 0.06 * gy + n(), yaw: 1 + n(), pitch: -2 + n(), roll: 0, distCm: 50, fx: n(), fy: n(), lidL: 0.1, lidR: 0.1, blink: false };
  };
  const sent: ToWorker[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    postMessage(m: ToWorker) {
      sent.push(m.type === "frame" ? { ...m, bitmap: null as never } : m);
      const reply = (r: FromWorker) => setTimeout(() => worker.onmessage?.({ data: r }), 1);
      if (m.type === "init") {
        reply({ type: "blocked", url: "https://odml.pa.googleapis.com/v1/log" });
        reply(o.model === "bad_sha" ? { type: "error", code: "gaze.model_missing", detail: "model sha256 mismatch (deadbeef)" } : { type: "ready", ms: 120, delegate: "GPU", modelBytes: FACE_MODEL.bytes, sha256: FACE_MODEL.sha256 });
      } else if (m.type === "frame") reply({ type: "result", t: m.t, f: feats(), ms: 6 });
    },
    terminate() {},
  };
  let opened = 0;
  const camera = async (): Promise<CameraLike> => {
    opened++;
    if (o.camera === "denied") throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    let on = true;
    return { width: 640, height: 480, next: () => new Promise((r) => setTimeout(() => r(on ? { t: performance.now(), bitmap: { close() {} } as unknown as ImageBitmap } : null), 8)), stop: () => { on = false; } };
  };
  let perm = o.perm ?? "granted";
  const h1: Record<string, unknown>[] = [];
  const bridge: MacBridge = { cameraPermission: async () => perm, requestCamera: async () => { perm = perm === "prompt" ? "granted" : perm; return perm; }, screen: async () => MAC, h1: (r) => h1.push(r) };
  const tracker = new MediaPipeGazeTracker({ bridge, createWorker: () => worker, openCamera: camera, base: "bh-app://app/gaze/" });
  return { tracker, sent, look: (x: number, y: number) => { gaze = { x, y }; }, opened: () => opened };
}

test("E7 mac tracker: runs through the shared calibration screens, fits natively before validation, then emits calibrated samples", async () => {
  const { tracker, sent, look } = rig();
  const st = await tracker.start({ mode: "camera", webNow: performance.now() });
  assert.equal(st.status.state, "running");
  assert.equal(st.status.tracker, "mediapipe");
  assert.equal(st.status.mode, "camera");
  assert.deepEqual(st.screen, MAC);
  const init = sent.find((m) => m.type === "init") as Extract<ToWorker, { type: "init" }>;
  assert.equal(init.base, "bh-app://app/gaze/");
  assert.equal(init.sha256, FACE_MODEL.sha256);
  try {
    const out = await runCalibration({ tracker, screen: MAC, paraHeightPx: 90, timing: { dotMs: 260, settleMs: 80, gapMs: 20 }, lookAt: (x, y) => look(x - MAC.webview.x, y - MAC.webview.y) });
    assert.equal(out.record.fit, "native");
    assert.ok(out.record.model && out.record.model.length === 2 + 8 * 2 + 9 * 2, "ridge model numbers");
    assert.ok(out.ok, out.words);
    assert.ok(out.record.errParas !== null && out.record.errParas < 0.5, `validation error ${out.record.errParas} paragraphs`);
    assert.equal(out.recommend, "use");
    // after calibration: cal:true samples near where the person looks (web CSS px)
    look(300, 200);
    const got: Array<{ x: number | null; y: number | null; cal: boolean; src: string }> = [];
    const sub = await tracker.addListener("gaze", (e) => got.push(...e.samples));
    await new Promise((r) => setTimeout(r, 250));
    tracker.flushNow();
    await sub.remove();
    const late = got.slice(-5);
    assert.ok(late.length >= 3);
    for (const g of late) { assert.equal(g.cal, true); assert.equal(g.src, "mediapipe"); assert.ok(Math.abs(g.x! - 300) < 40 && Math.abs(g.y! - 200) < 40, JSON.stringify(g)); }
    // restoreCalibration accepts its own numbers, rejects others
    assert.deepEqual(await tracker.restoreCalibration({ orientation: "landscape_left", model: out.record.model! }), { ok: true });
    assert.deepEqual(await tracker.restoreCalibration({ orientation: "landscape_left", model: [1, 2, 3] }), { ok: false });
    const stats = tracker.getStats();
    assert.ok(stats.frames > 20 && stats.faces === stats.frames);
    assert.equal(stats.delegate, "GPU");
    assert.equal(stats.modelSha256, FACE_MODEL.sha256);
    assert.deepEqual(stats.blocked, ["https://odml.pa.googleapis.com/v1/log"], "the worker's refused fetches are reported");
    assert.equal(await tracker.syncClock({ webNow: 0 }).then((d) => d.driftMs), 0);
  } finally { await tracker.stop(); }
  assert.equal((await tracker.getStatus()).state, "stopped");
});

test("E7 mac tracker: root-cause codes: model sha mismatch, macOS camera denied, getUserMedia NotAllowedError", async () => {
  const bad = rig({ model: "bad_sha" });
  const a = await bad.tracker.start({ mode: "camera", webNow: 0 });
  assert.deepEqual([a.status.state, a.status.code, a.status.supported, a.status.unsupportedCode], ["error", "gaze.model_missing", false, "gaze.model_missing"]);
  assert.match(bad.tracker.getStats().errors[0]!, /sha256 mismatch/);
  assert.equal(bad.opened(), 0, "no camera without a model");
  const denied = rig({ perm: "denied" });
  const b = await denied.tracker.start({ mode: "camera", webNow: 0 });
  assert.deepEqual([b.status.state, b.status.code, b.status.permission], ["error", "gaze.camera_denied", "denied"]);
  assert.equal(denied.sent.length, 0, "no model load without camera permission");
  const prompt = rig({ perm: "prompt" });
  const c = await prompt.tracker.start({ mode: "camera", webNow: 0 });
  assert.equal(c.status.permission, "granted", "prompt -> asked -> granted");
  await prompt.tracker.stop();
  const gum = rig({ camera: "denied" });
  const d = await gum.tracker.start({ mode: "camera", webNow: 0 });
  assert.deepEqual([d.status.state, d.status.code, d.status.permission], ["error", "gaze.camera_denied", "denied"]);
  await assert.rejects(rig().tracker.start({ mode: "synthetic", webNow: 0 }), /camera mode only/);
});

test("E7 mac tracker: uncalibrated samples are a rough cal:false screen-pt guess; pause stops samples", async () => {
  const { tracker, look } = rig();
  await tracker.start({ mode: "camera", webNow: 0 });
  try {
    look(720, 450);
    const got: Array<{ x: number | null; y: number | null; cal: boolean }> = [];
    await tracker.addListener("gaze", (e) => got.push(...e.samples));
    await new Promise((r) => setTimeout(r, 120)); tracker.flushNow();
    assert.ok(got.length > 3);
    assert.ok(got.every((g) => g.cal === false));
    const g = got[got.length - 1]!;
    assert.ok(Math.abs(g.x! - (720 + MAC.webview.x)) < 80 && Math.abs(g.y! - (450 + MAC.webview.y)) < 80, `centre guess ${g.x},${g.y}`);
    await tracker.pause();
    assert.equal((await tracker.getStatus()).pauseReason, "user");
    got.length = 0;
    await new Promise((r) => setTimeout(r, 80)); tracker.flushNow();
    assert.equal(got.length, 0);
    await tracker.resume();
    assert.equal((await tracker.getStatus()).state, "running");
  } finally { await tracker.stop(); }
});

test("E7 mac bundle: pins match the staged assets when present (scripts/ad-gaze-assets.mjs) and the installed tasks-vision", () => {
  const dir = join(import.meta.dirname, "..", "resources", "gaze");
  const pkg = join(import.meta.dirname, "..", "..", "..", "node_modules", "@mediapipe", "tasks-vision");
  assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, VISION_WASM.version);
  assert.ok(existsSync(join(pkg, "wasm", VISION_WASM.binary)));
  if (!existsSync(join(dir, FACE_MODEL.file))) return; // not staged on this checkout
  const b = readFileSync(join(dir, FACE_MODEL.file));
  assert.equal(b.length, FACE_MODEL.bytes);
  assert.equal(createHash("sha256").update(b).digest("hex"), FACE_MODEL.sha256);
});

test("E7 mac worker: refuses every fetch outside the bundle and has no LLM / provider import", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "ad", "mac", "gaze.worker.ts"), "utf8");
  assert.match(src, /if \(!abs\.startsWith\(base\)\)/);
  assert.match(src, /modelAssetBuffer/, "model from the verified buffer, not modelAssetPath");
  assert.doesNotMatch(src, /modelAssetPath|https?:\/\/(?!odml)/);
  const shell = readFileSync(join(import.meta.dirname, "..", "electron", "ad-main.mjs"), "utf8");
  assert.doesNotMatch(shell, /@brianharness\/core|ProviderHub|createBackend/, "the Director Mac shell loads no model provider");
  assert.match(shell, /cb\(\{ cancel: true \}\)/);
});
