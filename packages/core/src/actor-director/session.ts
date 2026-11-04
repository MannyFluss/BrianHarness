/**
 * E3: the Actor/Director loop (mock backends in Phase 1).
 *
 *   start()                  session_start
 *   opener()                 Actor turn 0 (OPENER_CUE, never a Director note before it)
 *   observeReading(...)      the reading window of aT closed: attention_digest (from E5's GazeSource)
 *   beginDirector()          start the Director call for request turn T+1 (idempotent; the app may call it at
 *                            composer focus; send() calls it at the latest)
 *   send(text)               user_turn uT; hold <= DIRECTOR_HOLD_MS for the Director; rails; inject / shadow;
 *                            Actor request a(T+1) (context_share, actor_turn); leak checks; note outcomes
 *   end(reason)              pending notes dropped (session_end), last outcome, session_share, session_end
 *
 * The Director runs in every arm (timing parity): arm "on" injects a rail-passing note with p_inject (default 0.5),
 * else shadow; "shadow" / "off" always shadow. Blinded sessions get the redacted main log from AdSessionLog.
 * Leak breaker: 1 safety leak after an injected note = flag (note_outcome, sealed in blinded sessions);
 * 2 = health director.leak_breaker and every later note is blocked (rail leak_breaker).
 */
import { DIRECTOR_HOLD_MS, SAFETY_LEAKS, noteKind } from "../ad-contracts/index.js";
import type { Arm, AttentionEvent, BhAdEventBody, DirectorFootprint, DirectorNote, HealthCode, ReadingDigest, SessionType, Usage } from "../ad-contracts/index.js";
import { OPENER_CUE } from "../backends.js";
import { makeRng, type Rng } from "../rng.js";
import { sha256HexSync } from "../study.js";
import { ACTOR_PROMPT_ID, buildActorRequest } from "./actor.js";
import { callDirector, workerErrorHealth, type AdChatBackend, type DirectorCallResult } from "./director.js";
import { DIRECTOR_ASSEMBLED_SHA8, DIRECTOR_EXAMPLES_SLOT, DIRECTOR_FORMAT_SLOT, DIRECTOR_INPUT_CAP, DIRECTOR_MAX_TOKENS, DIRECTOR_MODEL, DIRECTOR_PROMPT_ID, assembleDirectorSystem, sha8, slotTokens, sumSlots } from "./director-prompt.js";
import { invalidEventIds, renderDirectorInput, type ChatTurn, type DigestInput } from "./digest.js";
import { checkLeaks, MockLeakJudge, wordsOf, stem, type LeakJudge, type LeakResult } from "./leaks.js";
import type { AdSessionLog } from "./log.js";
import { runRails } from "./rails.js";
import { ContextShareTracker, type HistoryMessage } from "./share.js";
import type { TokenCounter } from "./tokenizer.js";

export const PIPELINE_VERSION = "adp1-e3";
export const ACTOR_MODEL = "gpt-oss:120b-cloud";
export const ACTOR_MAX_TOKENS = 1024;

export interface AdSessionOptions {
  log: AdSessionLog;
  userId: string;
  sessionType: SessionType;
  arm: Arm;
  pInject?: number;
  blind?: { index: number; total: number; scheduleHash: string };
  actor: AdChatBackend;
  director: AdChatBackend;
  judge?: LeakJudge;
  counter: TokenCounter;
  consent: { camera: boolean; rawGaze: boolean };
  gaze?: Extract<BhAdEventBody, { type: "session_start" }>["gaze"];
  device?: Extract<BhAdEventBody, { type: "session_start" }>["device"];
  /** local switch AND remote flag; read before every call and again at decision time */
  directorEnabled?: () => boolean;
  holdMs?: number;
  seed?: number;
  sleep?: (ms: number) => Promise<void>;
  models?: { actor: string; director: string };
}

