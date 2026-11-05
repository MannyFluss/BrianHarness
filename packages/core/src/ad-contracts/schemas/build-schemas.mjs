#!/usr/bin/env node
// Source of the contract-v1 JSON Schemas (draft-07). `node build-schemas.mjs` rewrites the *.schema.json files
// next to it; the contracts test fails if the committed files differ from this output.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://brianharness.app/contracts/v1/";
const num = (min, max) => ({ type: "number", ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) });
const int = (min = 0, max) => ({ type: "integer", minimum: min, ...(max !== undefined ? { maximum: max } : {}) });
const str = (minLength = 0, maxLength, extra = {}) => ({ type: "string", minLength, ...(maxLength ? { maxLength } : {}), ...extra });
const nul = (s) => ({ anyOf: [s, { type: "null" }] });
const en = (...values) => ({ type: "string", enum: values });
const arr = (items, min = 0, max) => ({ type: "array", items, minItems: min, ...(max !== undefined ? { maxItems: max } : {}) });
/** closed object: all listed props, `opt` ones optional */
const obj = (props, opt = []) => ({ type: "object", additionalProperties: false, required: Object.keys(props).filter((k) => !opt.includes(k)), properties: props });
const numMap = { type: "object", additionalProperties: { type: "number" } };
const COORD = 100000;

// ---------- gaze-sample ----------
const headPose = obj({ yaw: num(-180, 180), pitch: num(-180, 180), roll: num(-180, 180), distCm: num(0, 500) });
const GAZE_SRC = ["arkit", "mediapipe", "synthetic", "replay"];
const gazeSample = {
  ...obj({
    t: num(0),
    x: nul(num(-COORD, COORD)),
    y: nul(num(-COORD, COORD)),
    conf: num(0, 1),
    face: { type: "boolean" },
    blink: { type: "boolean" },
    lids: obj({ l: num(0, 1), r: num(0, 1) }),
    head: headPose,
    cal: { type: "boolean" },
    src: en(...GAZE_SRC),
  }, ["lids", "head"]),
  allOf: [
    // no estimate <=> x and y both null, and then conf is 0
    { if: { properties: { x: { type: "null" } } }, then: { properties: { y: { type: "null" }, conf: { const: 0 } } } },
    { if: { properties: { y: { type: "null" } } }, then: { properties: { x: { type: "null" } } } },
    // head pose only with a face
    { if: { properties: { face: { const: false } } }, then: { not: { required: ["head"] } } },
  ],
};
const gazeSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: BASE + "gaze-sample.schema.json",
  title: "GazeSample (contract-v1)",
  definitions: { GazeSample: gazeSample, HeadPose: headPose, GazeHz: { enum: [30, 15] } },
  $ref: "#/definitions/GazeSample",
};
const G = (d) => ({ $ref: BASE + "gaze-sample.schema.json#/definitions/" + d });

