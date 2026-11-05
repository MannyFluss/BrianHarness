/**
 * One example payload per contract object. The test validates every one against its JSON Schema, the
 * `satisfies` clauses check them against the TypeScript types (npm run typecheck), and examples/*.json
 * plus README.md must contain exactly these objects.
 */
import type { GazeSample } from "./gaze.js";
import type { CalibrateOptions, CalibrateResult, GazeBatchEvent, GazeReplayFile, GazeStatus, ScreenInfo, StartOptions, StartResult } from "./gaze-plugin.js";
import { renderActorText, type DirectorOutput } from "./note.js";
import type { BhAdEvent } from "./events.js";
import type { AdUploadEnvelope, WorkerErrorBody } from "./worker.js";

const SID = "ad-2026-11-04-7f3a";
const env = (seq: number, mono: number) => ({ schema: "bh-ad/1" as const, t: new Date(Date.UTC(2026, 10, 4, 23, 10, 0) + mono).toISOString(), mono, sessionId: SID, seq });

export const gazeSample = { t: 81234.5, x: 212.4, y: 388.9, conf: 0.94, face: true, blink: false, lids: { l: 0.08, r: 0.11 }, head: { yaw: -4.2, pitch: 6.1, roll: 1.3, distCm: 34.5 }, cal: false, src: "arkit" } satisfies GazeSample;
export const gazeSampleNoFace = { t: 81267.8, x: null, y: null, conf: 0, face: false, blink: false, cal: false, src: "arkit" } satisfies GazeSample;

const screenIpadLandscape = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_right", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 230 } satisfies ScreenInfo;
export const pluginStartOptions = { mode: "synthetic", synthetic: { file: "gaze-replays/ipadpro-m1-landscape-01.json", loop: true, speed: 1 }, webNow: 80012.25, maxHz: 30 } satisfies StartOptions;
const runningStatus = { supported: true, unsupportedCode: null, permission: "granted", state: "running", pauseReason: null, tracker: "arkit", mode: "synthetic", hz: 30, code: null } satisfies GazeStatus;
export const pluginStartResult = { status: runningStatus, screen: screenIpadLandscape } satisfies StartResult;
export const pluginStatusPaused = { supported: true, unsupportedCode: null, permission: "granted", state: "paused", pauseReason: "background", tracker: "arkit", mode: "camera", hz: null, code: null } satisfies GazeStatus;
export const pluginCalibrateBegin = { phase: "begin", orientation: "landscape_right", targets: [{ id: "c1", x: 80, y: 80 }, { id: "c2", x: 597, y: 80 }, { id: "c3", x: 1114, y: 80 }, { id: "c4", x: 80, y: 417 }, { id: "c5", x: 597, y: 417 }, { id: "c6", x: 1114, y: 417 }, { id: "c7", x: 80, y: 754 }, { id: "c8", x: 597, y: 754 }, { id: "c9", x: 1114, y: 754 }] } satisfies CalibrateOptions;
export const pluginCalibrateEnd = { phase: "end", ok: true, fit: "core", model: null, samples: 412, code: null } satisfies CalibrateResult;
export const pluginGazeBatch = { seq: 1207, hz: 30, samples: [gazeSample, { ...gazeSample, t: 81267.8, x: 214.0, y: 390.2, conf: 0.93 }, { ...gazeSample, t: 81301.2, x: 215.1, y: 389.7, blink: true, conf: 0.6 }] } satisfies GazeBatchEvent;
export const gazeReplayFile = { schema: "bh-gaze-replay/1", layout: "ipadpro-m1-landscape", src: "synthetic", hz: 30, screen: screenIpadLandscape,
  samples: [{ t: 0, x: 402, y: 210, conf: 0.9, face: true, blink: false, head: { yaw: 18, pitch: 2, roll: 0, distCm: 45 }, cal: true, src: "synthetic" }, { t: 33.3, x: 405, y: 211, conf: 0.9, face: true, blink: false, head: { yaw: 18, pitch: 2, roll: 0, distCm: 45 }, cal: true, src: "synthetic" }] } satisfies GazeReplayFile;