interface Pending {
  turn: number;
  startedMono: number;
  promise: Promise<DirectorCallResult>;
  input: string;
  inputTokens: number;
  bySlot: { system: number; format: number; examples: number; digest: number };
  assembledSha8: string;
  invalid: Set<string>;
  footprint: DirectorFootprint;
  settled: DirectorCallResult | null;
}
interface NoteRecord {
  note_id: string; turn: number; note: DirectorNote; decision: "inject" | "shadow" | "blocked"; actor_text: string | null;
  followed: boolean | null; next_dwell_ratio: number | null; reply?: string; leaks?: LeakResult; used?: number; outcomeDone?: boolean;
}

export class ActorDirectorSession {
  readonly tracker: ContextShareTracker;
  private turn = -1;
  private chat: ChatTurn[] = [];
  private history: HistoryMessage[] = [];
  private digest: ReadingDigest | null = null;
  private events: AttentionEvent[] = [];
  private faceFrac: number | null = null;
  private baselineParagraphs = 0;
  private ledger: string[] = [];
  private pending: Pending | null = null;
  private notes: NoteRecord[] = [];
  private lastActorNote: NoteRecord | null = null;
  private safetyLeaks = 0;
  private breakerTripped = false;
  private directorCapped = false;
  private rng: Rng;
  private sleep: (ms: number) => Promise<void>;
  private judge: LeakJudge;
  private holdMs: number;
  private pInject: number;
  readonly models: { actor: string; director: string };

  constructor(private o: AdSessionOptions) {
    this.tracker = new ContextShareTracker(o.counter);
    this.rng = makeRng(o.seed ?? 1);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.judge = o.judge ?? new MockLeakJudge();
    this.holdMs = Math.min(o.holdMs ?? DIRECTOR_HOLD_MS, DIRECTOR_HOLD_MS);
    this.pInject = o.pInject ?? (o.arm === "on" ? 0.5 : 0);
    this.models = o.models ?? { actor: ACTOR_MODEL, director: DIRECTOR_MODEL };
  }
  private emit(b: BhAdEventBody) { return this.o.log.emit(b); }
  private mono() { return this.o.log.clock.mono(); }
  private enabled() { return this.o.directorEnabled ? this.o.directorEnabled() : true; }
  get currentTurn() { return this.turn; }
  get noteRecords(): readonly NoteRecord[] { return this.notes; }

  start(): void {
    const tabVisible = this.o.sessionType === "tab_visible";
    this.emit({
      type: "session_start", profile: "actor-director", contract: "contract-v1.1", userId: this.o.userId, session_type: this.o.sessionType,
      tab: tabVisible ? "visible" : "hidden", arm: this.o.arm, p_inject: this.pInject, ...(tabVisible ? {} : { sealed: true as const, ...(this.o.blind ? { blind: this.o.blind } : {}) }),
      actor_prompt_id: ACTOR_PROMPT_ID, director_prompt_id: DIRECTOR_PROMPT_ID, director_format_id: DIRECTOR_FORMAT_SLOT.id,
      director_examples_id: DIRECTOR_EXAMPLES_SLOT.id, director_assembled_sha8: DIRECTOR_ASSEMBLED_SHA8, pipeline_version: PIPELINE_VERSION,
      tokenizer: "o200k_base", models: this.models, consent: this.o.consent,
      gaze: this.o.gaze ?? { tracker: "none", permission: "prompt" },
      device: this.o.device ?? { deviceModel: "sim", platform: "web", orientation: "portrait", widthPt: 390, heightPt: 844 },
      director_enabled: this.enabled(),
    });
    if (!this.enabled()) this.emit({ type: "health", check: "director.enabled", ok: false, code: "director.kill_switch" });
  }

  async opener(): Promise<string> { return this.actorTurn(null, null); }

  /** the reading window of the latest Actor message closed (E5 provides the digest + events) */
  observeReading(r: { digest: ReadingDigest; events: AttentionEvent[]; faceFrac?: number | null; baselineParagraphs?: number; ledger?: string[] }): void {
    this.digest = r.digest; this.events = r.events; this.faceFrac = r.faceFrac ?? null;
    if (r.baselineParagraphs !== undefined) this.baselineParagraphs = r.baselineParagraphs;
    if (r.ledger) this.ledger = r.ledger;
    this.emit({ type: "attention_digest", turn: this.turn, msg: r.digest.msg, digest: r.digest, events: r.events });
    // next-dwell outcome for the note that shaped this Actor message
    const n = this.lastActorNote;
    if (n && n.next_dwell_ratio === null && r.digest.msg === `a${n.turn}` && r.digest.paras.length) n.next_dwell_ratio = round2(r.digest.paras.reduce((s, p) => s + p.ratio, 0) / r.digest.paras.length);
  }

