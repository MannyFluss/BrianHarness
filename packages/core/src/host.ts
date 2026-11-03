/**
 * HarnessHost: the app-facing session controller (new chat, reply, HUD, session list, titles).
 * Shared by the Electron main process (Node storage) and the in-process web/iOS transport
 * (KV storage), so both shells drive the exact same core logic.
 */
import type { ModelBackend } from "./backends.js";
import type { DirectorTurnResult, HudState, TurnOptions } from "./session.js";
import { HarnessSession } from "./session.js";
import type { HarnessStorage } from "./platform/storage.js";
import { systemClock, type Clock } from "./platform/env.js";
import { isFillerOnly, sessionTitle } from "./title.js";
import type { FeedbackLogInput, RatingRecord, TypingEvent } from "./types.js";
import { STUDY_MIN_USER_TURNS, studySessionRecord, type StudyNoneReason, type StudyAssignment, type StudySessionInfo, type StudySessionRecord, type StudyStatus } from "./study.js";
import { sessionExportName, type ExportFile } from "./zip.js";
import { randomId } from "./platform/env.js";
import type { TopicTagger, TopicTaggerSpec } from "./tagger.js";

export interface SessionListItem {
  id: string;
  title: string;
  turns: number;
  startedAt: string | null;
  active: boolean;
}
export interface HostReply {
  director: DirectorTurnResult;
  hud: HudState;
  engagement: number;
  title: string;
}

/** a tagger factory's answer: a tagger / spec, or a spec plus why the wanted extractor was not built */
export type HostTaggerChoice = TopicTagger | TopicTaggerSpec | undefined | { spec: TopicTaggerSpec; fallback?: "no_key" | "mock_or_local" };

export class HarnessHost {
  session: HarnessSession | null = null;
  private titles = new Map<string, { firstUserText: string | null; topicLabel: string | null; turns: number }>();
  private clock: Clock;
  constructor(
    private cfg: {
      userId: string;
      storage: HarnessStorage | null;
      backend: () => Promise<ModelBackend>;
      logRawEvents?: boolean;
      /** a spec / tagger, or a factory called once per new session (e.g. re-read the selected provider; ctx.study = a study session) */
      tagger?: TopicTagger | TopicTaggerSpec | ((ctx: { study: boolean }) => HostTaggerChoice | Promise<HostTaggerChoice>);
      /** extractor unavailable this session (Electron: stderr). The HUD shows it in study sessions. */
      onExtractorWarning?: (message: string, info: { sessionId: string; reason: string }) => void;
      seed?: () => number;
      clock?: Clock;
      /** Phase D blinded study (StudyController); absent = every session adaptive, no study fields */
      study?: { assign(sessionId: string, last: (id: string) => number | StudySessionInfo): Promise<StudyAssignment | null>; status?(): Promise<StudyStatus>; noStudyReason?(): StudyNoneReason | null };
      /** called after a session ended (new chat, app exit): e.g. iOS BHExport.saveToDocuments */
      onSessionEnd?: (sessionId: string) => void | Promise<void>;
    },
  ) {
    this.clock = cfg.clock ?? systemClock;
  }

  private async sessionTagger(ctx: { study: boolean }): Promise<{ tagger?: TopicTagger | TopicTaggerSpec; fallback?: "no_key" | "mock_or_local" }> {
    const t = this.cfg.tagger;
    if (typeof t !== "function") return { tagger: t };
    try {
      const c = await t(ctx);
      if (c && typeof c === "object" && "spec" in c) return { tagger: c.spec, ...(c.fallback ? { fallback: c.fallback } : {}) };
      return { tagger: c as TopicTagger | TopicTaggerSpec | undefined };
    } catch (err) {
      console.warn("[brianharness] tagger selection failed; using keyphrase-idf:", (err as Error).message);
      return { tagger: { kind: "keyphrase-idf" } };
    }
  }