/** the spec's example output */
export const directorOutputNote = {
  context_update: {
    summary: "Manny is planning his first rye sourdough. He engages most with the why of fermentation; recipe numbers get skimmed.",
    hypotheses: [{ label: "fermentation science", conf: 0.7, evidence: ["e31", "e19"] }, { label: "oven hardware", conf: 0.4, evidence: ["e33"] }],
    changed: ["raised fermentation science 0.55 -> 0.70"],
  },
  intent: "See whether the fermentation thread keeps holding when the Actor goes deeper.",
  note: {
    id: "n5",
    rationale: "Deep read + 2 rereads on the rye-fermentation paragraph (e31), look-back to oven hot spots (e33); hydration skimmed (e32).",
    observation: "They seem most drawn to why rye ferments faster; the hydration numbers landed flat.",
    suggestion: { move: "go_deeper", target: "why rye ferments faster", text: "go deeper on why rye ferments faster, and skip more ratios" },
    value: "Two turns of signal agree; a generic next reply would likely repeat ratios he skimmed.",
    evidence: ["e31", "e32", "e33"],
    confidence: 0.78,
    expires_after_turns: 1,
  },
  no_note_reason: null,
} satisfies DirectorOutput;
export const directorOutputNoNote = {
  context_update: { summary: "Manny asked for a weekday bake schedule; he is reading everything at his usual pace.", hypotheses: [{ label: "fermentation science", conf: 0.66, evidence: ["e31"] }], changed: [] },
  intent: "Let the schedule question play out before steering.",
  note: null,
  no_note_reason: "He asked a concrete scheduling question; the Actor should just answer it, and nothing new stands out.",
} satisfies DirectorOutput;
export const actorText = renderActorText(directorOutputNote.note);

const device = { deviceModel: "iPhone18,1", platform: "ios", orientation: "portrait", widthPt: 402, heightPt: 874 } as const;
const common = { profile: "actor-director", contract: "contract-v1.5", userId: "manny", actor_prompt_id: "ap1-3c9e1b07", director_prompt_id: "dir1-b1d2fd77", pipeline_version: "gp1.0.0", tokenizer: "o200k_base", models: { actor: "gpt-oss:20b-cloud", director: "gpt-oss:120b-cloud" }, actor_model: "gpt-oss:20b-cloud", director_model: "gpt-oss:120b-cloud", input_mode: "gaze", consent: { camera: true, rawGaze: false }, gaze: { tracker: "arkit", permission: "granted" }, device, director_enabled: true } as const;
const blind = { index: 3, total: 10, scheduleHash: "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e" };
const usage = { prompt_tokens: 1788, completion_tokens: 212, reasoning_tokens: 64 };

