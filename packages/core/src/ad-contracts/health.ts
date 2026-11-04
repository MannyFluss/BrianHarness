/**
 * Root-cause health codes. Every failure shows in the Director tab's status line by code plus plain words
 * and is logged as { type: "health" }. A fallback always says it is a fallback.
 * Codes marked (spec) are from the design spec; the rest are Engineer additions (README, Engineer decisions).
 */
export const HEALTH_CODES = [
  "gaze.camera_denied", // (spec) camera.permission
  "gaze.arkit_unsupported", // (spec) arkit.supported
  "gaze.model_missing", // (spec) mediapipe.model_loaded (bundled, never fetched)
  "gaze.calibration_stale", // (spec) calibration age / error / head moved > 15 deg / distance > 25 %
  "gaze.thermal_degraded", // (spec) thermal: 15 Hz
  "gaze.tracker_interrupted", // ARSession interrupted / camera in use by another app / webcam lost
  "gaze.low_quality", // reading window quality < 0.6 or face present < 70 %: no gaze events this window
  "gaze.no_consent", // camera consent off: the pipeline runs on on-screen time only
  "net.worker_unreachable", // (spec) /v1/models (+ http_status)
  "auth.no_token", // (spec) device token missing (never prints the token)
  "model.route_unverified", // (spec) e.g. gemma4:cloud verified:false
  "model.empty_completion", // (spec)
  "model.length_cutoff", // (spec)
  "budget.director_cap", // (spec) Worker 429 role_cap_director (Director role, 100/device/day)
  "budget.actor_cap", // Worker 429 role_cap_actor
  "budget.judge_cap", // Worker 429 role_cap_judge
  "budget.daily_cap_device", // (spec) Worker 429, device cap
  "budget.daily_cap_global", // Worker 429 daily_cap_global
  "upload.too_large", // Worker 413 ad_log_too_large (body > 1 MiB)
  "upload.rejected", // Worker 400 invalid_ad_upload / invalid_jsonl / invalid_json, 422 upload_rejected (secret scan)
  "upload.cap", // Worker 429 upload_cap_device / upload_cap_global
  "upload.blinded_guard", // (v1.1) the client-side blinded guard refused the upload (detail = BlindedGuardCode); fail closed
  "director.schema_invalid", // (spec) JSON invalid after the one repair retry
  "director.timeout", // the Director's answer was not ready 1.5 s after Send: that turn went without a note
  "director.kill_switch", // directorEnabled:false locally or by the remote flag
  "director.leak_breaker", // 2 safety leaks this session: injection paused for the rest of the session
] as const;
export type HealthCode = (typeof HEALTH_CODES)[number];

export const HEALTH_CHECKS = [
  "camera.permission",
  "arkit.supported",
  "mediapipe.model_loaded",
  "calibration.valid",
  "thermal",
  "tracker.running",
  "gaze.window_quality",
  "consent.camera",
  "worker.reachable",
  "auth.device_token",
  "model.route",
  "upstream.reply_shape",
  "budget",
  "upload",
  "director.deadline",
  "director.enabled",
  "director.leak_breaker",
] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

/** Worker 429 code -> health code (role caps are X-BH-Role caps; see worker.ts) */
export const WORKER_CAP_TO_HEALTH = {
  role_cap_director: "budget.director_cap",
  role_cap_actor: "budget.actor_cap",
  role_cap_judge: "budget.judge_cap",
  daily_cap_device: "budget.daily_cap_device",
  daily_cap_global: "budget.daily_cap_global",
} as const satisfies Record<string, HealthCode>;
