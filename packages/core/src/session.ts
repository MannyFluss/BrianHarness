/**
 * HarnessSession: the game loop. One instance per chat session.
 *   user reply -> signal sources summarise the turn window -> engagement -> FrameState
 *   -> interest map update (+autosave) -> Director plans -> state note -> backend speaks
 * Used identically by the desktop app (Electron main process) and the sim runner.
 */
import type { ChatMessage, DirectorPlan, ExtractorFallbackReason, ExtractorOutcomeRecord, FeatureMap, FrameState, LogEvent, RatingRecord, TypingEvent } from "./types.js";
import { DIRECTOR_SYSTEM_PROMPT, OPENER_CUE, OPENER_CUE_ID, type GenerateResult, type ModelBackend } from "./backends.js";
import { OPEN_TOPIC, baselineRotation, planBaselineTurn, planTurn, type DirectorPolicyOptions } from "./director.js";
import { estimateEngagement, eegQuality, textFeatures, type EegBlendOptions, type EngagementContext } from "./engagement.js";
import { InterestMap } from "./interest-map.js";
import { makeRng, type Rng } from "./rng.js";
import { TypingSignalSource, keyGaps, sanitizeTypingEvents, type SignalSource } from "./signals.js";
import { buildBaselineStateNote, buildStateNote } from "./state-note.js";
import type { Adaptation } from "./study.js";
import type { HarnessStorage } from "./platform/storage.js";
import { randomId, systemClock, type Clock } from "./platform/env.js";
import { createTagger, type TopicTag, type TopicTagger, type TopicTaggerSpec } from "./tagger.js";
import { finalGuesses, type FinalGuess, type FinalGuessOptions, type TurnSnapshot } from "./final-guesses.js";

export interface HarnessSessionOptions {
  userId: string;
  backend: ModelBackend;
  /** null = in-memory only (tests, sims that don't want files) */
  store?: HarnessStorage | null;
  /** extra sources (EEG, fake EEG); a TypingSignalSource is always present */
  sources?: SignalSource[];
  map?: InterestMap;
  clock?: Clock;
  seed?: number;
  policy?: DirectorPolicyOptions;
  /** EEG blending: weight, per-user z-scoring, quality / agreement weighting */
  engagement?: EegBlendOptions;
  /** topic tagger (default: offline lexicon incl. specific hobbies) */
  tagger?: TopicTagger | TopicTaggerSpec;
  /** store raw typing events in the JSONL (bigger logs, full replay) */
  logRawEvents?: boolean;
  sessionId?: string;
  /**
   * "adaptive" (default everywhere: app, sim, sidecar) or "baseline" (Phase D no-adaptation: fixed
   * topic rotation, plan-only state note, interest ledger off: updates go to an in-memory shadow
   * copy that is logged but never read by the Director and never saved). Never logged.
   */
  adaptation?: Adaptation;
  /** blinded study session: logged in session_start; plans / state notes are sealed in the log */
  study?: { id: string; index: number; total: number; scheduleHash: string; protocol?: number; reissueOf?: string; manualReissue?: true; reissueReason?: string; progressRecovered?: true };
  /** the app wanted llm-extract but could not build one (no key / mock or local model): logged as the fallback reason */
  taggerFallback?: "no_key" | "mock_or_local";
  /** called once per session per reason when the extractor is unavailable (Electron / sidecar: stderr) */
  onExtractorWarning?: (message: string, reason: ExtractorFallbackReason) => void;
}

const FALLBACK_TEXT: Record<ExtractorFallbackReason, string> = {
  no_key: "no key", mock_or_local: "mock or local model", cap_reached: "cap reached", call_failed: "calls failed", offline: "offline", not_due: "no call yet",
};
export const extractorWarningText = (r: ExtractorFallbackReason) => `Interest AI unavailable this session (${FALLBACK_TEXT[r]})`;

/**
 * director_turn reply metadata (Addendum 4). The same keys on every director_turn in every arm; null = not reported
 * (mock backend, a provider without usage). model: the model name sent (else the backend id).
 * sealed (study sessions): usage.prompt_tokens is always null. The prompt carries the state note, whose length
 * differs by arm (adaptive ~4-7 lines, baseline ~2), so its token count would identify the arm; the key stays.
 */