export const events = {
  session_start_tab_visible: { ...env(0, 0), type: "session_start", ...common, session_type: "tab_visible", tab: "visible", arm: "on", p_inject: 0.5 },
  session_start_blinded_main: { ...env(0, 0), type: "session_start", ...common, session_type: "blinded", tab: "hidden", sealed: true, blind },
  session_start_blinded_sealed: { ...env(0, 0), type: "session_start", ...common, session_type: "blinded", tab: "hidden", sealed: true, blind, arm: "off", p_inject: 0 },
  gaze_quality: { ...env(101, 412000), type: "gaze_quality", turn: 12, calib: { errDeg: 3.4, errParas: 0.6, ageS: 410, orientation: "portrait" }, quality: 0.82, faceFrac: 0.97, hz: 30 },
  /** v1.2: the phone's Director sheet covered the chat for 4.2 s of a11's reading window */
  tab_occluded: { ...env(103, 418300), type: "tab_occluded", turn: 11, msg: "a11", t0: 414100, t1: 418300, ms: 4200 },
  aoi_layout: { ...env(102, 412010), type: "aoi_layout", turn: 11, msg: "a11", orientation: "portrait", boxes: [{ aoi: "a11.p1", words: 38, x: 16, y: 5120, w: 370, h: 132 }, { aoi: "a11.p2", words: 52, x: 16, y: 5268, w: 370, h: 176 }] },
  scroll: { ...env(103, 412020), type: "scroll", samples: [{ t: 411100, top: 4980 }, { t: 411600, top: 5040 }] },
  gaze_l1: { ...env(104, 412030), type: "gaze_l1", t0: 407030, t1: 412030, fixations: [{ id: "f881", t0: 410020, t1: 410310, x: 120.5, y: 210.2, dispPx: 14.1, n: 9 }], saccades: [{ t0: 410310, t1: 410345, from: "f881", to: "f882", dir: "back", ampDeg: 2.6 }], gaps: [{ t0: 410400, t1: 410520, kind: "blink" }] },
  aoi_dwell: { ...env(105, 412040), type: "aoi_dwell", turn: 11, msg: "a11", dwell: [{ aoi: "a11.p2", words: 52, visibleMs: 18200, gazeMs: 14100, msPerWordZ: 2.6, fixations: 61, reentries: 2, regressionsIn: 5, firstFixLatencyMs: 640, coverage: 0.9, conf: 0.74 }] },
  attention_digest: { ...env(106, 412050), type: "attention_digest", turn: 11, msg: "a11",
    digest: { msg: "a11", windowMs: 41000, quality: 0.82, qualityLabel: "good", paras: [{ aoi: "a11.p2", excerpt: "Rye flour ferments much faster...", label: "deep", ratio: 2.4, ev: ["e31"] }, { aoi: "a11.p3", excerpt: "Most bakers use 75% hydration...", label: "skim", ratio: 0.3, ev: ["e32"] }], lookBacks: [{ aoi: "a9.p2", excerpt: "hot spots in your oven", ms: 3100, ev: "e33" }], offscreenMs: 0, composerPauses: 2, events: ["e31", "e32", "e33"] },
    events: [{ id: "e31", kind: "deep_read", aoi: "a11.p2", excerpt: "Rye flour ferments much faster", t0: 392000, t1: 410300, z: 2.6, conf: 0.74, features: { msPerWord: 271, reentries: 2 } }] },
  user_turn: { ...env(107, 413500), type: "user_turn", turn: 11, msg: "u11", text: "ok so how long should the levain sit before I mix?", sentAt: 413480, hold_ms: 0 },
  director_call: { ...env(108, 413510), type: "director_call", turn: 12, msg: "a11", input_sha256: "4b1d6e0f9a8c7b2e3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", input_tokens: 2910, model: "mock:director", genMs: 3820, usage: { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null },
    footprint: { actor_turns: 11, notes_injected: 4, notes_shadowed: 3, notes_blocked: 1, session_share: 0.016, session_dynamic_share: 0.021, recent: [{ note_id: "n4", turn: 9, kind: "suggestion", move: "go_deeper", decision: "inject", followed: true, next_dwell_ratio: 1.3 }] },
    repaired: false, deadline_missed: false, output: directorOutputNote },
  rail_check: { ...env(109, 413512), type: "rail_check", turn: 12, note_id: "n5", pass: true, blocked_by: [] },
  rail_check_blocked: { ...env(109, 413512), type: "rail_check", turn: 12, note_id: "n6", pass: false, blocked_by: ["lint_sensor"], hits: ["reread"] },
  injection: { ...env(110, 413513), type: "injection", turn: 12, note_id: "n5", decision: "inject", kind: "both", move: "go_deeper", actor_text: actorText, evidence: ["e31", "e32", "e33"], trigger_features: { "e31.z": 2.6, "e32.z": -1.9, "e33.ms": 3100 }, confidence: 0.78 },
  note_dropped: { ...env(110, 413513), type: "note_dropped", turn: 13, note_id: "n7", reason: "late" },
  /** v1.2: the pre-display leak gate (sealed-only); a pass, so the note stays */
  leak_judge: { ...env(111, 421410), type: "leak_judge", turn: 12, note_id: "n5", decision: "inject", judge_prompt_id: "lj1-11631f45", model: "gemma4:cloud", deadline_ms: 2500, ms: 912, status: "ok", regex: [], uncertain: [], judge: [], codes: [], answered_first: true, verdict: "pass", dropped: false, reply_sha256: "5d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c" },
  /** v1.2: a judge timeout counts as uncertain: the note is dropped (fail safe) */
  leak_judge_timeout: { ...env(111, 421410), type: "leak_judge", turn: 13, note_id: "n7", decision: "shadow", judge_prompt_id: "lj1-11631f45", model: "gemma4:cloud", deadline_ms: 2500, ms: 2500, status: "timeout", regex: [], uncertain: [], judge: null, codes: [], answered_first: null, verdict: "uncertain", dropped: true, reply_sha256: "6e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2d" },
  note_dropped_leak_judge: { ...env(112, 421411), type: "note_dropped", turn: 13, note_id: "n7", reason: "leak_judge" },
  /** the spec's illustrative turn: S 230, H 1420, U 60, D 41 */
  context_share: { ...env(111, 413520), type: "context_share", turn: 12, note_id: "n5", opener: false, system: 230, history: 1420, history_echo: 310, user: 60, director: 41, total: 1751, share: 41 / 1751, dynamic_share: 41 / 1521, provider_prompt_tokens: 1788 },
  actor_turn: { ...env(112, 421400), type: "actor_turn", turn: 12, msg: "a12", text: "Give it 4 to 6 hours at room temperature, until it's domed and bubbly...", model: "gpt-oss:20b-cloud", genMs: 7880, firstTokenMs: 640, usage, finish_reason: "stop", opener_cue: false, note_id: "n5", actor_request_sha256: "0c7e1d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d" },
  actor_turn_blinded_main: { ...env(112, 421400), type: "actor_turn", turn: 12, msg: "a12", text: "Give it 4 to 6 hours at room temperature, until it's domed and bubbly...", model: "gpt-oss:20b-cloud", genMs: 7880, firstTokenMs: 640, usage: { ...usage, prompt_tokens: null }, finish_reason: "stop", opener_cue: false, sealed: true },
  note_outcome: { ...env(130, 470000), type: "note_outcome", turn: 12, note_id: "n5", decision: "inject", used: 0.5, followed: null, answered_first: true, leaks: [], leak_source: "regex", next_dwell_ratio: 1.2, next_rating: null, pushback: false },
  session_share: { ...env(400, 1200000), type: "session_share", turns: 21, notes: 6, shadow_notes: 5, blocked_notes: 1, injection_rate: 6 / 21, session_share: 0.0158, session_dynamic_share: 0.0209, mean_turn_share: 0.0231, max_turn_share: 0.0312, echo_share: 0.091 },
  health: { ...env(5, 1200), type: "health", check: "budget", ok: false, code: "budget.director_cap", detail: "Director paused: daily cap reached; chat continues without notes", http_status: 429, worker_code: "role_cap_director", role: "director" },
  gaze_raw: { ...env(6, 1300), type: "gaze_raw", samples: [gazeSample] },
  session_end: { ...env(401, 1200100), type: "session_end", turns: 21, reason: "user" },
  /** v1.5: Mac, Pointer mode (first Mac pilot), tab visible dogfood; no camera; dwell 500 ms, gaps <= 100 ms merged */
  session_start_pointer: { ...env(0, 0), type: "session_start", ...common, input_mode: "pointer", pointer_config: { id: "pc1-d500-g100", dwell_ms: 500, merge_gap_ms: 100 },
    consent: { camera: false, rawGaze: false }, gaze: { tracker: "none", permission: "prompt" }, device: { deviceModel: "MacBookAir10,1", platform: "mac", orientation: "landscape_right", widthPt: 1440, heightPt: 900 },
    session_type: "tab_visible", tab: "visible", arm: "on", p_inject: 0.5 },
  /** v1.5: paragraphs are text (no interactive flag); a selectable span and a button are interactive */
  aoi_layout_pointer: { ...env(20, 61010), type: "aoi_layout", turn: 3, msg: "a3", orientation: "landscape_right", boxes: [{ aoi: "a3.p1", words: 41, x: 320, y: 410, w: 680, h: 96 }, { aoi: "a3.p2.s1", words: 4, x: 352, y: 530, w: 190, h: 22, interactive: true }, { aoi: "a3.c1", words: 2, x: 320, y: 590, w: 120, h: 32, interactive: true }] },
  /** v1.5: interactive-AOI pointer events; ids p<k> are evidence ids */
  pointer_l1: { ...env(21, 66010), type: "pointer_l1", t0: 61010, t1: 66010, events: [{ id: "p4", kind: "pointer_hover", aoi: "a3.c1", msg: "a3", t0: 62100, t1: 62100 }, { id: "p5", kind: "pointer_dwell", aoi: "a3.c1", msg: "a3", t0: 62100, t1: 62980, dwell_ms: 880 }, { id: "p6", kind: "pointer_select", aoi: "a3.p2.s1", msg: "a3", t0: 64200, t1: 64200 }] },
  /** v1.5: a Pointer-mode digest: no reading labels, no e-events; quality names the source via input_mode */
  attention_digest_pointer: { ...env(22, 66020), type: "attention_digest", turn: 3, msg: "a3",
    digest: { msg: "a3", windowMs: 5000, quality: 1, qualityLabel: "good", paras: [], lookBacks: [], offscreenMs: 0, composerPauses: 0, events: [], input_mode: "pointer",
      pointer: [{ id: "p5", kind: "pointer_dwell", aoi: "a3.c1", excerpt: "Show the math", dwell_ms: 880 }, { id: "p6", kind: "pointer_select", aoi: "a3.p2.s1", excerpt: "autolyse first" }] },
    events: [] },
  /** v1.5: Manny switched the Director model mid-session; takes effect from turn 5's request (same session) */
  model_change: { ...env(40, 140000), type: "model_change", at: 5, role: "director", from: "gpt-oss:120b-cloud", to: "gpt-oss:20b-cloud" },
} satisfies Record<string, BhAdEvent>;

const exampleLog = [events.session_start_tab_visible, events.health, events.session_end].map((e) => JSON.stringify(e)).join("\n") + "\n";
export const uploadEnvelope = { schema: "bh-ad/1", sessionId: SID, appVersion: "0.1.0", platform: "ios", build: "20261105.0900", jsonl: exampleLog } satisfies AdUploadEnvelope;
export const roleCapError = { error: { message: "daily director request cap reached for this device (100 director requests per UTC day); resets at 2026-11-05T00:00:00.000Z", type: "rate_limit_error", code: "role_cap_director", limit: 100, used: 100, reset_at: "2026-11-05T00:00:00.000Z", role: "director", scope: "role" } } satisfies WorkerErrorBody;