  footprint(): DirectorFootprint {
    const inj = this.notes.filter((n) => n.decision === "inject").length;
    return {
      actor_turns: this.turn + 1, notes_injected: inj, notes_shadowed: this.notes.filter((n) => n.decision === "shadow").length,
      notes_blocked: this.notes.filter((n) => n.decision === "blocked").length,
      session_share: round4(this.tracker.sessionShare), session_dynamic_share: round4(this.tracker.sessionDynamicShare),
      recent: this.notes.slice(-3).map((n) => ({ note_id: n.note_id, turn: n.turn, kind: noteKind(n.note), move: n.note.suggestion?.move ?? null, decision: n.decision, followed: n.followed, next_dwell_ratio: n.next_dwell_ratio })),
    };
  }

  /** start the Director call for the next Actor request (turn + 1). No-op before the opener, when disabled or capped. */
  beginDirector(): void {
    if (this.turn < 0 || this.pending?.turn === this.turn + 1 || !this.enabled() || this.directorCapped) return;
    const counter = (t: string) => this.tracker.tokens(t);
    const footprint = this.footprint();
    const d: DigestInput = { chat: this.chat, digest: this.digest, events: this.events, faceFrac: this.faceFrac, baselineParagraphs: this.baselineParagraphs, ledger: this.ledger, footprint };
    // input cap: drop the examples slot first, then the oldest chat lines, then the ledger
    let withExamples = true, drop = 0, keepLedger = true;
    let input = renderDirectorInput(d);
    let bySlot = slotTokens(counter, input, withExamples);
    while (sumSlots(bySlot) > DIRECTOR_INPUT_CAP) {
      if (withExamples) withExamples = false;
      else if (drop < this.chat.length) drop++;
      else if (keepLedger) keepLedger = false;
      else break;
      input = renderDirectorInput(d, drop, keepLedger);
      bySlot = slotTokens(counter, input, withExamples);
    }
    const system = assembleDirectorSystem(withExamples);
    const p: Pending = {
      turn: this.turn + 1, startedMono: this.mono(), input, inputTokens: sumSlots(bySlot), bySlot, assembledSha8: sha8(system),
      invalid: invalidEventIds(d), footprint, settled: null,
      promise: null as never,
    };
    p.promise = callDirector(this.o.director, this.models.director, DIRECTOR_MAX_TOKENS, system, input, () => this.mono()).then((r) => (p.settled = r));
    this.pending = p;
  }

  private logDirectorCall(p: Pending, r: DirectorCallResult, deadlineMissed: boolean) {
    this.emit({
      type: "director_call", turn: p.turn, msg: `a${p.turn - 1}`, input_sha256: sha256HexSync(p.input), input_tokens: p.inputTokens, model: this.models.director,
      genMs: Math.round(r.genMs), usage: r.usage, footprint: p.footprint, repaired: r.repaired, deadline_missed: deadlineMissed, output: r.output,
      ...(r.error ? { error: r.error } : {}), assembled_prompt_sha8: p.assembledSha8, input_tokens_by_slot: p.bySlot,
    });
    if (r.health) {
      this.emit(r.health);
      if (r.health.code === "budget.director_cap") this.directorCapped = true;
    }
  }