// ---------- gaze-plugin ----------
const HEALTH_CODES = ["gaze.camera_denied", "gaze.arkit_unsupported", "gaze.model_missing", "gaze.calibration_stale", "gaze.thermal_degraded", "gaze.tracker_interrupted", "gaze.low_quality", "gaze.no_consent", "net.worker_unreachable", "net.worker_blocked", "net.request_escaped", "auth.no_token", "model.route_unverified", "model.empty_completion", "model.length_cutoff", "budget.director_cap", "budget.actor_cap", "budget.judge_cap", "budget.daily_cap_device", "budget.daily_cap_global", "upload.too_large", "upload.rejected", "upload.cap", "upload.blinded_guard", "director.schema_invalid", "director.timeout", "director.kill_switch", "director.leak_breaker"];
const HEALTH_CHECKS = ["camera.permission", "arkit.supported", "mediapipe.model_loaded", "calibration.valid", "thermal", "tracker.running", "gaze.window_quality", "consent.camera", "worker.reachable", "auth.device_token", "model.route", "upstream.reply_shape", "budget", "upload", "director.deadline", "director.enabled", "director.leak_breaker", "network.isolation"];
const healthCode = en(...HEALTH_CODES);
const orientation = en("portrait", "portrait_upside_down", "landscape_left", "landscape_right");
const permission = en("prompt", "granted", "denied", "restricted");
const screenInfo = obj({
  deviceModel: str(1, 64), platform: en("ios", "mac", "web"), orientation,
  widthPt: num(1, COORD), heightPt: num(1, COORD), scale: num(0.5, 8),
  webview: obj({ x: num(-COORD, COORD), y: num(-COORD, COORD), width: num(0, COORD), height: num(0, COORD) }),
  widthMm: nul(num(1, 2000)),
});
const status = obj({
  supported: { type: "boolean" }, unsupportedCode: nul(healthCode), permission,
  state: en("idle", "starting", "running", "calibrating", "paused", "stopped", "error"),
  pauseReason: nul(en("background", "user", "interrupted", "permission_revoked")),
  tracker: nul(en("arkit", "mediapipe")), mode: nul(en("camera", "synthetic")), hz: nul(G("GazeHz")), code: nul(healthCode),
  orientation, // v1.4, optional: native-pushed interface orientation
}, ["orientation"]);
const synthetic = { ...obj({ file: str(1, 512, { pattern: "^(?!/)(?!.*\\.\\.)[A-Za-z0-9._/-]+\\.json$" }), samples: arr(G("GazeSample"), 1), loop: { type: "boolean" }, speed: num(0.1, 16) }, ["file", "samples", "loop", "speed"]),
  oneOf: [{ required: ["file"] }, { required: ["samples"] }] };
const startOptions = { ...obj({ mode: en("camera", "synthetic"), synthetic, webNow: num(0), maxHz: G("GazeHz") }, ["synthetic", "maxHz"]),
  if: { properties: { mode: { const: "synthetic" } } }, then: { required: ["synthetic"] }, else: { not: { required: ["synthetic"] } } };
const target = obj({ id: str(1, 16), x: num(-COORD, COORD), y: num(-COORD, COORD) });
const calibrateOptions = { oneOf: [
  obj({ phase: { const: "begin" }, orientation, targets: arr(target, 1, 32) }),
  obj({ phase: { const: "target" }, targetId: str(1, 16), t0: num(0), t1: num(0) }),
  obj({ phase: { const: "end" } }),
  obj({ phase: { const: "cancel" } }),
] };
const calibrateResult = obj({ phase: en("begin", "target", "end", "cancel"), ok: { type: "boolean" }, fit: nul(en("core", "native")), model: nul(arr({ type: "number" }, 0, 4096)), samples: int(0), code: nul(healthCode) });
const batch = obj({ seq: int(0), hz: G("GazeHz"), samples: arr(G("GazeSample"), 0, 64) });
const replayFile = obj({ schema: { const: "bh-gaze-replay/1" }, layout: str(1, 64), src: en("synthetic", "replay"), hz: G("GazeHz"), screen: { $ref: "#/definitions/ScreenInfo" }, samples: arr(G("GazeSample"), 1) });
const pluginSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: BASE + "gaze-plugin.schema.json",
  title: "Gaze plugin API payloads (contract-v1): every method argument, result and event. Numbers only, never images.",
  definitions: {
    CameraPermission: permission, Orientation: orientation, HealthCode: healthCode, ScreenInfo: screenInfo, GazeStatus: status,
    SyntheticSource: synthetic, StartOptions: startOptions, StartResult: obj({ status: { $ref: "#/definitions/GazeStatus" }, screen: { $ref: "#/definitions/ScreenInfo" } }),
    /** v1.0.1 patch: getStatus() resolves to GazeStatus itself (the TS was right; stop/pause/resume keep {status}) */
    StatusResult: { $ref: "#/definitions/GazeStatus" },
    StopPauseResumeResult: obj({ status: { $ref: "#/definitions/GazeStatus" } }),
    PermissionResult: obj({ permission }),
    CalibrateOptions: calibrateOptions, CalibrateResult: calibrateResult,
    RestoreCalibrationOptions: obj({ orientation, model: arr({ type: "number" }, 1, 4096) }), OkResult: obj({ ok: { type: "boolean" } }),
    SyncClockOptions: obj({ webNow: num(0) }), SyncClockResult: obj({ driftMs: { type: "number" } }),
    /** v1.4: lookAt({x, y}) (simulator / synthetic only) */
    LookAtOptions: obj({ x: num(-COORD, COORD), y: num(-COORD, COORD) }),
    GazeBatchEvent: batch, GazeStatusEvent: { $ref: "#/definitions/GazeStatus" }, GazeReplayFile: replayFile,
  },
};
const P = (d) => ({ $ref: BASE + "gaze-plugin.schema.json#/definitions/" + d });

