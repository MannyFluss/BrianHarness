/** Shared contracts. Everything here is plain JSON-serialisable data. */

/** How the Director phrases its question. Scored per user like topics. */
export type QuestionStyle = "open" | "either-or" | "personal-story" | "hypothetical" | "deep-dive";
export const QUESTION_STYLES: QuestionStyle[] = ["open", "either-or", "personal-story", "hypothetical", "deep-dive"];

/** Director pacing mode, after Left 4 Dead's AI Director (build-up / peak / relax). */
export type DirectorMode = "explore" | "exploit" | "relax";

/** One raw composer event captured in the renderer. Key identity is NOT stored, only its class. */
export interface TypingEvent {
  /** ms since epoch */
  t: number;
  kind: "insert" | "delete" | "paste" | "nav" | "submit" | "focus" | "blur";
  /** length of the composer value after the event */
  len: number;
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
  updatedAt: string;
}

/** Lines written to sessions/<sessionId>.jsonl */
export type LogEvent =
  | { type: "session_start"; t: string; sessionId: string; userId: string; backend: string; sources: string[] }
  | { type: "director_turn"; t: string; turn: number; plan: DirectorPlan; stateNote: string; text: string; backend: string; genMs: number }
  | {
      type: "user_turn";
      t: string;
      turn: number;
      text: string;
      features: FeatureMap;
      engagement: number;
      baseline: number;
      mentionedTopics: string[];
      rawEvents?: TypingEvent[];
    }
  | { type: "interest_update"; t: string; turn: number; topTopics: Array<[string, number]>; hypothesis: string | null }
  | { type: "session_end"; t: string; turns: number };