  async newSession(opts: TurnOptions = {}): Promise<{ sessionId: string; director: DirectorTurnResult; hud: HudState; title: string }> {
    if (this.session) {
      const prev = this.session;
      await prev.end();
      await this.cfg.storage?.flush?.();
      await this.notifyEnd(prev.id);
    }
    const sessionId = this.cfg.storage?.newSessionId() ?? `mem-${randomId(6)}`;
    let study: StudyAssignment | null = null;
    // the chat profile is chosen ONCE, here: plain = no study assignment because there is no study (no controller,
    // study off, or all sessions done). An assignment error / lost progress never yields plain (it keeps the
    // Director prompt, as before); a controller that cannot say why it returned null is treated the same way.
    let plain = false;
    try {
      const sc = this.cfg.study;
      study = (await sc?.assign(sessionId, (id) => this.sessionInfo(id))) ?? null;
      if (!study) {
        const why = sc ? (sc.noStudyReason?.() ?? null) : "off";
        plain = why === "off" || why === "finished";
      }
    } catch (err) {
      console.warn("[brianharness] study assignment failed; this session runs adaptive, unlogged:", (err as Error).message);
    }
    this.session = new HarnessSession({
      sessionId,
      ...(plain ? { profile: "plain" as const } : {}),
      ...(study ? { adaptation: study.adaptation, study: { id: study.study, index: study.index, total: study.total, scheduleHash: study.scheduleHash, protocol: study.protocol, ...(study.reissueOf ? { reissueOf: study.reissueOf } : {}), ...(study.manualReissue ? { manualReissue: true as const } : {}), ...(study.reissueReason ? { reissueReason: study.reissueReason } : {}), ...(study.progressRecovered ? { progressRecovered: true as const } : {}) } } : {}),
      userId: this.cfg.userId,
      backend: await this.cfg.backend(),
      store: this.cfg.storage,
      logRawEvents: this.cfg.logRawEvents ?? true,
      seed: this.cfg.seed ? this.cfg.seed() : this.clock() % 100000,
      ...(await (async () => {
        if (plain) return {}; // plain chat tags nothing: no tagger / extractor is built for it
        const c = await this.sessionTagger({ study: !!study });
        return { tagger: c.tagger, ...(c.fallback ? { taggerFallback: c.fallback } : {}) };
      })()),
      onExtractorWarning: (message, reason) => this.cfg.onExtractorWarning?.(message, { sessionId, reason }),
    });
    const d = await this.session.start(opts);
    return { sessionId: this.session.id, director: d, hud: this.session.hud(), title: "New chat" };
  }

  /**
   * p.shownAt = when the previous Director message was FULLY displayed (completeAt, stream end);
   * p.firstTokenAt = when its first token was displayed. opts.onToken streams the next reply.
   */
  async reply(p: { text: string; events?: TypingEvent[]; sentAt?: number; shownAt?: number; firstTokenAt?: number }, opts: TurnOptions = {}): Promise<HostReply> {
    if (!this.session) await this.newSession();
    const s = this.session!;
    if (typeof p.shownAt === "number") s.markShown(p.shownAt, typeof p.firstTokenAt === "number" ? p.firstTokenAt : undefined);
    const text = String(p.text);
    const out = await s.reply(text, Array.isArray(p.events) ? p.events : [], typeof p.sentAt === "number" ? p.sentAt : this.clock(), opts);
    const hud = s.hud();
    const t = this.titles.get(s.id) ?? { firstUserText: text, topicLabel: null, turns: 0 };
    if (isFillerOnly(t.firstUserText)) t.firstUserText = text; // "hi" then "I restore watches" -> title from the 2nd
    t.turns = s.turn;
    t.topicLabel = hud.hypothesis ? s.map.label(hud.hypothesis) : null;
    this.titles.set(s.id, t);
    return { director: out.director, hud, engagement: out.user.frame.engagement, title: sessionTitle(t) };
  }

  /** validity of a (previous) study session: user turns + an answered session rating (from memory or its log) */
  /** study sessions in the local logs (index, schedule hash, validity; never the mode): progress-recovery source */
  studyRecords(): StudySessionRecord[] {
    const st = this.cfg.storage;
    if (!st) return [];
    const out: StudySessionRecord[] = [];
    for (const id of st.listSessions()) {
      try {
        const r = studySessionRecord(st.readSession(id) as unknown as Array<{ type?: string }>);
        if (!r) continue;
        if (this.session?.id === id) { const i = this.sessionInfo(id); out.push({ ...r, valid: i.userTurns >= STUDY_MIN_USER_TURNS && i.sessionRated }); } else out.push(r);
      } catch { /* unreadable session: skipped */ }
    }
    return out;
  }

