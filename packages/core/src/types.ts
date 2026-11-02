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

/** Lines written to sessions/<sessionId>.jsonl */
export type LogEvent =
  | { type: "session_start"; t: string; sessionId: string; userId: string; backend: string; sources: string[] }
  | {
      type: "director_turn";
      t: string;
      turn: number;
      plan: DirectorPlan;
      stateNote: string;
      text: string;
      backend: string;
      /** request start -> generate() resolved (whole reply) */
      genMs: number;
      /** request start -> first streamed delta (absent when the backend did not stream) */
      firstTokenMs?: number;
      streamed?: boolean;
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
    }
  | { type: "interest_update"; t: string; turn: number; topTopics: Array<[string, number]>; hypothesis: string | null }
  | { type: "session_end"; t: string; turns: number };
