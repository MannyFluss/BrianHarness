/**
 * HarnessSession: the game loop. One instance per chat session.
 *   user reply -> signal sources summarise the turn window -> engagement -> FrameState
 *   -> interest map update (+autosave) -> Director plans -> state note -> backend speaks
 * Used identically by the desktop app (Electron main process) and the sim runner.
 */
import type { ChatMessage, DirectorPlan, FeatureMap, FrameState, LogEvent, TypingEvent } from "./types.js";
import { DIRECTOR_SYSTEM_PROMPT, type ModelBackend } from "./backends.js";
import { OPEN_TOPIC, planTurn, type DirectorPolicyOptions } from "./director.js";
import { estimateEngagement, textFeatures } from "./engagement.js";
import { InterestMap } from "./interest-map.js";
import { makeRng, type Rng } from "./rng.js";
import { TypingSignalSource, type SignalSource } from "./signals.js";
import { buildStateNote } from "./state-note.js";
import type { SessionStore } from "./store.js";
import { detectTopics } from "./topics.js";

export interface HarnessSessionOptions {
  userId: string;
  backend: ModelBackend;
  /** null = in-memory only (tests, sims that don't want files) */
  store?: SessionStore | null;
  /** extra sources (EEG, fake EEG); a TypingSignalSource is always present */
  sources?: SignalSource[];
  map?: InterestMap;
  clock?: () => number;
  seed?: number;
  policy?: DirectorPolicyOptions;
  /** store raw typing events in the JSONL (bigger logs, full replay) */
  logRawEvents?: boolean;
  sessionId?: string;
}

export interface DirectorTurnResult {
  text: string;
  plan: DirectorPlan;
  stateNote: string;
  genMs: number;
}

export interface UserTurnResult {
  frame: FrameState;
  hypothesis: string | null;
}

export interface HudState {
  sessionId: string;
  userId: string;
  backend: string;
  turn: number;
  frame: FrameState | null;
  plan: DirectorPlan | null;
  hypothesis: string | null;
  topTopics: Array<[string, number, number]>;
  topStyles: Array<[string, number, number]>;
}

const nowIso = () => new Date().toISOString();
const BASELINE_ALPHA = 0.3;

export class HarnessSession {
  readonly id: string;
  readonly userId: string;
  readonly typing = new TypingSignalSource();
  readonly sources: SignalSource[];
  map: InterestMap;
  frame: FrameState | null = null;
  plans: DirectorPlan[] = [];
  transcript: ChatMessage[] = [];
  turn = 0;
  promptShownAt = 0;
  private rng: Rng;
  private clock: () => number;

  constructor(private opts: HarnessSessionOptions) {
    this.userId = opts.userId;
    this.clock = opts.clock ?? Date.now;
    this.rng = makeRng(opts.seed ?? 1);
    this.id = opts.sessionId ?? opts.store?.newSessionId() ?? `mem-${Math.random().toString(36).slice(2, 8)}`;
    this.map = opts.map ?? opts.store?.loadMap(opts.userId) ?? InterestMap.fresh(opts.userId);
    this.sources = [this.typing, ...(opts.sources ?? [])];
  }

  get backend(): ModelBackend {
    return this.opts.backend;
  }

  private log(e: LogEvent) {
    this.opts.store?.append(this.id, e);
  }

  async start(): Promise<DirectorTurnResult> {
    this.map.data.sessions += 1;
    for (const s of this.sources) await s.start?.();
    this.log({ type: "session_start", t: nowIso(), sessionId: this.id, userId: this.userId, backend: this.backend.id, sources: this.sources.map((s) => `${s.id}:${s.kind}`) });
    return this.directorTurn();
  }

  /** The renderer calls this when the Director's message actually became visible. */
  markShown(t = this.clock()) {
    this.promptShownAt = t;
  }

