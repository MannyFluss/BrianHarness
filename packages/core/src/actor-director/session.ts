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
 * Leak-judge set (contract-v1.2): the pre-display leak gate. For EVERY rail-passing note, in every arm and session
 * type, the Actor is asked twice in parallel (plain request, and the as-if-injected request) and the as-if-injected
 * reply goes through LeakGate (regex, then the judge route) under the same LEAK_JUDGE_DEADLINE_MS. So shadow and
 * inject turns make the same calls and wait the same way (timing parity). The as-if-injected reply is displayed only
 * when the arm injects AND the verdict is pass; otherwise the plain reply is shown. Any verdict but pass (flagged,
 * uncertain, timeout, error) drops the note (fail safe): leak_judge + note_dropped reason "leak_judge", both
 * sealed-only, and counts toward the leak breaker (2 = health director.leak_breaker, every later note blocked).
 * Without a gate (leakGate: null, E3 behaviour): 1 safety leak after an injected note = flag, 2 = breaker.
 */
import { DIRECTOR_HOLD_MS, SAFETY_LEAKS, noteKind } from "../ad-contracts/index.js";
import type { Arm, AttentionEvent, BhAdEventBody, DirectorFootprint, DirectorNote, DirectorOutput, HealthCode, RailCode, ReadingDigest, SessionType, Usage } from "../ad-contracts/index.js";
import { OPENER_CUE } from "../backends.js";
import { makeRng, type Rng } from "../rng.js";
import { sha256HexSync } from "../study.js";
import { ACTOR_PROMPT_ID, buildActorRequest } from "./actor.js";
import { callDirector, workerErrorHealth, type AdChatBackend, type DirectorCallResult } from "./director.js";
import { DIRECTOR_ASSEMBLED_SHA8, DIRECTOR_EXAMPLES_SLOT, DIRECTOR_FORMAT_SLOT, DIRECTOR_INPUT_CAP, DIRECTOR_MAX_TOKENS, DIRECTOR_MODEL, DIRECTOR_PROMPT_ID, assembleDirectorSystem, sha8, slotTokens, sumSlots } from "./director-prompt.js";
import { invalidEventIds, renderDirectorInput, type ChatTurn, type DigestInput } from "./digest.js";
import { checkLeaks, MockLeakJudge, wordsOf, stem, type LeakJudge, type LeakResult } from "./leaks.js";
import { LEAK_JUDGE_DEADLINE_MS, LeakGate, MockJudgeBackend, replySha256, type GateResult } from "./leak-judge.js";
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
  /** the pre-display leak gate; default LeakGate over MockJudgeBackend (judge route). null = no gate (E3 behaviour) */
  leakGate?: LeakGate | null;
  /** judge backend for the default gate (e.g. WorkerChatBackend: X-BH-Role judge); default MockJudgeBackend */
  judgeBackend?: AdChatBackend;
  /** tests only: a shorter judge deadline, capped at LEAK_JUDGE_DEADLINE_MS; the same value for every arm */
  judgeDeadlineMs?: number;
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
  /** leak-judge set: dropped by the pre-display gate (decision then reads "blocked") */
  dropped?: boolean; armDecision?: "inject" | "shadow";
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
  readonly gate: LeakGate | null;
  readonly models: { actor: string; director: string };

  constructor(private o: AdSessionOptions) {
    this.tracker = new ContextShareTracker(o.counter);
    this.rng = makeRng(o.seed ?? 1);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.judge = o.judge ?? new MockLeakJudge();
    this.holdMs = Math.min(o.holdMs ?? DIRECTOR_HOLD_MS, DIRECTOR_HOLD_MS);
    this.pInject = o.pInject ?? (o.arm === "on" ? 0.5 : 0);
    this.models = o.models ?? { actor: ACTOR_MODEL, director: DIRECTOR_MODEL };
    this.gate = o.leakGate === null ? null : o.leakGate ?? new LeakGate({
      backend: o.judgeBackend ?? new MockJudgeBackend(), actorModel: this.models.actor,
      deadlineMs: Math.min(o.judgeDeadlineMs ?? LEAK_JUDGE_DEADLINE_MS, LEAK_JUDGE_DEADLINE_MS),
    });
  }
  private emit(b: BhAdEventBody) { return this.o.log.emit(b); }
  private mono() { return this.o.log.clock.mono(); }
  private enabled() { return this.o.directorEnabled ? this.o.directorEnabled() : true; }
  get currentTurn() { return this.turn; }
  get noteRecords(): readonly NoteRecord[] { return this.notes; }

  start(): void {
    const tabVisible = this.o.sessionType === "tab_visible";
    this.emit({
      type: "session_start", profile: "actor-director", contract: "contract-v1.2", userId: this.o.userId, session_type: this.o.sessionType,
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

  /**
   * E6 (tab_visible only): the Director call in flight for the next Actor request, for the tab's "considered" card
   * and the injection animation (a rail-passing note waits at the composer until Send). Logs nothing; the decision
   * (rails at decision time, inject vs shadow) is still made and logged by send(). Always null in blinded sessions.
   */
  peekPending(): { turn: number; settled: boolean; output: DirectorOutput | null; rails: { pass: boolean; blocked_by: RailCode[]; actor_text: string | null } | null } | null {
    const p = this.pending;
    if (!p || this.o.sessionType !== "tab_visible") return null;
    const out = p.settled?.output ?? null;
    const rails = out?.note ? runRails(out, {
      input: p.input, previousActorTexts: this.notes.filter((n) => n.decision !== "blocked" && n.actor_text).slice(-2).map((n) => n.actor_text!),
      directorEnabled: this.enabled(), cameraConsent: this.o.consent.camera, invalidEventIds: p.invalid, leakBreakerTripped: this.breakerTripped,
    }) : null;
    return { turn: p.turn, settled: !!p.settled, output: out, rails: rails ? { pass: rails.pass, blocked_by: rails.blocked_by, actor_text: rails.actor_text } : null };
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
    let actorText: string | null = null, noteId: string | null = null, gated: NoteRecord | null = null;
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
        if (decided && this.gate) gated = decided.rec;
        else if (decided?.inject) { actorText = decided.rec.actor_text; noteId = decided.rec.note_id; }
      }
    } else {
      this.emit({ type: "user_turn", turn: this.turn, msg: `u${this.turn}`, text, sentAt, hold_ms: 0 });
    }
    this.chat.push({ id: `u${this.turn}`, role: "user", text });
    this.closeOutcome(text);
    return gated ? this.gatedActorTurn(text, gated) : this.actorTurn(text, actorText, noteId);
  }

  private decide(p: Pending, r: DirectorCallResult): { rec: NoteRecord; inject: boolean } | null {
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
    const rec: NoteRecord = { note_id: note.id, turn: p.turn, note, decision, armDecision: decision, actor_text: rails.actor_text, followed: null, next_dwell_ratio: null };
    this.notes.push(rec);
    this.lastActorNote = rec;
    return { rec, inject };
  }

  private async callActor(req: ReturnType<typeof buildActorRequest>) {
    const t0 = this.mono();
    try {
      const r = await this.o.actor.complete({ role: "actor", model: this.models.actor, messages: req.messages, maxTokens: ACTOR_MAX_TOKENS });
      return { ok: true as const, r, ms: this.mono() - t0 };
    } catch (err) { return { ok: false as const, err, ms: this.mono() - t0 }; }
  }

  private countBreaker() {
    this.safetyLeaks++;
    if (this.safetyLeaks >= 2 && !this.breakerTripped) { this.breakerTripped = true; this.emit({ type: "health", check: "director.leak_breaker", ok: false, code: "director.leak_breaker" }); }
  }

  /**
   * a turn with a rail-passing note (inject OR shadow): plain + as-if-injected Actor requests in parallel, the gate on
   * the as-if-injected reply (same deadline in every arm), then display. Same calls and waits in every arm.
   */
  private async gatedActorTurn(user: string, rec: NoteRecord): Promise<string> {
    const turn = this.turn + 1;
    const inject = rec.decision === "inject";
    const plainReq = buildActorRequest(this.history, user, null), candReq = buildActorRequest(this.history, user, rec.actor_text);
    const [plain, cand] = await Promise.all([this.callActor(plainReq), this.callActor(candReq)]);
    const candText = cand.ok ? cand.r.text : "";
    let g: GateResult;
    if (cand.ok && candText.trim()) g = await this.gate!.check({ text: candText, context: user, note: rec.actor_text ?? "" });
    else g = { verdict: "uncertain", status: "error", regex: [], uncertain: [], judge: null, codes: [], answered_first: null, ms: 0, hits: [] };
    const dropped = g.verdict !== "pass";
    this.emit({
      type: "leak_judge", turn, note_id: rec.note_id, decision: inject ? "inject" : "shadow", judge_prompt_id: this.gate!.promptId, model: this.gate!.model,
      deadline_ms: this.gate!.deadlineMs, ms: g.ms, status: g.status, regex: g.regex, uncertain: g.uncertain, judge: g.judge, codes: g.codes,
      answered_first: g.answered_first, verdict: g.verdict, dropped, reply_sha256: cand.ok ? replySha256(candText) : null, ...(g.error ? { error: g.error } : {}),
    });
    if (g.error === "budget.judge_cap") this.emit({ type: "health", check: "budget", ok: false, code: "budget.judge_cap", role: "judge", worker_code: "role_cap_judge", http_status: 429 });
    if (dropped) {
      this.emit({ type: "note_dropped", turn, note_id: rec.note_id, reason: "leak_judge" });
      rec.dropped = true; rec.decision = "blocked";
      if (this.lastActorNote === rec) this.lastActorNote = null;
      this.countBreaker();
    }
    const show = inject && !dropped;
    const shown = show ? { res: cand, req: candReq } : { res: plain, req: plainReq };
    // health for every failed Actor call of the turn (both requests are made in every arm), once per code
    const seen = new Set<string>();
    for (const x of [plain, cand]) if (!x.ok) { const h = workerErrorHealth(x.err, "actor"); if (h && !seen.has(h.code ?? "")) { seen.add(h.code ?? ""); this.emit(h); } }
    const text = await this.finishActorTurn(user, shown.req, shown.res, show ? rec.note_id : null);
    if (!dropped && text) {
      rec.reply = text;
      // inject: the gate already judged the displayed reply; shadow: post-hoc check of the plain reply (no-hint control)
      rec.leaks = show ? gateAsLeakResult(g) : await this.leakCheck({ text, context: user, note: rec.actor_text ?? "" });
      rec.used = usedFraction(rec, text);
      rec.followed = rec.note.suggestion ? rec.used >= 0.5 : null;
    }
    return text;
  }

  private async actorTurn(user: string | null, actorText: string | null, noteId: string | null = null): Promise<string> {
    const req = buildActorRequest(this.history, user, actorText);
    const res = await this.callActor(req);
    if (!res.ok) { const h = workerErrorHealth(res.err, "actor"); if (h) this.emit(h); }
    const text = await this.finishActorTurn(user, req, res, noteId);
    const turn = this.turn;
    if (this.gate) return text;
    // no gate (E3): leak checks on the reply that followed a note (injected or shadowed: shadow is the no-hint control)
    const rec = this.notes.find((n) => n.turn === turn && n.decision !== "blocked");
    if (rec && text) {
      rec.reply = text;
      rec.leaks = await this.leakCheck({ text, context: user ?? OPENER_CUE, note: rec.actor_text ?? "" });
      rec.used = usedFraction(rec, text);
      rec.followed = rec.note.suggestion ? rec.used >= 0.5 : null;
      if (rec.decision === "inject" && rec.leaks.codes.some((c) => SAFETY_LEAKS.includes(c))) this.countBreaker();
    }
    return text;
  }

  /** log context_share + actor_turn for the displayed request, update the chat history */
  private async finishActorTurn(user: string | null, req: ReturnType<typeof buildActorRequest>, res: Awaited<ReturnType<ActorDirectorSession["callActor"]>>, noteId: string | null): Promise<string> {
    const turn = ++this.turn;
    let text = "", usage: Usage = { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null }, finish: string | null = null, error: HealthCode | undefined;
    if (res.ok) {
      text = res.r.text; usage = res.r.usage; finish = res.r.finishReason;
      if (!text.trim()) error = "model.empty_completion"; else if (finish === "length") error = "model.length_cutoff";
    } else error = workerErrorHealth(res.err, "actor")?.code ?? "net.worker_unreachable";
    this.emit(this.tracker.measure(turn, noteId, user === null, req.parts, usage.prompt_tokens));
    this.emit({
      type: "actor_turn", turn, msg: `a${turn}`, text, model: this.models.actor, genMs: Math.round(res.ms), firstTokenMs: null, usage, finish_reason: finish,
      opener_cue: user === null, ...(error ? { error } : {}), note_id: noteId, actor_request_sha256: req.sha256,
    });
    if (text) {
      this.chat.push({ id: `a${turn}`, role: "assistant", text });
      this.history.push(...(user === null ? [] : [{ role: "user" as const, text: user }]), { role: "assistant", text, noteId });
    } else if (user !== null) this.history.push({ role: "user", text: user });
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

function gateAsLeakResult(g: GateResult): LeakResult {
  const safety = g.codes.filter((c) => SAFETY_LEAKS.includes(c));
  const rs = safety.some((c) => g.regex.includes(c)), js = safety.some((c) => (g.judge ?? []).includes(c));
  return { codes: g.codes, answeredFirst: g.answered_first, hits: g.hits, regex: g.regex, judge: g.judge ?? [], safety, leak_source: rs && js ? "both" : js ? "judge" : "regex" };
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
