/**
 * E7 Mac gaze path: renderer <-> Web Worker messages, and the bundled asset pins.
 * Frames go in as transferred ImageBitmaps and are closed in the worker; only numbers come back.
 */
import type { FrameFeatures } from "./features";

/** face_landmarker.task (float16, v1), MediaPipe model card "Face Landmarker"; bundled, verified before use */
export const FACE_MODEL = { file: "face_landmarker.task", bytes: 3758596, sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff" } as const;
/** @mediapipe/tasks-vision 1.2.2 wasm, ES-module build (sets globalThis.ModuleFactory; a module worker has no importScripts, so the loader is import()ed) */
export const VISION_WASM = { loader: "vision_wasm_module_internal.js", binary: "vision_wasm_module_internal.wasm", version: "1.2.2" } as const;
/** where the app serves the bundle (Electron: bh-app://app/gaze/, vite dev: /gaze/), relative to the document */
export const GAZE_BASE = "./gaze/";

export type ToWorker =
  | { type: "init"; base: string; delegate?: "GPU" | "CPU"; sha256?: string }
  | { type: "frame"; t: number; bitmap: ImageBitmap; width: number; height: number }
  | { type: "close" };
export type FromWorker =
  | { type: "ready"; ms: number; delegate: "GPU" | "CPU"; modelBytes: number; sha256: string }
  | { type: "error"; code: "gaze.model_missing" | "gaze.tracker_interrupted"; detail: string }
  | { type: "result"; t: number; f: FrameFeatures | null; ms: number }
  /** a fetch the worker refused: anything not under the bundle base (MediaPipe's built-in telemetry POST, a CDN) */
  | { type: "blocked"; url: string };
