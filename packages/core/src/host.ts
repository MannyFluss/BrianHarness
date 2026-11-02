/**
 * HarnessHost: the app-facing session controller (new chat, reply, HUD, session list, titles).
 * Shared by the Electron main process (Node storage) and the in-process web/iOS transport
 * (KV storage), so both shells drive the exact same core logic.
 */
import type { ModelBackend } from "./backends.js";
import type { DirectorTurnResult, HudState } from "./session.js";
import { HarnessSession } from "./session.js";
import type { HarnessStorage } from "./platform/storage.js";
import { systemClock, type Clock } from "./platform/env.js";
import { isFillerOnly, sessionTitle } from "./title.js";
import type { TypingEvent } from "./types.js";
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
    },
  ) {
    this.clock = cfg.clock ?? systemClock;
  }

  async newSession(): Promise<{ sessionId: string; director: DirectorTurnResult; hud: HudState; title: string }> {
    if (this.session) await this.session.end();
    this.session = new HarnessSession({
      userId: this.cfg.userId,
      backend: await this.cfg.backend(),
      store: this.cfg.storage,
      logRawEvents: this.cfg.logRawEvents ?? true,
      seed: this.cfg.seed ? this.cfg.seed() : this.clock() % 100000,
      tagger: this.cfg.tagger,
    });
    const d = await this.session.start();
    return { sessionId: this.session.id, director: d, hud: this.session.hud(), title: "New chat" };
  }

  async reply(p: { text: string; events?: TypingEvent[]; sentAt?: number; shownAt?: number }): Promise<HostReply> {
    if (!this.session) await this.newSession();
    const s = this.session!;
    if (typeof p.shownAt === "number") s.markShown(p.shownAt);
    const text = String(p.text);
    const out = await s.reply(text, Array.isArray(p.events) ? p.events : [], typeof p.sentAt === "number" ? p.sentAt : this.clock());
    const hud = s.hud();
    const t = this.titles.get(s.id) ?? { firstUserText: text, topicLabel: null, turns: 0 };
    if (isFillerOnly(t.firstUserText)) t.firstUserText = text; // "hi" then "I restore watches" -> title from the 2nd
    t.turns = s.turn;
    t.topicLabel = hud.hypothesis ? s.map.label(hud.hypothesis) : null;
    this.titles.set(s.id, t);
    return { director: out.director, hud, engagement: out.user.frame.engagement, title: sessionTitle(t) };
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
    await this.session?.end();
    await this.cfg.storage?.flush?.();
  }
}