// ---------- note ----------
const EVID = "^(?:e[0-9]+|p[0-9]+|u[0-9]+|a[0-9]+(?:\\.p[0-9]+(?:\\.s[0-9]+)?)?)$"; // v1.5: p<k> pointer evidence
const evidenceId = str(2, 24, { pattern: EVID });
const MOVES = ["go_deeper", "broaden", "return_to", "clarify", "simplify", "give_example", "check_in", "slow_down", "other"];
const suggestion = obj({ move: en(...MOVES), target: str(1, 160), text: str(1, 280) }, ["target"]);
const note = { ...obj({
  id: str(2, 12, { pattern: "^n[0-9]+$" }), rationale: str(1, 800), observation: str(1, 400), suggestion,
  value: str(1, 500), evidence: arr(evidenceId, 1, 24), confidence: num(0, 1), expires_after_turns: { const: 1 },
}, ["observation", "suggestion"]), anyOf: [{ required: ["observation"] }, { required: ["suggestion"] }] };
// limits follow the Researcher's R3 draft (director_output.schema.json) where it sets one
const contextUpdate = obj({ summary: str(1, 400), hypotheses: arr(obj({ label: str(1, 60), conf: num(0, 1), evidence: arr(evidenceId, 0, 24) }), 0, 5), changed: arr(str(1, 200), 0, 8) });
const directorOutput = { oneOf: [
  obj({ context_update: { $ref: "#/definitions/ContextUpdate" }, intent: str(1, 240), note: { $ref: "#/definitions/DirectorNote" }, no_note_reason: { type: "null" } }),
  obj({ context_update: { $ref: "#/definitions/ContextUpdate" }, intent: str(1, 240), note: { type: "null" }, no_note_reason: str(1, 400) }),
] };
const RAILS = ["kill_switch", "consent", "data_validity", "evidence_missing", "evidence_unknown", "schema_invalid", "lint_sensor", "lint_provenance", "lint_answer_first", "length_cap", "duplicate", "leak_breaker"];
const LEAKS = ["sensor", "provenance", "mind_reading", "pivot_first", "verbatim", "forced_move"];
const noteSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: BASE + "note.schema.json",
  title: "Director output and note (contract-v1)",
  definitions: {
    EvidenceId: evidenceId, SuggestionMove: en(...MOVES), DirectorSuggestion: suggestion, DirectorNote: note, ContextUpdate: contextUpdate,
    DirectorOutput: directorOutput, NoteKind: en("observation", "suggestion", "both"), RailCode: en(...RAILS), LeakCode: en(...LEAKS),
  },
  $ref: "#/definitions/DirectorOutput",
};
const N = (d) => ({ $ref: BASE + "note.schema.json#/definitions/" + d });

