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
import type { RatingRecord, TypingEvent } from "./types.js";
import type { StudyAssignment, StudyStatus } from "./study.js";
import type { ExportFile } from "./zip.js";
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
      tagger?: TopicTagger | TopicTaggerSpec;
      seed?: () => number;
      clock?: Clock;
      /** Phase D blinded study (StudyController); absent = every session adaptive, no study fields */
      study?: { assign(sessionId: string, lastTurns: (id: string) => number): Promise<StudyAssignment | null>; status?(): Promise<StudyStatus> };
      /** called after a session ended (new chat, app exit): e.g. iOS BHExport.saveToDocuments */
      onSessionEnd?: (sessionId: string) => void | Promise<void>;
    },
  ) {
    this.clock = cfg.clock ?? systemClock;
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
    try {
      study = (await this.cfg.study?.assign(sessionId, (id) => this.userTurns(id))) ?? null;
    } catch (err) {
      console.warn("[brianharness] study assignment failed; this session runs adaptive, unlogged:", (err as Error).message);
    }
    this.session = new HarnessSession({
      sessionId,
      ...(study ? { adaptation: study.adaptation, study: { id: study.study, index: study.index, total: study.total, scheduleHash: study.scheduleHash } } : {}),
      userId: this.cfg.userId,
      backend: await this.cfg.backend(),
      store: this.cfg.storage,
      logRawEvents: this.cfg.logRawEvents ?? true,
      seed: this.cfg.seed ? this.cfg.seed() : this.clock() % 100000,
      tagger: this.cfg.tagger,
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

  private userTurns(id: string): number {
    if (this.session?.id === id) return this.session.turn;
    try {
      return this.cfg.storage?.readSession(id).filter((e) => e.type === "user_turn").length ?? 0;
    } catch {
      return 0;
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

  /** One session's JSONL file (as stored; blinded: contains no mode). */
  sessionFile(id: string): ExportFile | null {
    const st = this.cfg.storage;
    if (!st) return null;
    const events = st.readSession(id);
    if (!events.length) return null;
    return { name: `sessions/${id}.jsonl`, content: events.map((e) => JSON.stringify(e)).join("\n") + "\n", mimeType: "application/x-ndjson" };
  }

  /** Every session JSONL + the interest map (the save game), for "Export logs". */
  exportFiles(): ExportFile[] {
    const st = this.cfg.storage;
    if (!st) return [];
    const files = st.listSessions().map((id) => this.sessionFile(id)).filter((f): f is ExportFile => !!f);
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
