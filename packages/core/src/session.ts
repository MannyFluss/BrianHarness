/**
 * HarnessSession: the game loop. One instance per chat session.
 *   user reply -> signal sources summarise the turn window -> engagement -> FrameState
 *   -> interest map update (+autosave) -> Director plans -> state note -> backend speaks
 * Used identically by the desktop app (Electron main process) and the sim runner.
 */
import type { ChatMessage, DirectorPlan, FeatureMap, FrameState, LogEvent, TypingEvent } from "./types.js";
import { DIRECTOR_SYSTEM_PROMPT, type ModelBackend } from "./backends.js";
import { OPEN_TOPIC, planTurn, type DirectorPolicyOptions } from "./director.js";
import { estimateEngagement, eegQuality, textFeatures, type EegBlendOptions, type EngagementContext } from "./engagement.js";
import { InterestMap } from "./interest-map.js";
import { makeRng, type Rng } from "./rng.js";
import { TypingSignalSource, type SignalSource } from "./signals.js";
import { buildStateNote } from "./state-note.js";
import type { SessionStore } from "./store.js";
import { createTagger, type TopicTag, type TopicTagger, type TopicTaggerSpec } from "./tagger.js";
import { finalGuesses, type FinalGuess, type FinalGuessOptions, type TurnSnapshot } from "./final-guesses.js";

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
  /** EEG blending: weight, per-user z-scoring, quality / agreement weighting */
  engagement?: EegBlendOptions;
  /** topic tagger (default: offline lexicon incl. specific hobbies) */
  tagger?: TopicTagger | TopicTaggerSpec;
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
  /** word counts of this user's replies so far (for the relative-length feature) */
  wordCounts: number[] = [];
  /** per-user normalisation memory for the engagement estimator */
  readonly engagementCtx: Required<Omit<EngagementContext, "options">> = { eegLnHistory: [], typingHistory: [], eegPartHistory: [], typingAtEeg: [] };
  /** per-turn hypothesis + live top-3, for the anti-drift final-guess API */
  readonly snapshots: TurnSnapshot[] = [];
  readonly tagger: TopicTagger;
  private rng: Rng;
  private clock: () => number;

  constructor(private opts: HarnessSessionOptions) {
    this.userId = opts.userId;
    this.clock = opts.clock ?? Date.now;
    this.rng = makeRng(opts.seed ?? 1);
    this.id = opts.sessionId ?? opts.store?.newSessionId() ?? `mem-${Math.random().toString(36).slice(2, 8)}`;
    this.map = opts.map ?? opts.store?.loadMap(opts.userId) ?? InterestMap.fresh(opts.userId);
    this.sources = [this.typing, ...(opts.sources ?? [])];
    const t = opts.tagger;
    this.tagger = t && "tag" in t ? t : createTagger(t as TopicTaggerSpec | undefined);
  }

  get backend(): ModelBackend {
    return this.opts.backend;
  }

  /** Swap the model mid-conversation (the picker). The Director state is untouched. */
  setBackend(b: ModelBackend): void {
    this.opts.backend = b;
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
    const tags = await this.tagger.tag(text);
    const user = this.observeUser(text, events, sentAt, tags);
    this.turn += 1;
    const director = await this.directorTurn();
    return { user, director };
  }

  private observeUser(text: string, events: TypingEvent[], sentAt: number, tags: TopicTag[]): UserTurnResult {
    this.typing.pushMany(events);
    const window = { from: this.promptShownAt, to: sentAt };
    const features: FeatureMap = { ...textFeatures(text) };
    const words = features["text.words"] ?? 0;
    if (this.wordCounts.length >= 2) {
      const sorted = [...this.wordCounts].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)]!;
      features["text.relWords"] = Math.log((words + 1) / (med + 1));
    }
    this.wordCounts.push(words);
    for (const s of this.sources) Object.assign(features, s.summarize(window));
    const { score, parts } = estimateEngagement(features, { ...this.engagementCtx, options: this.opts.engagement });
    for (const [k, v] of Object.entries(parts)) if (k.startsWith("eeg") && k !== "eeg") features[`engagement.${k}`] = v;
    if (parts.eeg !== undefined) features["engagement.eegPart"] = parts.eeg;
    const ec = this.engagementCtx;
    ec.typingHistory.push(parts.typingScore!);
    if (features["eeg.engagementIndex"] !== undefined && eegQuality(features, this.opts.engagement?.refWindowSec).quality > 0) {
      ec.eegLnHistory.push(Math.log(Math.max(1e-6, features["eeg.engagementIndex"]!)));
      ec.eegPartHistory.push(parts.eeg!);
      ec.typingAtEeg.push(parts.typingScore!);
    }
    const baseline = this.frame ? this.frame.baseline + BASELINE_ALPHA * (score - this.frame.baseline) : score;
    for (const t of tags) if (t.id.includes(":")) this.map.defineTopic(t.id, t.label, t.parent);
    const mentioned = tags.map((t) => t.id);
    const plan = this.plans[this.plans.length - 1];
    this.frame = { turn: this.turn, engagement: score, baseline, lift: score - (this.frame?.baseline ?? score), features, mentionedTopics: mentioned, lastPlan: plan };
    this.transcript.push({ role: "user", content: text });

    // credit assignment: the probed topic(s), spontaneous mentions, and the question style
    const obs: Array<[string, number, number]> = [];
    const observe = (t: string, v: number, w: number) => {
      this.map.observeTopic(t, v, w);
      obs.push([t, v, w]);
    };
    if (plan) {
      if (plan.topic !== OPEN_TOPIC) {
        if (plan.altTopic) {
          const choseAlt = mentioned.includes(plan.altTopic) && !mentioned.includes(plan.topic);
          const choseMain = mentioned.includes(plan.topic) && !mentioned.includes(plan.altTopic);
          observe(plan.topic, choseAlt ? score * 0.5 : score, choseAlt ? 0.5 : choseMain ? 1 : 0.5);
          observe(plan.altTopic, choseMain ? score * 0.5 : score, choseMain ? 0.5 : choseAlt ? 1 : 0.5);
        } else {
          observe(plan.topic, score, 1);
        }
      }
      // forced scouting turns probe topics the user likely doesn't care about; don't let that
      // low engagement count against the question style that carried them
      if (!plan.scout) this.map.observeStyle(plan.style, score, 1);
    }
    for (const tag of tags) {
      const t = tag.id;
      if (t === plan?.topic || t === plan?.altTopic) continue;
      observe(t, Math.min(1, score + 0.1), tag.observeWeight ?? 0.7); // user steered there unprompted
    }
    // Roll child evidence (specific hobbies, keyphrases) up to ancestors that weren't credited
    // directly this turn, once per ancestor (strongest child wins), so the parent accumulates it.
    const direct = new Set(obs.map(([t]) => t));
    const rolled = new Map<string, [number, number]>();
    for (const [t, v, w] of obs) {
      let p = this.map.parent(t);
      for (let i = 0; p && i < 4; i++, p = this.map.parent(p)) {
        if (direct.has(p)) break;
        const cur = rolled.get(p);
        if (!cur || w > cur[1] || (w === cur[1] && v > cur[0])) rolled.set(p, [v, w]);
      }
    }
    for (const [p, [v, w]] of rolled) this.map.observeTopic(p, v, w);
    this.map.data.turns += 1;
    this.map.data.updatedAt = nowIso();
    for (const s of this.sources) s.clear(sentAt);

    const hypothesis = this.map.hypothesis();
    this.snapshots.push({ turn: this.turn, hypothesis, top: this.map.topTopics(3) });
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

  /** Top-k final guesses at the user's interests (no LLM call; see final-guesses.ts). */
  finalGuesses(k = 3, opts?: FinalGuessOptions): FinalGuess[] {
    return finalGuesses(this.map, this.snapshots, k, opts);
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