  private sessionInfo(id: string): StudySessionInfo {
    if (this.session?.id === id) return { userTurns: this.session.turn, sessionRated: this.session.sessionRated };
    try {
      const ev = this.cfg.storage?.readSession(id) ?? [];
      return {
        userTurns: ev.filter((e) => e.type === "user_turn").length,
        // the LAST session-scope rating decides (a later dismissal / null replaces an earlier answer)
        sessionRated: (() => { const r = ev.filter((e) => e.type === "rating" && (e as RatingRecord).scope === "session") as RatingRecord[]; return r.length > 0 && r[r.length - 1]!.value !== null && r[r.length - 1]!.value !== undefined; })(),
      };
    } catch {
      return { userTurns: 0, sessionRated: false };
    }
  }

  private async notifyEnd(id: string) {
    try {
      await this.cfg.onSessionEnd?.(id);
    } catch (err) {
      console.warn("[brianharness] session-end hook failed:", (err as Error).message);
    }
  }

  /** Log an absorption rating to the CURRENT session (evaluation only; see RatingRecord). */
  async rate(r: Partial<Omit<RatingRecord, "type" | "t">>): Promise<{ ok: boolean }> {
    if (!this.session) return { ok: false };
    this.session.logRating(r);
    await this.cfg.storage?.flush?.();
    return { ok: true };
  }

  /**
   * Log a Report-sheet event to the CURRENT session (see FeedbackLogRecord). Never starts a session: with none
   * running, nothing is written.
   */
  async feedbackEvent(e: FeedbackLogInput): Promise<{ ok: boolean }> {
    if (!this.session) return { ok: false };
    const rec = this.session.logFeedback(e);
    if (rec) await this.cfg.storage?.flush?.();
    return { ok: !!rec };
  }

  /** One session's JSONL file (as stored; blinded: contains no mode). */
  sessionFile(id: string): ExportFile | null {
    const st = this.cfg.storage;
    if (!st) return null;
    const events = st.readSession(id);
    if (!events.length) return null;
    const start = events.find((e) => (e as { type?: string }).type === "session_start") as { t?: string; study?: { index?: number } } | undefined;
    return { name: `sessions/${sessionExportName(start, id)}`, content: events.map((e) => JSON.stringify(e)).join("\n") + "\n", mimeType: "application/x-ndjson" };
  }

  /** Every session JSONL + the interest map (the save game), for "Export logs". */
  exportFiles(): ExportFile[] {
    const st = this.cfg.storage;
    if (!st) return [];
    const files = st.listSessions().map((id) => this.sessionFile(id)).filter((f): f is ExportFile => !!f);
    // bh-session-<idx>-<startISO> is second-resolution: two sessions (e.g. a quick reissue) can share a name; never let one overwrite the other
    const seen = new Map<string, number>();
    for (const f of files) {
      const k = seen.get(f.name) ?? 0;
      seen.set(f.name, k + 1);
      if (k) f.name = f.name.replace(/\.jsonl$/, `-${k + 1}.jsonl`);
    }
    files.push({ name: `saves/${this.cfg.userId}.json`, content: JSON.stringify(st.loadMap(this.cfg.userId).toJSON(), null, 1) + "\n", mimeType: "application/json" });
    return files;
  }

  hud(): HudState | null {
    return this.session?.hud() ?? null;
  }

  setBackend(b: ModelBackend) {
    this.session?.setBackend(b); // swap mid-chat; the Director's state carries over
  }

  sessions(limit = 50): SessionListItem[] {
    const st = this.cfg.storage;
    if (!st) return this.session ? [{ id: this.session.id, title: "New chat", turns: this.session.turn, startedAt: null, active: true }] : [];
    return st.listSessions().slice(0, limit).map((id) => {
      const events = st.readSession(id);
      const users = events.filter((e) => e.type === "user_turn");
      const firstUser = users.find((e) => e.type === "user_turn" && !isFillerOnly(e.text)) ?? users[0];
      const start = events.find((e) => e.type === "session_start");
      const t = this.titles.get(id);
      return {
        id,
        title: t ? sessionTitle(t) : firstUser && firstUser.type === "user_turn" ? sessionTitle({ firstUserText: firstUser.text }) : "New chat",
        turns: events.filter((e) => e.type === "user_turn").length,
        startedAt: start?.t ?? null,
        active: this.session?.id === id,
      };
    });
  }

  async end() {
    const s = this.session;
    await s?.end();
    await this.cfg.storage?.flush?.();
    if (s) await this.notifyEnd(s.id);
  }
}