// ---------- worker ----------
const ROLES = ["actor", "director", "judge"];
const WCODES = ["invalid_role", "role_cap_actor", "role_cap_director", "role_cap_judge", "daily_cap_device", "daily_cap_global", "ad_log_too_large", "invalid_json", "invalid_ad_upload", "invalid_jsonl", "upload_rejected", "session_exists", "upload_cap_device", "upload_cap_global", "blinded_guard"];
const workerSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: BASE + "worker.schema.json",
  title: "Worker contract (contract-v1, adopted from Worker branch actor-director @ 9bc90f1)",
  definitions: {
    Role: en(...ROLES),
    WorkerErrorCode: en(...WCODES),
    AdUploadEnvelope: { ...obj({
      schema: { const: "bh-ad/1" }, sessionId: str(1, 128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }), appVersion: str(1, 64, { pattern: "^[^\\u0000-\\u001f]+$" }),
      platform: str(1, 32, { pattern: "^[^\\u0000-\\u001f]+$" }), build: { anyOf: [str(1, 64), { type: "number" }, { type: "null" }] }, jsonl: { type: "string" },
    }, ["build"]), description: "POST /v1/ad-sessions body; whole body <= 1048576 bytes (413 ad_log_too_large)" },
    AdUploadOk: obj({ id: str(1, 128), kind: { const: "ad_session" }, schema: { const: "bh-ad/1" }, received_at: str(1, 40), bytes: int(0), lines: int(0), sha256: str(64, 64) }),
    WorkerErrorBody: obj({ error: { type: "object", required: ["message", "type", "code"], properties: {
      message: { type: "string" }, type: { type: "string" }, code: { type: "string" }, limit: int(0), used: int(0), reset_at: { type: "string" },
      role: en(...ROLES), scope: en("role", "device", "global"), field: { type: "string" }, line: int(0), reason: { type: "string" }, permanent: { type: "boolean" },
    }, additionalProperties: true } }),
    RoleCapError: obj({ error: { type: "object", required: ["message", "type", "code", "role", "scope", "limit", "used", "reset_at"], properties: {
      message: { type: "string" }, type: { const: "rate_limit_error" }, code: en("role_cap_actor", "role_cap_director", "role_cap_judge"), limit: int(0), used: int(0), reset_at: { type: "string" },
      role: en(...ROLES), scope: { const: "role" },
    }, additionalProperties: false } }),
  },
};
const W = (d) => ({ $ref: BASE + "worker.schema.json#/definitions/" + d });

