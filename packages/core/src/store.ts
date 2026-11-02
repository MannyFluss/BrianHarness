/**
 * Persistence: one JSONL log per session (append-only, like a replay file) and one
 * JSON interest-map save file per user (the save game). Node-only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "./types.js";
import { InterestMap } from "./interest-map.js";

export class SessionStore {
  readonly sessionsDir: string;
  readonly savesDir: string;
  constructor(readonly dataDir: string) {
    this.sessionsDir = join(dataDir, "sessions");
    this.savesDir = join(dataDir, "saves");
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.savesDir, { recursive: true });
  }
  newSessionId(now = new Date()): string {
    return `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  }
  append(sessionId: string, event: LogEvent): void {
    appendFileSync(join(this.sessionsDir, `${sessionId}.jsonl`), JSON.stringify(event) + "\n");
  }
  readSession(sessionId: string): LogEvent[] {
    const p = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
  }
  listSessions(): string[] {
    return readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort().reverse();
  }
  savePath(userId: string): string {
    return join(this.savesDir, `${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}.interest.json`);
  }
  loadMap(userId: string): InterestMap {
    const p = this.savePath(userId);
    if (!existsSync(p)) return InterestMap.fresh(userId);
    return InterestMap.fromJSON(JSON.parse(readFileSync(p, "utf8")));
  }
  saveMap(map: InterestMap): void {
    const p = this.savePath(map.data.userId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(map.toJSON(), null, 2));
    renameSync(tmp, p); // atomic swap so a crash never corrupts the save
  }
}
