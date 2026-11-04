/**
 * bh-ad/1: the Actor/Director session log (one JSON object per line).
 *
 * Every line carries the envelope { schema: "bh-ad/1", type, t, mono, sessionId, seq }.
 * Turn numbering follows the existing harness: turn 0 is the opener. aT = the Actor message of turn T,
 * uT = the user message that answers aT (so a(T+1) answers uT). Director-side events (director_call,
 * rail_check, injection, note_dropped, context_share) carry the turn of the Actor REQUEST they affect.
 *
 * Session types (fixed at session start by the schedule, never toggled mid-session):
 *   tab_visible: tab "visible", arm + p_inject logged openly; legibility / dogfood; excluded from the A/B.
 *   blinded:     tab "hidden" (cannot be opened), the Director runs and waits in EVERY arm (timing parity).
 *                Two logs are written: the SEALED log (full content, exactly the tab_visible shape, kept in the
 *                sealed namespace, never shown in the app) and the MAIN log = its redacted projection:
 *                  - session_start: no arm / p_inject, sealed:true, blind {index,total,scheduleHash}
 *                  - director_call, rail_check, injection, note_dropped, context_share, note_outcome,
 *                    session_share: not written
 *                  - actor_turn: sealed:true, no note_id, no actor_request_sha256, usage.prompt_tokens null
 *                  - health with code director.leak_breaker: not written
 *                Everything else is identical in both logs.
 */
import type { CameraPermission, Orientation, ScreenInfo } from "./gaze-plugin.js";
import type { GazeHz, GazeSample, GazeSrc } from "./gaze.js";
import type { Role, WorkerErrorCode } from "./worker.js";
import type { HealthCheck, HealthCode } from "./health.js";
import type { DirectorOutput, EvidenceId, LeakCode, NoteKind, RailCode, SuggestionMove } from "./note.js";

export type SessionType = "blinded" | "tab_visible";
export type Arm = "on" | "shadow" | "off";

export interface Envelope {
  schema: "bh-ad/1";
  /** ISO wall-clock time */
  t: string;
  /** ms on the web layer's monotonic clock, the same clock as GazeSample.t */
  mono: number;
  sessionId: string;
  /** 0, 1, 2... per log file, no gaps */
  seq: number;
}

/** null = not reported by the provider */
export interface Usage { prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null }

// ---- pipeline types (from the spec, L1-L4) ----
export interface Fixation { id: string; t0: number; t1: number; x: number; y: number; dispPx: number; n: number }
export interface Saccade { t0: number; t1: number; from: string; to: string; dir: "fwd" | "back" | "jump"; ampDeg: number }
export interface GapEvent { t0: number; t1: number; kind: "blink" | "offscreen" | "noface" | "lowconf" }
export interface AoiBox { aoi: string; words: number; x: number; y: number; w: number; h: number }
export interface AoiDwell {
  aoi: string; words: number; visibleMs: number; gazeMs: number; msPerWordZ: number | null; fixations: number;
  reentries: number; regressionsIn: number; firstFixLatencyMs: number | null; coverage: number; conf: number;
}
export type AttentionKind = "deep_read" | "reread" | "skip" | "look_back" | "fast_scan" | "offscreen" | "composer_hesitation" | "eeg_spike";
export interface AttentionEvent {
  id: string; kind: AttentionKind; aoi: string; excerpt: string; t0: number; t1: number;
  z: number | null; conf: number; features: Record<string, number>;
}
export interface ReadingDigest {
  msg: string; windowMs: number; quality: number; qualityLabel: "good" | "fair" | "poor";
  paras: Array<{ aoi: string; excerpt: string; label: "deep" | "read" | "skim" | "skipped"; ratio: number; ev?: string[] }>;
  lookBacks: Array<{ aoi: string; excerpt: string; ms: number; ev: string }>;
  offscreenMs: number; composerPauses: number; events: string[];
}

/** what the Director is told about itself on every call */
export interface DirectorFootprint {
  actor_turns: number;
  notes_injected: number;
  notes_shadowed: number;
  notes_blocked: number;
  /** session share (3) and session dynamic share so far, 0..1 */
  session_share: number;
  session_dynamic_share: number;
  /** last <= 3 notes with outcomes, newest last */
  recent: Array<{ note_id: string; turn: number; kind: NoteKind; move: SuggestionMove | null; decision: "inject" | "shadow" | "blocked"; followed: boolean | null; next_dwell_ratio: number | null }>;
}