// ---------- bh-ad/1 events ----------
const env = { schema: { const: "bh-ad/1" }, t: str(20, 40, { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$" }), mono: num(0), sessionId: str(1, 128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }), seq: int(0) };
const ev = (type, props, opt = []) => obj({ ...env, type: { const: type }, ...props }, opt);
const turn = int(0);
const msgId = str(2, 12, { pattern: "^a[0-9]+$" });
const share01 = num(0, 1);
const tok = int(0);
const sha = str(64, 64, { pattern: "^[0-9a-f]{64}$" });
const usage = obj({ prompt_tokens: nul(int(0)), completion_tokens: nul(int(0)), reasoning_tokens: nul(int(0)) });
const fixation = obj({ id: str(1, 16), t0: num(0), t1: num(0), x: num(-COORD, COORD), y: num(-COORD, COORD), dispPx: num(0), n: int(1) });
const saccade = obj({ t0: num(0), t1: num(0), from: str(1, 16), to: str(1, 16), dir: en("fwd", "back", "jump"), ampDeg: num(0) });
const gap = obj({ t0: num(0), t1: num(0), kind: en("blink", "offscreen", "noface", "lowconf") });
const aoi = str(1, 32);
const aoiBox = obj({ aoi, words: int(0), x: num(-COORD, COORD), y: num(-COORD, COORD * 100), w: num(0, COORD), h: num(0, COORD * 100),
  interactive: { type: "boolean", description: "v1.5: a control that may be a pointer target; absent = text (never a hover/dwell target)" } }, ["interactive"]);
const aoiDwell = obj({ aoi, words: int(0), visibleMs: num(0), gazeMs: num(0), msPerWordZ: nul({ type: "number" }), fixations: int(0), reentries: int(0), regressionsIn: int(0), firstFixLatencyMs: nul(num(0)), coverage: num(0, 1), conf: num(0, 1) });
const excerpt = str(0, 80);
const attEvent = obj({ id: str(2, 12, { pattern: "^e[0-9]+$" }), kind: en("deep_read", "reread", "skip", "look_back", "fast_scan", "offscreen", "composer_hesitation", "eeg_spike"), aoi, excerpt, t0: num(0), t1: num(0), z: nul({ type: "number" }), conf: num(0, 1), features: numMap });
// v1.5: input modes and pointer evidence (input-mode.ts)
const INPUT_MODES = ["pointer", "gaze", "none"];
const POINTER_KINDS = ["pointer_click", "pointer_select", "pointer_hover", "pointer_dwell"];
const pointerId = str(2, 12, { pattern: "^p[0-9]+$" });
/** dwell_ms only (and always) on pointer_dwell */
const dwellRule = { if: { properties: { kind: { const: "pointer_dwell" } } }, then: { required: ["dwell_ms"] }, else: { not: { required: ["dwell_ms"] } } };
const pointerEvent = { ...obj({ id: pointerId, kind: en(...POINTER_KINDS), aoi, msg: msgId, t0: num(0), t1: num(0), dwell_ms: num(0) }, ["dwell_ms"]), ...dwellRule };
const pointerDigestItem = { ...obj({ id: pointerId, kind: en(...POINTER_KINDS), aoi, excerpt, dwell_ms: num(0) }, ["dwell_ms"]), ...dwellRule };
const pointerConfig = obj({ id: str(1, 32, { pattern: "^pc1-d[0-9]+-g[0-9]+$" }), dwell_ms: num(1, 60000), merge_gap_ms: num(0, 5000) });
const digest = obj({
  msg: msgId, windowMs: num(0), quality: num(0, 1), qualityLabel: en("good", "fair", "poor"),
  paras: arr({ ...obj({ aoi, excerpt, label: en("deep", "read", "skim", "skipped"), ratio: num(0), ev: arr(str(1, 12), 0, 12) }, ["ev"]) }),
  lookBacks: arr(obj({ aoi, excerpt, ms: num(0), ev: str(1, 12) })), offscreenMs: num(0), composerPauses: int(0), events: arr(str(1, 12), 0, 12),
  input_mode: { ...en(...INPUT_MODES), description: "v1.5: the session's input mode (the digest's sources); absent = gaze" },
  pointer: { ...arr(pointerDigestItem, 0, 24), description: "v1.5, mode pointer only: interactive-AOI pointer evidence" },
}, ["input_mode", "pointer"]);
const footprint = obj({
  actor_turns: int(0), notes_injected: int(0), notes_shadowed: int(0), notes_blocked: int(0), session_share: share01, session_dynamic_share: share01,
  recent: arr(obj({ note_id: str(2, 12), turn, kind: N("NoteKind"), move: nul(N("SuggestionMove")), decision: en("inject", "shadow", "blocked"), followed: nul({ type: "boolean" }), next_dwell_ratio: nul(num(0)) }), 0, 3),
});
const sessionStart = {
  ...ev("session_start", {
    profile: { const: "actor-director" }, contract: en("contract-v1", "contract-v1.1", "contract-v1.2", "contract-v1.3", "contract-v1.4", "contract-v1.5"), userId: str(1, 128),
    session_type: { ...en("blinded", "tab_visible"), description: "SESSION TYPE. Fixed at session start by the schedule. blinded => tab hidden, main log redacted (see TAB-ONLY fields)" },
    tab: { ...en("visible", "hidden"), description: "must agree with session_type: blinded=hidden, tab_visible=visible" },
    arm: { ...en("on", "shadow", "off"), description: "TAB-ONLY: tab_visible sessions and the sealed log of a blinded session; NEVER in a blinded main log" },
    p_inject: { ...share01, description: "TAB-ONLY (same rule as arm)" },
    sealed: { const: true }, blind: obj({ index: int(1), total: int(1), scheduleHash: sha }),
    actor_prompt_id: str(1, 32, { pattern: "^ap[0-9]+-[0-9a-f]{8}$" }), director_prompt_id: str(1, 32, { pattern: "^dir[0-9]+-[0-9a-f]{8}$" }),
    director_format_id: { ...str(1, 32, { pattern: "^fmt[0-9]+-[0-9a-f]{8}$" }), description: "v1.1: id of the output-format slot (DIRECTOR_OUTPUT_FORMAT_TEXT)" },
    director_examples_id: { ...str(1, 32, { pattern: "^dex[0-9]+-[0-9a-f]{8}$" }), description: "v1.1: id of the in-context examples slot" },
    director_assembled_sha8: { ...str(8, 8, { pattern: "^[0-9a-f]{8}$" }), description: "v1.1: sha256[:8] of the final assembled Director system message" },
    pipeline_version: str(1, 32), tokenizer: { const: "o200k_base" }, models: { ...obj({ actor: str(1, 128), director: str(1, 128) }), description: "models at session start; v1.5: equal to actor_model / director_model" },
    actor_model: { ...str(1, 128), description: "v1.5: full Actor model tag at session start (canonical); changes are model_change lines" },
    director_model: { ...str(1, 128), description: "v1.5: full Director model tag at session start (canonical); changes are model_change lines" },
    input_mode: { ...en(...INPUT_MODES), description: "v1.5: fixed for the session (a change = a new session); absent in v1-v1.4 = gaze" },
    pointer_config: { ...pointerConfig, description: "v1.5, input_mode pointer only: dwell threshold and gap merge in force" },
    consent: obj({ camera: { type: "boolean" }, rawGaze: { type: "boolean" } }),
    gaze: obj({ tracker: en(...GAZE_SRC, "none"), permission: P("CameraPermission") }),
    device: obj({ deviceModel: str(1, 64), platform: en("ios", "mac", "web"), orientation: P("Orientation"), widthPt: num(1, COORD), heightPt: num(1, COORD) }),
    director_enabled: { type: "boolean" },
  }, ["arm", "p_inject", "sealed", "blind", "director_format_id", "director_examples_id", "director_assembled_sha8", "actor_model", "director_model", "input_mode", "pointer_config"]),
  allOf: [
    // v1.5 logs always name the input mode and both models
    { if: { properties: { contract: { const: "contract-v1.5" } } }, then: { required: ["input_mode", "actor_model", "director_model"] } },
    // pointer_config exactly when input_mode is pointer
    { if: { required: ["input_mode"], properties: { input_mode: { const: "pointer" } } }, then: { required: ["pointer_config"] }, else: { not: { required: ["pointer_config"] } } },
  ],
  oneOf: [
    // blinded main log: hidden tab, sealed, schedule position, NO arm
    { properties: { session_type: { const: "blinded" }, tab: { const: "hidden" } }, required: ["sealed", "blind"], not: { anyOf: [{ required: ["arm"] }, { required: ["p_inject"] }] } },
    // sealed log of a blinded session: the full record (arm + p_inject + blind + sealed)
    { properties: { session_type: { const: "blinded" }, tab: { const: "hidden" } }, required: ["sealed", "blind", "arm", "p_inject"] },
    // tab visible: arm in the open, never sealed or scheduled
    { properties: { session_type: { const: "tab_visible" }, tab: { const: "visible" } }, required: ["arm", "p_inject"], not: { anyOf: [{ required: ["sealed"] }, { required: ["blind"] }] } },
  ],
};
const actorTurn = {
  ...ev("actor_turn", {
    turn, msg: msgId, text: { type: "string" }, model: str(1, 128), genMs: num(0), firstTokenMs: nul(num(0)), usage, finish_reason: nul(str(1, 32)),
    opener_cue: { type: "boolean" }, error: healthCode,
    note_id: { ...nul(str(2, 12, { pattern: "^n[0-9]+$" })), description: "TAB-ONLY: absent in a blinded main log" },
    actor_request_sha256: { ...sha, description: "TAB-ONLY: absent in a blinded main log" }, sealed: { const: true, description: "blinded main log only" },
  }, ["error", "note_id", "actor_request_sha256", "sealed"]),
  oneOf: [
    { required: ["sealed"], not: { anyOf: [{ required: ["note_id"] }, { required: ["actor_request_sha256"] }] }, properties: { usage: { properties: { prompt_tokens: { type: "null" } } } } },
    { required: ["note_id", "actor_request_sha256"], not: { required: ["sealed"] } },
  ],
};
const events = [
  sessionStart,
  ev("gaze_quality", { turn, calib: obj({ errDeg: nul(num(0)), errParas: nul(num(0)), ageS: nul(num(0)), orientation: P("Orientation") }), quality: share01, faceFrac: share01, hz: nul(G("GazeHz")) }),
  ev("aoi_layout", { turn, msg: msgId, orientation: P("Orientation"), boxes: arr(aoiBox, 0, 400) }),
  ev("scroll", { samples: arr(obj({ t: num(0), top: num(-COORD, COORD * 100) }), 1, 600) }),
  ev("pointer_l1", { t0: num(0), t1: num(0), events: arr(pointerEvent, 0, 20) }),
  ev("model_change", { at: turn, role: en("actor", "director"), from: str(1, 128), to: str(1, 128) }),
  ev("gaze_l1", { t0: num(0), t1: num(0), fixations: arr(fixation, 0, 20), saccades: arr({ ...saccade, properties: { ...saccade.properties, dir: en("back", "jump") } }, 0, 10), gaps: arr(gap, 0, 10) }),
  ev("gaze_raw", { samples: arr(G("GazeSample"), 1, 64) }),
  ev("tab_occluded", { turn, msg: msgId, t0: num(0), t1: num(0), ms: num(0) }),
  ev("aoi_dwell", { turn, msg: msgId, dwell: arr(aoiDwell, 0, 400) }),
  ev("attention_digest", { turn, msg: msgId, digest, events: arr(attEvent, 0, 64) }),
  ev("user_turn", { turn, msg: str(2, 12, { pattern: "^u[0-9]+$" }), text: { type: "string" }, sentAt: num(0), hold_ms: num(0, 1500) }),
  ev("director_call", { turn, msg: msgId, input_sha256: sha, input_tokens: tok, model: str(1, 128), genMs: num(0), usage, footprint, repaired: { type: "boolean" }, deadline_missed: { type: "boolean" }, output: nul(N("DirectorOutput")), error: healthCode,
    assembled_prompt_sha8: str(8, 8, { pattern: "^[0-9a-f]{8}$" }),
    input_tokens_by_slot: obj({ system: tok, format: tok, examples: tok, digest: tok }) }, ["error", "assembled_prompt_sha8", "input_tokens_by_slot"]),
  ev("rail_check", { turn, note_id: str(2, 12, { pattern: "^n[0-9]+$" }), pass: { type: "boolean" }, blocked_by: arr(N("RailCode"), 0, 12), hits: arr(str(1, 64), 0, 32) }, ["hits"]),
  ev("injection", { turn, note_id: str(2, 12, { pattern: "^n[0-9]+$" }), decision: en("inject", "shadow"), kind: N("NoteKind"), move: N("SuggestionMove"), actor_text: str(1, 1200), evidence: arr(N("EvidenceId"), 1, 24), trigger_features: numMap, confidence: share01 }, ["move"]),
  ev("note_dropped", { turn, note_id: str(2, 12, { pattern: "^n[0-9]+$" }), reason: en("late", "superseded", "session_end", "leak_judge", "withheld") }),
  ev("leak_judge", { turn, note_id: str(2, 12, { pattern: "^n[0-9]+$" }), decision: en("inject", "shadow"), judge_prompt_id: str(1, 32, { pattern: "^lj[0-9]+-[0-9a-f]{8}$" }), model: str(1, 128),
    deadline_ms: num(0), ms: num(0), status: en("ok", "timeout", "error", "unparseable"),
    regex: { ...arr(N("LeakCode"), 0, 6), uniqueItems: true }, uncertain: { ...arr(N("LeakCode"), 0, 6), uniqueItems: true }, judge: nul({ ...arr(N("LeakCode"), 0, 6), uniqueItems: true }), codes: { ...arr(N("LeakCode"), 0, 6), uniqueItems: true },
    answered_first: nul({ type: "boolean" }), answer_first_violation: { oneOf: [{ type: "boolean" }, { const: "uncertain" }, { type: "null" }] },
    verdict: en("pass", "flagged", "uncertain"), dropped: { type: "boolean" }, reply_sha256: nul(sha), error: healthCode }, ["error", "answer_first_violation"]),
  ev("context_share", { turn, note_id: nul(str(2, 12, { pattern: "^n[0-9]+$" })), opener: { type: "boolean" }, system: tok, history: tok, history_echo: tok, user: tok, director: tok, total: tok, share: share01, dynamic_share: share01, provider_prompt_tokens: nul(tok) }),
  actorTurn,
  ev("note_outcome", { turn, note_id: str(2, 12, { pattern: "^n[0-9]+$" }), decision: en("inject", "shadow"), used: share01, followed: nul({ type: "boolean" }), answered_first: nul({ type: "boolean" }), leaks: { ...arr(N("LeakCode"), 0, 6), uniqueItems: true }, leak_source: en("regex", "judge", "both"), next_dwell_ratio: nul(num(0)), next_rating: nul(num(1, 5)), pushback: nul({ type: "boolean" }) }),
  ev("session_share", { turns: int(0), notes: int(0), shadow_notes: int(0), blocked_notes: int(0), injection_rate: share01, session_share: share01, session_dynamic_share: share01, mean_turn_share: nul(share01), max_turn_share: nul(share01), echo_share: share01 }),
  ev("health", { check: en(...HEALTH_CHECKS), ok: { type: "boolean" }, code: nul(healthCode), detail: str(1, 200), http_status: int(100, 599), worker_code: W("WorkerErrorCode"), role: W("Role") }, ["detail", "http_status", "worker_code", "role"]),
  ev("session_end", { turns: int(0), reason: en("user", "new_chat", "error", "replay_end") }),
];
const defs = {};
for (const e of events) defs[e.properties.type.const] = e;
const eventsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: BASE + "bh-ad-events.schema.json",
  title: "bh-ad/1 session log line (contract-v1)",
  definitions: { ...Object.fromEntries(Object.entries(defs).map(([k, v]) => ["ev_" + k, v])), DirectorFootprint: footprint, ReadingDigest: digest, AttentionEvent: attEvent, AoiDwell: aoiDwell, HealthCode: healthCode },
  // dispatch on type so an error points at the right event
  type: "object", required: ["type"],
  properties: { type: en(...Object.keys(defs)) },
  allOf: Object.keys(defs).map((k) => ({ if: { properties: { type: { const: k } } }, then: { $ref: "#/definitions/ev_" + k } })),
};

const dir = dirname(fileURLToPath(import.meta.url));
export const SCHEMAS = { "gaze-sample.schema.json": gazeSchema, "gaze-plugin.schema.json": pluginSchema, "note.schema.json": noteSchema, "bh-ad-events.schema.json": eventsSchema, "worker.schema.json": workerSchema };
export const serialize = (s) => JSON.stringify(s, null, 2) + "\n";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [f, s] of Object.entries(SCHEMAS)) writeFileSync(join(dir, f), serialize(s));
  console.log("wrote", Object.keys(SCHEMAS).join(", "));
}
