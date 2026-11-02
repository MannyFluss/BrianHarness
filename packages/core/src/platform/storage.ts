/**
 * HarnessStorage: where a session's JSONL log and the per-user interest-map save file live.
 *  - Node (desktop main, sidecar, sim): SessionStore in store.ts (files in the user-data dir).
 *  - Browser / WKWebView: KVHarnessStorage over any KeyValueStore (IndexedDbKV, LocalStorageKV,
 *    a Capacitor Preferences adapter, ...).
 * The interface is synchronous because the session loop is; async backends are wrapped by
 * KVHarnessStorage, which hydrates everything once at open() and then writes through in the
 * background (call flush() before the page/app is suspended, e.g. on `visibilitychange`).
 */
import type { LogEvent } from "../types.js";
import { InterestMap } from "../interest-map.js";
import type { KeyValueStore } from "./kv.js";
import { randomId } from "./env.js";

export interface HarnessStorage {
  newSessionId(now?: Date): string;
  append(sessionId: string, event: LogEvent): void;
  readSession(sessionId: string): LogEvent[];
  /** newest first */
  listSessions(): string[];
  loadMap(userId: string): InterestMap;
  saveMap(map: InterestMap): void;
  /** resolve once pending writes are durable (no-op for sync stores) */
  flush?(): Promise<void>;
}

export const newSessionIdFor = (now = new Date()) => `${now.toISOString().replace(/[:.]/g, "-")}-${randomId(4)}`;
const safeUser = (u: string) => u.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Everything in memory (tests, private-mode browsers where IndexedDB is unavailable). */
export class MemoryHarnessStorage implements HarnessStorage {
  readonly sessions = new Map<string, LogEvent[]>();
  readonly saves = new Map<string, unknown>();
  newSessionId(now?: Date) {
    return newSessionIdFor(now);
  }
  append(id: string, e: LogEvent) {
    const a = this.sessions.get(id) ?? [];
    a.push(JSON.parse(JSON.stringify(e)) as LogEvent);
    this.sessions.set(id, a);
  }
  readSession(id: string) {
    return [...(this.sessions.get(id) ?? [])];
  }
  listSessions() {
    return [...this.sessions.keys()].sort().reverse();
  }
  loadMap(userId: string) {
    const s = this.saves.get(safeUser(userId));
    return s ? InterestMap.fromJSON(JSON.parse(JSON.stringify(s))) : InterestMap.fresh(userId);
  }
  saveMap(map: InterestMap) {
    this.saves.set(safeUser(map.data.userId), JSON.parse(JSON.stringify(map.toJSON())));
  }
}

/**
 * HarnessStorage over an async KeyValueStore. Keys:
 *   sessions/<sessionId>  -> JSONL text (one LogEvent per line, same format as the desktop files)
 *   saves/<userId>        -> interest-map JSON (same format as <userId>.interest.json)
 */
export class KVHarnessStorage implements HarnessStorage {
  private cache = new Map<string, string>();
  private dirty = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private scheduled = false;
  /** last background write error (surfaced instead of thrown into the chat loop) */
  lastError: unknown = null;
  private constructor(private kv: KeyValueStore, private opts: { maxSessions: number }) {}

  static async open(kv: KeyValueStore, opts: { maxSessions?: number } = {}): Promise<KVHarnessStorage> {
    const s = new KVHarnessStorage(kv, { maxSessions: opts.maxSessions ?? 200 });
    for (const k of [...(await kv.keys("sessions/")), ...(await kv.keys("saves/"))]) {
      const v = await kv.get(k);
      if (v !== null) s.cache.set(k, v);
    }
    return s;
  }

  private put(k: string, v: string) {
    this.cache.set(k, v);
    this.dirty.add(k);
    if (this.scheduled) return;
    this.scheduled = true;
    // coalesce a turn's appends + save into one write per key
    setTimeout(() => {
      this.scheduled = false;
      void this.flush();
    }, 0);
  }

  flush(): Promise<void> {
    const keys = [...this.dirty];
    this.dirty.clear();
    this.writing = this.writing.then(async () => {
      for (const k of keys) {
        try {
          await this.kv.set(k, this.cache.get(k) ?? "");
        } catch (e) {
          this.lastError = e;
          this.dirty.add(k); // retry on the next flush
        }
      }
    });
    return this.writing;
  }

  newSessionId(now?: Date) {
    return newSessionIdFor(now);
  }
  append(id: string, e: LogEvent) {
    const k = `sessions/${id}`;
    const isNew = !this.cache.has(k);
    this.put(k, (this.cache.get(k) ?? "") + JSON.stringify(e) + "\n");
    if (isNew && this.listSessions().length > this.opts.maxSessions) this.prune();
  }
  private prune() {
    const old = this.listSessions().slice(this.opts.maxSessions);
    for (const id of old) {
      this.cache.delete(`sessions/${id}`);
      void this.kv.remove(`sessions/${id}`).catch((err) => (this.lastError = err));
    }
  }
  readSession(id: string): LogEvent[] {
    const v = this.cache.get(`sessions/${id}`);
    return v ? v.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEvent) : [];
  }
  listSessions() {
    return [...this.cache.keys()].filter((k) => k.startsWith("sessions/")).map((k) => k.slice(9)).sort().reverse();
  }
  loadMap(userId: string) {
    const v = this.cache.get(`saves/${safeUser(userId)}`);
    return v ? InterestMap.fromJSON(JSON.parse(v)) : InterestMap.fresh(userId);
  }
  saveMap(map: InterestMap) {
    this.put(`saves/${safeUser(map.data.userId)}`, JSON.stringify(map.toJSON()));
  }
}
