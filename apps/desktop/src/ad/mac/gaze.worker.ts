/// <reference lib="webworker" />
/**
 * E7 Mac gaze path: MediaPipe FaceLandmarker in a module Web Worker. Model + wasm come from the app bundle
 * (GAZE_BASE, same origin); the model's sha256 is checked before use. No LLM, no network: every fetch that is not
 * under the bundle base is refused here and reported ("blocked"), which also covers tasks-vision's built-in
 * telemetry POST to odml.pa.googleapis.com (1.2.2 has no opt-out). The Electron shell blocks and logs at the
 * session level too, and the CSP is connect-src 'self'.
 */
import { FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { extractFeatures } from "./features";
import { FACE_MODEL, VISION_WASM, type FromWorker, type ToWorker } from "./protocol";

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
let lm: FaceLandmarker | null = null;
let lastTs = 0;

function guardFetch(base: string) {
  const real = self.fetch.bind(self);
  self.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const abs = new URL(url, base).href;
    if (!abs.startsWith(base)) { post({ type: "blocked", url: new URL(abs).origin + new URL(abs).pathname }); throw new TypeError("network disabled in the gaze worker"); }
    return real(input, init);
  }) as typeof fetch;
  // XHR is not used by tasks-vision 1.2.2; refuse it anyway
  (self as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest = undefined;
}

async function hex(buf: ArrayBuffer) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function init(m: Extract<ToWorker, { type: "init" }>) {
  const t0 = performance.now();
  const base = new URL(m.base, self.location.href).href;
  guardFetch(base);
  let model: ArrayBuffer;
  try {
    const r = await fetch(base + FACE_MODEL.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    model = await r.arrayBuffer();
  } catch (e) { post({ type: "error", code: "gaze.model_missing", detail: `model not in the bundle: ${(e as Error).message}` }); return; }
  const sha = await hex(model);
  if (sha !== (m.sha256 ?? FACE_MODEL.sha256)) { post({ type: "error", code: "gaze.model_missing", detail: `model sha256 mismatch (${sha.slice(0, 12)})` }); return; }
  const fileset = { wasmLoaderPath: base + VISION_WASM.loader, wasmBinaryPath: base + VISION_WASM.binary };
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
    runningMode: "VIDEO" as const, numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let delegate: "GPU" | "CPU" = m.delegate ?? "GPU";
  try { lm = await FaceLandmarker.createFromOptions(fileset, opts(delegate)); }
  catch (e) {
    if (delegate === "GPU") { delegate = "CPU"; try { lm = await FaceLandmarker.createFromOptions(fileset, opts("CPU")); } catch (e2) { post({ type: "error", code: "gaze.model_missing", detail: `FaceLandmarker failed to load: ${(e2 as Error).message}` }); return; } }
    else { post({ type: "error", code: "gaze.model_missing", detail: `FaceLandmarker failed to load: ${(e as Error).message}` }); return; }
  }
  post({ type: "ready", ms: Math.round(performance.now() - t0), delegate, modelBytes: model.byteLength, sha256: sha });
}

function frame(m: Extract<ToWorker, { type: "frame" }>) {
  if (!lm) { m.bitmap.close(); return; }
  const t0 = performance.now();
  let res: FaceLandmarkerResult;
  try {
    const ts = Math.max(lastTs + 1, Math.round(m.t));
    lastTs = ts;
    res = lm.detectForVideo(m.bitmap, ts);
  } catch (e) { m.bitmap.close(); post({ type: "error", code: "gaze.tracker_interrupted", detail: `detect failed: ${(e as Error).message}` }); return; }
  m.bitmap.close();
  const pts = res.faceLandmarks?.[0];
  const mat = res.facialTransformationMatrixes?.[0]?.data;
  const bs = res.faceBlendshapes?.[0]?.categories;
  const blend = bs ? { eyeBlinkLeft: bs.find((c) => c.categoryName === "eyeBlinkLeft")?.score, eyeBlinkRight: bs.find((c) => c.categoryName === "eyeBlinkRight")?.score } : null;
  const f = pts ? extractFeatures(pts, { width: m.width, height: m.height }, mat ?? null, blend && blend.eyeBlinkLeft !== undefined && blend.eyeBlinkRight !== undefined ? blend : null) : null;
  post({ type: "result", t: m.t, f, ms: performance.now() - t0 });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "init") void init(m);
  else if (m.type === "frame") frame(m);
  else if (m.type === "close") { lm?.close(); lm = null; }
};