  /** the person sends uT; returns the Actor's reply a(T+1) */
  async send(text: string): Promise<string> {
    const sentAt = this.mono();
    this.beginDirector();
    const p = this.pending;
    let actorText: string | null = null, noteId: string | null = null;
    if (p) {
      const waited = await Promise.race([p.promise.then(() => true), this.sleep(Math.max(0, this.holdMs - (this.mono() - sentAt))).then(() => false)]);
      const hold = Math.round(this.mono() - sentAt);
      this.emit({ type: "user_turn", turn: this.turn, msg: `u${this.turn}`, text, sentAt, hold_ms: Math.min(hold, this.holdMs) });
      this.pending = null;
      if (!waited || !p.settled) {
        this.emit({ type: "health", check: "director.deadline", ok: false, code: "director.timeout" });
        void p.promise.then((r) => { this.logDirectorCall(p, r, true); if (r.output?.note) this.emit({ type: "note_dropped", turn: p.turn, note_id: r.output.note.id, reason: "late" }); });
      } else {
        const r = p.settled;
        this.logDirectorCall(p, r, false);
        const decided = this.decide(p, r);
        actorText = decided?.actorText ?? null; noteId = decided?.noteId ?? null;
      }
    } else {
      this.emit({ type: "user_turn", turn: this.turn, msg: `u${this.turn}`, text, sentAt, hold_ms: 0 });
    }
    this.chat.push({ id: `u${this.turn}`, role: "user", text });
    this.closeOutcome(text);
    return this.actorTurn(text, actorText, noteId);
  }

  private decide(p: Pending, r: DirectorCallResult): { actorText: string; noteId: string } | null {
    if (!r.output?.note) return null;
    const rails = runRails(r.output, {
      input: p.input, previousActorTexts: this.notes.filter((n) => n.decision !== "blocked" && n.actor_text).slice(-2).map((n) => n.actor_text!),
      directorEnabled: this.enabled(), cameraConsent: this.o.consent.camera, invalidEventIds: p.invalid, leakBreakerTripped: this.breakerTripped,
    });
    const note = r.output.note;
    this.emit({ type: "rail_check", turn: p.turn, note_id: note.id, pass: rails.pass, blocked_by: rails.blocked_by, ...(rails.hits.length ? { hits: rails.hits.slice(0, 12) } : {}) });
    if (!rails.pass || !rails.actor_text) { this.notes.push({ note_id: note.id, turn: p.turn, note, decision: "blocked", actor_text: rails.actor_text, followed: null, next_dwell_ratio: null }); return null; }
    const inject = this.o.arm === "on" && this.rng() < this.pInject;
    const decision = inject ? "inject" : "shadow";
    const tf: Record<string, number> = {};
    for (const id of note.evidence) { const e = this.events.find((x) => x.id === id); if (e) { if (e.z !== null) tf[`${id}.z`] = e.z; tf[`${id}.conf`] = e.conf; } }
    this.emit({ type: "injection", turn: p.turn, note_id: note.id, decision, kind: noteKind(note), ...(note.suggestion ? { move: note.suggestion.move } : {}), actor_text: rails.actor_text, evidence: note.evidence, trigger_features: tf, confidence: note.confidence });
    const rec: NoteRecord = { note_id: note.id, turn: p.turn, note, decision, actor_text: rails.actor_text, followed: null, next_dwell_ratio: null };
    this.notes.push(rec);
    this.lastActorNote = rec;
    return inject ? { actorText: rails.actor_text, noteId: note.id } : null;
  }