function replyMeta(backendId: string, g: GenerateResult | undefined, sealed: boolean) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    model: g?.model ?? backendId.replace(/^[a-z-]+:/, ""),
    max_tokens: n(g?.maxTokens),
    finish_reason: g?.finishReason ?? null,
    usage: { prompt_tokens: sealed ? null : n(g?.usage?.inputTokens), completion_tokens: n(g?.usage?.outputTokens), reasoning_tokens: n(g?.usage?.reasoningTokens) },
  };
}
/** a short code only (never err.message: an HTTP error message can quote the response body) */
/** an upstream that did not run the model: no visible text, finish "stop" or none, 0 (or unreported) completion tokens.
 *  Covers the live empty done chunk and a 200 with an empty body; never a "length" cut-off or a reply with tokens. */
const isEmptyCompletion = (g: GenerateResult) => !g.text.trim() && (g.finishReason === "stop" || g.finishReason == null) && (g.usage?.outputTokens ?? 0) === 0;
const errorCode = (err: unknown): string => {
  const e = err as { code?: unknown; name?: unknown; status?: unknown };
  if (typeof e?.code === "string" && e.code) return e.code;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "aborted";
  return typeof e?.status === "number" && Number.isInteger(e.status) ? `http_${e.status}` : "stream_error";
};

export interface DirectorTurnResult {
  text: string;
  plan: DirectorPlan;
  stateNote: string;
  genMs: number;
  /** ms from request start to the first streamed delta (undefined: not streamed) */
  firstTokenMs?: number;
  /** finish_reason "length": the reply hit max_tokens (the UI shows a "reply cut off" note) */
  truncated?: boolean;
}

/** Per-turn options: onToken receives the Director's reply incrementally. */
export interface TurnOptions {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
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
  /** blinded study session (the interest map, plan and hypothesis are withheld from the HUD) */
  study?: { index: number; total: number };
  /** non-blocking warning: the interest extractor is unavailable this session (same text in both study modes) */
  extractorWarning?: string;
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
  /** Director message fully displayed (stream end); the reply-latency clock starts here */
  promptShownAt = 0;
  /** Director message's first token displayed (telemetry only; features use promptShownAt) */
  promptFirstTokenAt: number | undefined = undefined;
  /** word counts of this user's replies so far (for the relative-length feature) */
  wordCounts: number[] = [];
  /** per-user normalisation memory for the engagement estimator */
  readonly engagementCtx: Required<Omit<EngagementContext, "options">> = { eegLnHistory: [], typingHistory: [], eegPartHistory: [], typingAtEeg: [] };
  /** per-turn hypothesis + live top-3, for the anti-drift final-guess API */
  readonly snapshots: TurnSnapshot[] = [];
  readonly tagger: TopicTagger;
  private rng: Rng;
  private clock: () => number;
  private readonly baseline: boolean;
  private rotation: string[] = [];