// ---- events ----
export type BhAdEventBody =
  | {
      type: "session_start";
      profile: "actor-director";
      contract: "contract-v1";
      userId: string;
      session_type: SessionType;
      tab: "visible" | "hidden";
      /** tab_visible only (in blinded sessions: sealed log only) */
      arm?: Arm;
      /** probability a rail-passing note is injected (else shadow); tab_visible only. 0.5 in arm on, 0 in shadow/off */
      p_inject?: number;
      /** blinded only: true */
      sealed?: true;
      /** blinded only, the protocol-4 pattern: position in the sealed schedule + its sha256, never the arm */
      blind?: { index: number; total: number; scheduleHash: string };
      actor_prompt_id: string;
      director_prompt_id: string;
      pipeline_version: string;
      tokenizer: "o200k_base";
      models: { actor: string; director: string };
      consent: { camera: boolean; rawGaze: boolean };
      gaze: { tracker: GazeSrc | "none"; permission: CameraPermission };
      device: Pick<ScreenInfo, "deviceModel" | "platform" | "orientation" | "widthPt" | "heightPt">;
      director_enabled: boolean;
    }
  | { type: "gaze_quality"; turn: number; calib: { errDeg: number | null; errParas: number | null; ageS: number | null; orientation: Orientation }; quality: number; faceFrac: number; hz: GazeHz | null }
  | { type: "aoi_layout"; turn: number; msg: string; orientation: Orientation; boxes: AoiBox[] }
  | { type: "scroll"; samples: Array<{ t: number; top: number }> }
  /** one batch per <= 5 s window [t0,t1]; at most 20 fixations (about 4 Hz; over that, adjacent fixations on the same
   *  AOI are merged first). Saccades: only "back" and "jump" (<= 10), forward saccades are implied by consecutive
   *  fixations. Gaps <= 10 (blink / offscreen / noface / lowconf). Coordinates rounded to 0.1, times to 1 ms. */
  | { type: "gaze_l1"; t0: number; t1: number; fixations: Fixation[]; saccades: Array<Saccade & { dir: "back" | "jump" }>; gaps: GapEvent[] }
  /** raw L0 samples: ONLY when session_start.consent.rawGaze is true (default false, local research sessions);
   *  a log with any gaze_raw line is local-only and is never uploaded (it cannot fit the 1 MiB budget) */
  | { type: "gaze_raw"; samples: GazeSample[] }
  | { type: "aoi_dwell"; turn: number; msg: string; dwell: AoiDwell[] }
  | { type: "attention_digest"; turn: number; msg: string; digest: ReadingDigest; events: AttentionEvent[] }
  | { type: "user_turn"; turn: number; msg: string; text: string; sentAt: number; hold_ms: number }
  | {
      type: "director_call"; turn: number; msg: string; input_sha256: string; input_tokens: number; model: string;
      genMs: number; usage: Usage; footprint: DirectorFootprint; repaired: boolean; deadline_missed: boolean;
      output: DirectorOutput | null; error?: HealthCode;
    }
  | { type: "rail_check"; turn: number; note_id: string; pass: boolean; blocked_by: RailCode[]; hits?: string[] }
  | {
      type: "injection"; turn: number; note_id: string; decision: "inject" | "shadow"; kind: NoteKind; move?: SuggestionMove;
      actor_text: string; evidence: EvidenceId[]; trigger_features: Record<string, number>; confidence: number;
    }
  | { type: "note_dropped"; turn: number; note_id: string; reason: "late" | "superseded" | "session_end" }
  | {
      type: "context_share"; turn: number; note_id: string | null; opener: boolean;
      system: number; history: number; history_echo: number; user: number; director: number; total: number;
      share: number; dynamic_share: number; provider_prompt_tokens: number | null;
    }
  | {
      type: "actor_turn"; turn: number; msg: string; text: string; model: string; genMs: number; firstTokenMs: number | null;
      usage: Usage; finish_reason: string | null; opener_cue: boolean; error?: HealthCode;
      /** tab_visible + sealed log */
      note_id?: string | null; actor_request_sha256?: string;
      /** blinded main log only */
      sealed?: true;
    }
  | {
      type: "note_outcome"; turn: number; note_id: string; decision: "inject" | "shadow";
      used: number; followed: boolean | null; answered_first: boolean | null; leaks: LeakCode[]; leak_source: "regex" | "judge" | "both";
      next_dwell_ratio: number | null; next_rating: number | null; pushback: boolean | null;
    }
  | {
      type: "session_share"; turns: number; notes: number; shadow_notes: number; blocked_notes: number; injection_rate: number;
      session_share: number; session_dynamic_share: number; mean_turn_share: number | null; max_turn_share: number | null; echo_share: number;
    }
  /** worker_code = the Worker's error.code (e.g. "role_cap_director"), role = the X-BH-Role of the failed request */
  | { type: "health"; check: HealthCheck; ok: boolean; code: HealthCode | null; detail?: string; http_status?: number; worker_code?: WorkerErrorCode; role?: Role }
  | { type: "session_end"; turns: number; reason: "user" | "new_chat" | "error" | "replay_end" };

export type BhAdEvent = Envelope & BhAdEventBody;
export type BhAdEventType = BhAdEventBody["type"];

/** event types that exist only in the sealed log of a blinded session */
export const SEALED_ONLY_TYPES: readonly BhAdEventType[] = ["director_call", "rail_check", "injection", "note_dropped", "context_share", "note_outcome", "session_share"];
/** gaze_l1 rate limit: batches cover <= 5 s; <= 20 fixations, <= 10 back/jump saccades, <= 10 gaps per batch */
export const GAZE_L1_MAX_FIXATIONS = 20;
export const GAZE_L1_MAX_SACCADES = 10;
export const GAZE_L1_MAX_GAPS = 10;
export const GAZE_L1_MAX_WINDOW_MS = 5000;
/**
 * Fields that may appear ONLY in tab_visible sessions or in the sealed log of a blinded session, never in a
 * blinded main log (and the event types in SEALED_ONLY_TYPES). The proposed server-side blinded guard checks these.
 */
export const TAB_ONLY_FIELDS = {
  session_start: ["arm", "p_inject"],
  actor_turn: ["note_id", "actor_request_sha256"],
} as const;
export const ACTOR_PROMPT_ID_PATTERN = "^ap[0-9]+-[0-9a-f]{8}$";
export const DIRECTOR_PROMPT_ID_PATTERN = "^dir[0-9]+-[0-9a-f]{8}$";