  private async actorTurn(user: string | null, actorText: string | null, noteId: string | null = null): Promise<string> {
    const turn = ++this.turn;
    const req = buildActorRequest(this.history, user, actorText);
    const t0 = this.mono();
    let text = "", usage: Usage = { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null }, finish: string | null = null, error: HealthCode | undefined;
    try {
      const r = await this.o.actor.complete({ role: "actor", model: this.models.actor, messages: req.messages, maxTokens: ACTOR_MAX_TOKENS });
      text = r.text; usage = r.usage; finish = r.finishReason;
      if (!text.trim()) error = "model.empty_completion"; else if (finish === "length") error = "model.length_cutoff";
    } catch (err) {
      const h = workerErrorHealth(err, "actor");
      if (h) this.emit(h);
      error = h?.code ?? "net.worker_unreachable";
    }
    this.emit(this.tracker.measure(turn, noteId, user === null, req.parts, usage.prompt_tokens));
    this.emit({
      type: "actor_turn", turn, msg: `a${turn}`, text, model: this.models.actor, genMs: Math.round(this.mono() - t0), firstTokenMs: null, usage, finish_reason: finish,
      opener_cue: user === null, ...(error ? { error } : {}), note_id: noteId, actor_request_sha256: req.sha256,
    });
    if (text) {
      this.chat.push({ id: `a${turn}`, role: "assistant", text });
      this.history.push(...(user === null ? [] : [{ role: "user" as const, text: user }]), { role: "assistant", text, noteId });
    } else if (user !== null) this.history.push({ role: "user", text: user });
    // leak checks on the reply that followed a note (injected or shadowed: shadow is the no-hint control)
    const rec = this.notes.find((n) => n.turn === turn && n.decision !== "blocked");
    if (rec && text) {
      rec.reply = text;
      rec.leaks = await this.leakCheck({ text, context: user ?? OPENER_CUE, note: rec.actor_text ?? "" });
      rec.used = usedFraction(rec, text);
      rec.followed = rec.note.suggestion ? rec.used >= 0.5 : null;
      if (rec.decision === "inject") {
        const safety = rec.leaks.codes.filter((c) => SAFETY_LEAKS.includes(c)).length;
        if (safety) {
          this.safetyLeaks++;
          if (this.safetyLeaks >= 2 && !this.breakerTripped) { this.breakerTripped = true; this.emit({ type: "health", check: "director.leak_breaker", ok: false, code: "director.leak_breaker" }); }
        }
      }
    }
    return text;
  }

  private async leakCheck(input: { text: string; context: string; note: string }): Promise<LeakResult> {
    try { return await checkLeaks(input, this.judge); } catch (err) {
      const h = workerErrorHealth(err, "judge");
      if (h) this.emit(h);
      return checkLeaks(input, new MockLeakJudge()); // fallback, logged by the health line above
    }
  }

  /** note_outcome for the note behind the latest Actor message, once the person's next message is known */
  private closeOutcome(nextUser: string | null) {
    const rec = this.notes.find((n) => n.turn === this.turn && n.decision !== "blocked" && !n.outcomeDone);
    if (!rec) return;
    rec.outcomeDone = true;
    this.emit({
      type: "note_outcome", turn: rec.turn, note_id: rec.note_id, decision: rec.decision as "inject" | "shadow", used: rec.used ?? 0, followed: rec.followed,
      answered_first: rec.leaks?.answeredFirst ?? null, leaks: rec.leaks?.codes ?? [], leak_source: rec.leaks?.leak_source ?? "regex",
      next_dwell_ratio: rec.next_dwell_ratio, next_rating: null, pushback: nextUser === null ? null : PUSHBACK.test(nextUser),
    });
  }

  async end(reason: "user" | "new_chat" | "error" | "replay_end" = "user"): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (p) {
      const r = p.settled ?? (await Promise.race([p.promise, this.sleep(this.holdMs).then(() => null)]));
      if (r) { this.logDirectorCall(p, r, false); if (r.output?.note) this.emit({ type: "note_dropped", turn: p.turn, note_id: r.output.note.id, reason: "session_end" }); }
    }
    this.closeOutcome(null);
    const blocked = this.notes.filter((n) => n.decision === "blocked").length, shadow = this.notes.filter((n) => n.decision === "shadow").length;
    this.emit(this.tracker.summary({ shadow_notes: shadow, blocked_notes: blocked }));
    this.emit({ type: "session_end", turns: this.turn + 1, reason });
  }
}

const PUSHBACK = /\b(?:stop|enough|no more|not interested|don['’]?t (?:want|care)|i didn['’]?t ask|why are you|move on|change the subject|that['’]?s not what i)\b/i;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;
function usedFraction(rec: NoteRecord, reply: string): number {
  const nw = new Set(wordsOf(`${rec.note.observation ?? ""} ${rec.note.suggestion?.text ?? ""} ${rec.note.suggestion?.target ?? ""}`).filter((w) => w.length > 3).map(stem));
  if (!nw.size) return 0;
  const rw = new Set(wordsOf(reply).map(stem));
  return round2([...nw].filter((w) => rw.has(w)).length / nw.size);
}
