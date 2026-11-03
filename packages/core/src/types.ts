/** Shared contracts. Everything here is plain JSON-serialisable data. */

/** How the Director phrases its question. Scored per user like topics. */
export type QuestionStyle = "open" | "either-or" | "personal-story" | "hypothetical" | "deep-dive";
export const QUESTION_STYLES: QuestionStyle[] = ["open", "either-or", "personal-story", "hypothetical", "deep-dive"];

/** Director pacing mode, after Left 4 Dead's AI Director (build-up / peak / relax). */
export type DirectorMode = "explore" | "exploit" | "relax";

/** One raw composer event captured in the renderer. Key identity is NOT stored, only its class. */
/**
 * Where an edit came from, when the platform can tell (beforeinput/input inputType + recent
 * keydown/pointer). iOS gives no per-key timing for autocorrect, predictive-bar picks or
 * dictation: those arrive as one multi-character insert.
 */
export type InputSource = "hardware-key" | "soft-keyboard" | "autocorrect" | "predictive" | "composition" | "dictation" | "paste" | "drop" | "programmatic" | "unknown";

export interface TypingEvent {
  /** ms since epoch */
  t: number;
  kind: "insert" | "delete" | "paste" | "nav" | "submit" | "focus" | "blur";
  /** length of the composer value after the event */
  len: number;
  /** optional: input source (web/iOS renderer); absent in older logs and the sim */
  source?: InputSource;
  /** optional: characters inserted (>1 for autocorrect / predictive / dictation / paste) */
  chars?: number;
}

/** Numeric features for one window of time, from one signal source. */
export type FeatureMap = Record<string, number>;

/** What the Director decided to do this turn (the "plan"). */
export interface DirectorPlan {
  turn: number;
  mode: DirectorMode;
  topic: string;
  /** second topic offered when style is either-or */
  altTopic?: string;
  style: QuestionStyle;
  reason: string;
  /** forced scouting checkpoint (anti-lock-in) */
  scout?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Fast per-turn layer: rebuilt every turn, like per-frame game state. */
export interface FrameState {
  turn: number;
  engagement: number;
  /** exponential moving average of engagement: the user's personal baseline */
  baseline: number;
  /** engagement - baseline */
  lift: number;
  features: FeatureMap;
  mentionedTopics: string[];
  lastPlan?: DirectorPlan;
}

export interface ScoreCell {
  mean: number;
  /** effective (weighted) observation count */
  n: number;
  last: number;
  updatedAt: string;
}

/** Slow per-user layer persisted between sessions: the save game. */
export interface InterestMapData {
  version: 1;
  userId: string;
  sessions: number;
  turns: number;
  topics: Record<string, ScoreCell>;
  styles: Record<string, ScoreCell>;
  /** display labels for open-vocabulary topics (lexicon topics use TOPIC_LEXICON labels) */
  labels?: Record<string, string>;
  /** open-vocab topic -> broader lexicon topic it refines (e.g. "ham radio" -> "programming"?) */
  parents?: Record<string, string>;
  updatedAt: string;
}

/**
 * Ground-truth absorption rating (evaluation only: never an input to engagement, the Director,
 * the interest map or the state note). Every prompt that was SHOWN gets one record, answered or not.
 *   scope "turn":    per-turn probe "How absorbed are you right now?"; turn = user turns so far
 *   scope "session": end-of-session "Overall, how absorbed were you?" (+ optional hooked text and
 *                    the blinding check in study sessions)
 */
export interface RatingRecord {
  type: "rating";
  t: string;
  scope: "turn" | "session";
  turn: number;
  /** 1..5, null when skipped / dismissed */
  value: number | null;
  /** epoch ms (renderer clock) the prompt appeared */
  shownAt: number;
  /** epoch ms of the tap; null when not answered */
  answeredAt: number | null;
  dismissed: boolean;
  /** why it went away unanswered: "skip" | "typed" | "sent" | "closed" | "new-chat" | ... */
  reason?: string;
  /** session scope only: optional free text "What hooked you?" (user-written, kept verbatim) */
  hooked?: string;
  /** session scope, study sessions only: blinding check */
  blindGuess?: "adaptive" | "baseline" | "no-idea" | null;
}

/** Lines written to sessions/<sessionId>.jsonl */
export type LogEvent =
  | {
      type: "session_start";
      t: string;
      sessionId: string;
      userId: string;
      backend: string;
      sources: string[];
      /** blinded study session: index (1..total) + sha256 of the sealed schedule. NEVER the mode. */
      study?: { id: string; index: number; total: number; scheduleHash: string };
    }
  | {
      type: "director_turn";
      t: string;
      turn: number;
      /** omitted (sealed: true) in blinded study sessions: plan / state note would reveal the mode */
      plan?: DirectorPlan;
      stateNote?: string;
      sealed?: boolean;
      text: string;
      backend: string;
      /** request start -> generate() resolved (whole reply) */
      genMs: number;
      /** request start -> first streamed delta (absent when the backend did not stream) */
      firstTokenMs?: number;
      streamed?: boolean;
      /** Addendum 4 (P0 cut-off fix): reply metadata, same keys in every arm; null = not reported */
      model?: string;
      max_tokens?: number | null;
      finish_reason?: string | null;
      usage?: { prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null };
      /** finish_reason "length" (the app shows "reply cut off"), or the stream failed after partial text */
      truncated?: boolean;
      /** only on a turn whose stream failed after partial text: "stream_incomplete" | "aborted" | "stream_error" */
      error?: string;
    }
  | {
      type: "user_turn";
      t: string;
      turn: number;
      text: string;
      features: FeatureMap;
      engagement: number;
      baseline: number;
      mentionedTopics: string[];
      /**
       * When the Director's previous message reached the screen (epoch ms, renderer clock):
       * firstTokenAt = first streamed token rendered, completeAt = whole message rendered.
       * The reply-latency window (and every typing feature) starts at completeAt.
       */
      prompt?: { firstTokenAt?: number; completeAt: number };
      rawEvents?: TypingEvent[];
      /** inter-key gaps (ms) inside the reply window, in order: timings only, never content */
      keyGaps?: number[];
    }
  | RatingRecord
  | { type: "interest_update"; t: string; turn: number; topTopics: Array<[string, number]>; hypothesis: string | null; top1?: string | null }
  /**
   * Session-end interest labels (written just before session_end): the final top-3 guesses as labels, the
   * extractor that produced them (prompt version + model for llm-extract). Never carries the study mode.
   */
  | ({ type: "final"; t: string; turns: number; top1: string | null; top3: string[]; top3Ids: string[]; tagger: string; extractorPromptVersion?: string; model?: string } & ExtractorOutcomeRecord)
  | ({ type: "session_end"; t: string; turns: number } & Partial<ExtractorOutcomeRecord>);

/**
 * Why a session's topic tagging did not come from the LLM extractor: no_key / mock_or_local = the app never
 * built one (selection); cap_reached / call_failed / offline = it was built but no call returned an answer;
 * not_due = the session ended before the first extractor turn.
 */
export type ExtractorFallbackReason = "no_key" | "mock_or_local" | "cap_reached" | "call_failed" | "offline" | "not_due";
/** the extractor's actual per-session outcome (never the study mode: the tagger runs in both modes) */
export interface ExtractorOutcomeRecord {
  extractorCalls: { attempted: number; ok: number; failed: number; capped: number };
  /** "llm-extract" only when at least one extractor call returned an answer; otherwise the tagger that really tagged */
  effectiveTagger: string;
  fallback: boolean;
  fallbackReason?: ExtractorFallbackReason;
}