  constructor(private opts: HarnessSessionOptions) {
    this.userId = opts.userId;
    this.clock = opts.clock ?? systemClock;
    this.rng = makeRng(opts.seed ?? 1);
    this.id = opts.sessionId ?? opts.store?.newSessionId() ?? `mem-${randomId(6)}`;
    this.map = opts.map ?? opts.store?.loadMap(opts.userId) ?? InterestMap.fresh(opts.userId);
    this.baseline = opts.adaptation === "baseline";
    if (this.baseline) {
      // ledger off: a shadow copy takes this session's updates (logged as usual), the saved map is untouched
      this.map = InterestMap.fromJSON(JSON.parse(JSON.stringify(this.map.toJSON())));
      this.rotation = baselineRotation(makeRng(((opts.seed ?? 1) ^ 0x9e3779b9) >>> 0));
    }
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

  async start(opts: TurnOptions = {}): Promise<DirectorTurnResult> {
    this.map.data.sessions += 1;
    for (const s of this.sources) await s.start?.();
    this.checkExtractorWarning(); // started without an extractor (no key / mock or local model)
    const st = this.opts.study;
    this.log({ type: "session_start", t: nowIso(), sessionId: this.id, userId: this.userId, backend: this.backend.id, sources: this.sources.map((s) => `${s.id}:${s.kind}`), ...(st ? { study: { id: st.id, index: st.index, total: st.total, scheduleHash: st.scheduleHash, ...(st.protocol !== undefined ? { protocol: st.protocol } : {}) }, ...(st.reissueOf ? { reissueOf: st.reissueOf } : {}), ...(st.manualReissue ? { manualReissue: true } : {}), ...(st.reissueReason ? { reissueReason: st.reissueReason } : {}), ...(st.progressRecovered ? { progressRecovered: true } : {}) } : {}) });
    return this.directorTurn(opts);
  }

  /**
   * The renderer calls this when the Director's message was FULLY displayed (stream end:
   * completeAt). firstTokenAt (first token on screen) is logged only; features use completeAt so
   * streamed (desktop/iOS) and unstreamed (sim) latencies stay comparable.
   */
  markShown(completeAt = this.clock(), firstTokenAt?: number) {
    this.promptShownAt = completeAt;
    this.promptFirstTokenAt = typeof firstTokenAt === "number" && firstTokenAt <= completeAt ? firstTokenAt : undefined;
  }

  private async directorTurn(opts: TurnOptions = {}): Promise<DirectorTurnResult> {
    const plan = this.baseline ? planBaselineTurn(this.turn, this.plans, this.rotation, this.opts.policy) : planTurn(this.turn, this.map, this.frame, this.plans, this.rng, this.opts.policy);
    const stateNote = this.baseline ? buildBaselineStateNote(plan) : buildStateNote(this.frame, this.map, plan);
    // opener (no user message yet): a fixed hidden user cue, same in every arm (backends.ts OPENER_CUE)
    const openerCue = !this.transcript.some((m) => m.role === "user");
    const messages: ChatMessage[] = [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      ...this.transcript,
      { role: "system", content: stateNote },
      ...(openerCue ? [{ role: "user" as const, content: OPENER_CUE }] : []),
    ];
    const cueMeta = { opener_cue: openerCue, opener_cue_id: openerCue ? OPENER_CUE_ID : null }; // same keys on every director_turn
    const t0 = systemClock();
    let firstTokenMs: number | undefined;
    let firstTokenClock: number | undefined;
    const user = opts.onToken;
    const onToken = user
      ? (d: string) => {
          if (!d) return;
          if (firstTokenMs === undefined) {
            firstTokenMs = systemClock() - t0;
            firstTokenClock = this.clock();
          }
          try {
            user(d);
          } catch {
            /* UI callback errors never break the turn */
          }
        }
      : undefined;
    let partial = "";
    const onTokenLogged = onToken ? (d: string) => { if (d) partial += d; onToken(d); } : undefined;
    let gen: GenerateResult;
    // empty completion (stop, no content, 0 completion tokens): retried once in this same turn (turn number unchanged);
    // empty again -> a truncated director_turn {error:"empty_completion"} and the turn fails (the app's error state)
    let emptyRetryMs: number | null = null;
    const retryMeta = () => ({ empty_retries: emptyRetryMs === null ? 0 : 1, empty_retry_ms: emptyRetryMs }); // same keys on every director_turn
    try {
      gen = await this.backend.generate({ messages, plan, stateNote, onToken: onTokenLogged, signal: opts.signal });
      if (isEmptyCompletion(gen)) {
        emptyRetryMs = systemClock() - t0;
        gen = await this.backend.generate({ messages, plan, stateNote, onToken: onTokenLogged, signal: opts.signal });
      }
    } catch (err) {
      // the request / stream failed, after some text was shown (text = what the person saw) or before the first
      // token (text ""): either way one director_turn {truncated:true, finish_reason:null, error} is logged so the
      // failure is counted, then the turn fails as before. The transcript does not keep it and the turn number is
      // consumed, not retried: the person's next message is user_turn <this number>, answered by director_turn +1.
      const sealedE = !!this.opts.study;
      const shown = !!partial;
      this.log({ type: "director_turn", t: nowIso(), turn: this.turn, ...(sealedE ? { sealed: sealedE } : { plan, stateNote }), text: partial.trim(), backend: this.backend.id, genMs: systemClock() - t0,
        ...(shown ? { firstTokenMs, streamed: true as const } : {}),
        ...replyMeta(this.backend.id, { text: "", ...(err && typeof err === "object" ? { maxTokens: (err as { maxTokens?: number }).maxTokens, model: (err as { model?: string }).model } : {}) }, sealedE), truncated: true, error: errorCode(err), ...cueMeta, ...retryMeta() });
      throw err;
    }
    if (isEmptyCompletion(gen)) {
      const sealedE = !!this.opts.study;
      this.log({ type: "director_turn", t: nowIso(), turn: this.turn, ...(sealedE ? { sealed: sealedE } : { plan, stateNote }), text: "", backend: this.backend.id, genMs: systemClock() - t0,
        ...replyMeta(this.backend.id, gen, sealedE), truncated: true, error: "empty_completion", ...cueMeta, ...retryMeta() });
      throw Object.assign(new Error("The reply came back empty. Please try again."), { code: "empty_completion" });
    }
    const { text } = gen;
    const meta = replyMeta(this.backend.id, gen, !!this.opts.study);
    const truncated = meta.finish_reason === "length";
    const streamed = firstTokenMs !== undefined;
    if (user && !streamed && text) onToken!(text); // non-streaming backend: one delta with the whole text
    const genMs = systemClock() - t0;
    this.plans.push(plan);
    this.transcript.push({ role: "assistant", content: text });
    const sealed = !!this.opts.study;
    this.log({ type: "director_turn", t: nowIso(), turn: this.turn, ...(sealed ? { sealed } : { plan, stateNote }), text, backend: this.backend.id, genMs, ...(streamed ? { firstTokenMs, streamed } : {}), ...meta, truncated, ...cueMeta, ...retryMeta() });
    // server-side defaults; the renderer overrides both via markShown() with what it displayed
    this.promptShownAt = this.clock();
    this.promptFirstTokenAt = streamed ? firstTokenClock : undefined;
    return { text, plan, stateNote: sealed ? "" : stateNote, genMs, ...(streamed ? { firstTokenMs } : {}), ...(truncated ? { truncated } : {}) };
  }

  /** Process the user's reply and its telemetry, then produce the Director's next turn. */
  async reply(text: string, events: TypingEvent[] = [], sentAt = this.clock(), opts: TurnOptions = {}): Promise<{ user: UserTurnResult; director: DirectorTurnResult }> {
    const tags = await this.tagger.tag(text);
    this.checkExtractorWarning();
    const user = this.observeUser(text, sanitizeTypingEvents(events), sentAt, tags);
    this.turn += 1;
    const director = await this.directorTurn(opts);
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
    const eegOk = features["eeg.engagementIndex"] !== undefined && eegQuality(features, this.opts.engagement?.refWindowSec).quality > 0;
    this.snapshots.push({ turn: this.turn, hypothesis, top: this.map.topTopics(3), ...(eegOk ? { eegLn: Math.log(Math.max(1e-6, features["eeg.engagementIndex"]!)) } : {}) });
    this.log({
      type: "user_turn",
      t: nowIso(),
      turn: this.turn,
      text,
      features: this.loggedFeatures(features),
      engagement: score,
      baseline,
      mentionedTopics: mentioned,
      prompt: { ...(this.promptFirstTokenAt !== undefined ? { firstTokenAt: this.promptFirstTokenAt } : {}), completeAt: this.promptShownAt },
      ...(this.opts.logRawEvents ? { rawEvents: events } : {}),
      keyGaps: keyGaps(events, window),
    });
    // running top-1 label (final-guess ranking, pure: no state change) so label drift is visible per turn
    const top1 = this.finalGuesses(1)[0]?.label ?? null;
    this.log({ type: "interest_update", t: nowIso(), turn: this.turn, topTopics: this.map.topTopics(5).map(([t, m]) => [t, m]), hypothesis, top1 });
    if (!this.baseline) this.opts.store?.saveMap(this.map);
    return { frame: this.frame, hypothesis };
  }

  /** an answered (1..5) session-scope rating was logged: one of the two study-validity conditions */
  sessionRated = false;

  /** user_turn features as logged: + the extractor's logging-only features (never in frame.features / engagement) */
  private loggedFeatures(features: FeatureMap): FeatureMap {
    const x = (this.tagger as TopicTagger & { logFeatures?: () => Record<string, number> }).logFeatures?.();
    return x && Object.keys(x).length ? { ...features, ...x } : features;
  }

  async end(): Promise<void> {
    for (const s of this.sources) await s.stop?.();
    const outcome = this.extractorOutcome();
    if (outcome.fallback && outcome.fallbackReason && outcome.fallbackReason !== "not_due") this.warnExtractor(outcome.fallbackReason);
    const g = this.finalGuesses(3);
    const tg = this.tagger as TopicTagger & { model?: string; promptVersion?: string };
    this.log({
      type: "final",
      t: nowIso(),
      turns: this.turn,
      top1: g[0]?.label ?? null,
      top3: g.map((x) => x.label),
      top3Ids: g.map((x) => x.topic),
      tagger: tg.kind,
      ...(tg.promptVersion ? { extractorPromptVersion: tg.promptVersion, model: tg.model } : {}),
      ...(this.opts.study?.protocol !== undefined ? { protocol: this.opts.study.protocol } : {}),
      ...outcome,
    });
    this.log({ type: "session_end", t: nowIso(), turns: this.turn, ...outcome });
    if (!this.baseline) this.opts.store?.saveMap(this.map);
  }

  /**
   * Log one absorption rating prompt (answered or not). Evaluation only: this writes ONE log line
   * and touches nothing else (no engagement, frame, interest map, Director or state note).
   */
  logRating(r: Partial<Omit<RatingRecord, "type" | "t">>): RatingRecord {
    const v = typeof r.value === "number" && Number.isInteger(r.value) && r.value >= 1 && r.value <= 5 ? r.value : null;
    const rec: RatingRecord = {
      type: "rating",
      t: nowIso(),
      scope: r.scope === "session" ? "session" : "turn",
      turn: typeof r.turn === "number" ? r.turn : this.turn,
      value: v,
      shownAt: typeof r.shownAt === "number" ? r.shownAt : this.clock(),
      answeredAt: v !== null && typeof r.answeredAt === "number" ? r.answeredAt : null,
      dismissed: v === null ? true : !!r.dismissed,
      ...(typeof r.reason === "string" && r.reason ? { reason: r.reason.slice(0, 40) } : {}),
    };
    if (rec.scope === "session") {
      if (typeof r.hooked === "string" && r.hooked.trim()) rec.hooked = r.hooked.trim().slice(0, 2000);
      if (this.opts.study) rec.blindGuess = r.blindGuess === "adaptive" || r.blindGuess === "baseline" || r.blindGuess === "no-idea" ? r.blindGuess : null;
    }
    if (rec.scope === "session") this.sessionRated = rec.value !== null && rec.value !== undefined; // the last session rating decides
    this.log(rec);
    return rec;
  }

  /** Top-k final guesses at the user's interests (no LLM call; see final-guesses.ts). */
  finalGuesses(k = 3, opts?: FinalGuessOptions): FinalGuess[] {
    return finalGuesses(this.map, this.snapshots, k, { prior: this.tagger.rankPrior?.() ?? null, ...opts });
  }

  /** the extractor's per-session outcome so far (see ExtractorOutcomeRecord) */
  extractorOutcome(): ExtractorOutcomeRecord {
    const tg = this.tagger as TopicTagger & { outcome?: { attempted: number; ok: number; failed: number; capped: number; offline: number }; baseKind?: string };
    const o = tg.outcome;
    if (!o) {
      const fb = this.opts.taggerFallback;
      return { extractorCalls: { attempted: 0, ok: 0, failed: 0, capped: 0 }, effectiveTagger: tg.kind, fallback: !!fb, ...(fb ? { fallbackReason: fb } : {}) };
    }
    const extractorCalls = { attempted: o.attempted, ok: o.ok, failed: o.failed, capped: o.capped };
    if (o.ok > 0) return { extractorCalls, effectiveTagger: "llm-extract", fallback: false };
    const fallbackReason: ExtractorFallbackReason = o.capped ? "cap_reached" : o.failed ? "call_failed" : o.offline ? "offline" : "not_due";
    return { extractorCalls, effectiveTagger: tg.baseKind ?? "keyphrase-idf", fallback: true, fallbackReason };
  }
  /** live: the warning to show now (null while the extractor works or before its first due turn) */
  private liveExtractorReason(): ExtractorFallbackReason | null {
    const o = this.extractorOutcome();
    return o.fallback && o.fallbackReason && o.fallbackReason !== "not_due" ? o.fallbackReason : null;
  }
  private warned = new Set<string>();
  private warnExtractor(r: ExtractorFallbackReason) {
    if (this.warned.has(r)) return;
    this.warned.add(r);
    this.opts.onExtractorWarning?.(extractorWarningText(r), r);
  }
  private checkExtractorWarning() {
    const r = this.liveExtractorReason();
    if (r) this.warnExtractor(r);
  }

  hud(): HudState {
    const st = this.opts.study;
    if (st) {
      // blinded: what the Director learned / plans would reveal the mode; typing features stay. The extractor
      // warning is mode-free (the tagger runs identically in adaptive and baseline sessions).
      const r = this.liveExtractorReason();
      return {
        sessionId: this.id, userId: this.userId, backend: this.backend.id, turn: this.turn, frame: this.frame, plan: null, hypothesis: null, topTopics: [], topStyles: [],
        study: { index: st.index, total: st.total }, ...(r ? { extractorWarning: extractorWarningText(r) } : {}),
      };
    }
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