  private async directorTurn(): Promise<DirectorTurnResult> {
    const plan = planTurn(this.turn, this.map, this.frame, this.plans, this.rng, this.opts.policy);
    const stateNote = buildStateNote(this.frame, this.map, plan);
    const messages: ChatMessage[] = [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      ...this.transcript,
      { role: "system", content: stateNote },
    ];
    const t0 = Date.now();
    const { text } = await this.backend.generate({ messages, plan, stateNote });
    const genMs = Date.now() - t0;
    this.plans.push(plan);
    this.transcript.push({ role: "assistant", content: text });
    this.log({ type: "director_turn", t: nowIso(), turn: this.turn, plan, stateNote, text, backend: this.backend.id, genMs });
    this.promptShownAt = this.clock();
    return { text, plan, stateNote, genMs };
  }

  /** Process the user's reply and its telemetry, then produce the Director's next turn. */
  async reply(text: string, events: TypingEvent[] = [], sentAt = this.clock()): Promise<{ user: UserTurnResult; director: DirectorTurnResult }> {
    const user = this.observeUser(text, events, sentAt);
    this.turn += 1;
    const director = await this.directorTurn();
    return { user, director };
  }

  private observeUser(text: string, events: TypingEvent[], sentAt: number): UserTurnResult {
    this.typing.pushMany(events);
    const window = { from: this.promptShownAt, to: sentAt };
    const features: FeatureMap = { ...textFeatures(text) };
    for (const s of this.sources) Object.assign(features, s.summarize(window));
    const { score } = estimateEngagement(features);
    const baseline = this.frame ? this.frame.baseline + BASELINE_ALPHA * (score - this.frame.baseline) : score;
    const mentioned = detectTopics(text);
    const plan = this.plans[this.plans.length - 1];
    this.frame = { turn: this.turn, engagement: score, baseline, lift: score - (this.frame?.baseline ?? score), features, mentionedTopics: mentioned, lastPlan: plan };
    this.transcript.push({ role: "user", content: text });

    // credit assignment: the probed topic(s), spontaneous mentions, and the question style
    if (plan) {
      if (plan.topic !== OPEN_TOPIC) {
        if (plan.altTopic) {
          const choseAlt = mentioned.includes(plan.altTopic) && !mentioned.includes(plan.topic);
          const choseMain = mentioned.includes(plan.topic) && !mentioned.includes(plan.altTopic);
          this.map.observeTopic(plan.topic, choseAlt ? score * 0.5 : score, choseAlt ? 0.5 : choseMain ? 1 : 0.5);
          this.map.observeTopic(plan.altTopic, choseMain ? score * 0.5 : score, choseMain ? 0.5 : choseAlt ? 1 : 0.5);
        } else {
          this.map.observeTopic(plan.topic, score, 1);
        }
      }
      this.map.observeStyle(plan.style, score, 1);
    }
    for (const t of mentioned) {
      if (t === plan?.topic || t === plan?.altTopic) continue;
      this.map.observeTopic(t, Math.min(1, score + 0.1), 0.7); // user steered there unprompted
    }
    this.map.data.turns += 1;
    this.map.data.updatedAt = nowIso();
    for (const s of this.sources) s.clear(sentAt);

    const hypothesis = this.map.hypothesis();
    this.log({
      type: "user_turn",
      t: nowIso(),
      turn: this.turn,
      text,
      features,
      engagement: score,
      baseline,
      mentionedTopics: mentioned,
      ...(this.opts.logRawEvents ? { rawEvents: events } : {}),
    });
    this.log({ type: "interest_update", t: nowIso(), turn: this.turn, topTopics: this.map.topTopics(5).map(([t, m]) => [t, m]), hypothesis });
    this.opts.store?.saveMap(this.map);
    return { frame: this.frame, hypothesis };
  }

  async end(): Promise<void> {
    for (const s of this.sources) await s.stop?.();
    this.log({ type: "session_end", t: nowIso(), turns: this.turn });
    this.opts.store?.saveMap(this.map);
  }

  hud(): HudState {
    return {
      sessionId: this.id,
      userId: this.userId,
      backend: this.backend.id,
      turn: this.turn,
      frame: this.frame,
      plan: this.plans[this.plans.length - 1] ?? null,
      hypothesis: this.map.hypothesis(),
      topTopics: this.map.topTopics(5),
      topStyles: this.map.topStyles(3),
    };
  }
}
