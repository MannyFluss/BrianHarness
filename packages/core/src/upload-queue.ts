/**
 * Session-log auto-upload queue for POST /v1/sessions (Worker docs/SESSIONS_API.md, client retry rule). Browser-safe.
 * State + bodies live in a KeyValueStore (desktop: <userData>/pending-uploads/, one file per key; iOS/web: the
 * app's IndexedDB). The session file itself is never touched: BHExport / Files keep their copy regardless.
 *
 *   201, or 409 session_exists        -> done (body dropped)
 *   401                               -> stays queued; the whole queue pauses until the device token changes
 *   429                               -> stays queued; the whole queue pauses for Retry-After (default 60 s)
 *   any other 4xx (400/413/422, ...)  -> needs-export: never retried, shown in the UI, file kept for BHExport
 *   5xx                               -> backoff (30 s doubling, max 30 min); after 5 consecutive 5xx on a body
 *                                        > 500 KB -> needs-export
 *   network error / no token          -> stays queued (backoff on errors; no 5xx count)
 * A client-side pre-check (secret patterns, > 1 MiB) marks a body needs-export without sending it.
 */
import type { KeyValueStore } from "./platform/kv.js";
import type { ExportFile } from "./zip.js";
import { findUploadSecret, sessionUploadBody, studyStartUploadBody, type UploadMeta } from "./upload-body.js";
import { sha256HexSync, studySessionRecordFromJsonl, type StudySessionRecord } from "./study.js";

export type UploadState = "pending" | "needs-export" | "done";
export interface UploadItem {
  id: string;
  kind: "session" | "study_start";
  /** export file name (sessions) */
  name?: string;
  bytes: number;
  state: UploadState;
  attempts: number;
  consecutive5xx: number;
  nextAt: number;
  createdAt: string;
  lastStatus?: number;
  lastError?: string;
  doneAt?: string;
  /** study sessions: index / schedule hash / validity at enqueue (durable ledger for progress recovery; never the mode) */
  study?: Omit<StudySessionRecord, "sessionId">;
}
export interface UploadSummary {
  /** queued, will be sent (includes paused ones) */
  pending: number;
  /** final client/Worker refusal: export these with "Export logs" */
  needsExport: number;
  done: number;
  /** why nothing is moving right now, if anything */
  blocked?: "no-token" | "auth" | "rate-limited" | "offline";
  pausedUntil?: number;
  items: Array<Pick<UploadItem, "id" | "kind" | "name" | "state" | "lastStatus" | "lastError">>;
}
export interface UploadTarget { url: string; token: string }

export const UPLOAD_MAX_BYTES = 1024 * 1024;
export const UPLOAD_BIG_BYTES = 500 * 1024;
export const UPLOAD_MAX_5XX = 5;
const INDEX = "uploads/index";
const PAUSE = "uploads/pause";
const bodyKey = (id: string) => `uploads/body/${id}`;
const KEEP_DONE = 200;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export class UploadQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBlocked: UploadSummary["blocked"];
  constructor(
    private kv: KeyValueStore,
    private o: {
      /** endpoint + device token; null = not configured (no Spider Cloud token): items wait */
      target: () => Promise<UploadTarget | null>;
      meta: UploadMeta;
      fetchImpl?: typeof fetch;
      now?: () => number;
      /** auto-flush timer (default true; tests pass false and call flush()) */
      autoSchedule?: boolean;
      onChange?: (s: UploadSummary) => void;
    },
  ) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
  private async index(): Promise<UploadItem[]> {
    try { return JSON.parse((await this.kv.get(INDEX)) ?? "[]") as UploadItem[]; } catch { return []; }
  }
  private async saveIndex(items: UploadItem[]) {
    const done = items.filter((i) => i.state === "done");
    const keep = done.length > KEEP_DONE ? items.filter((i) => i.state !== "done" || done.indexOf(i) >= done.length - KEEP_DONE) : items;
    await this.kv.set(INDEX, JSON.stringify(keep));
  }
  private async pause(): Promise<{ until?: number; tokenFp?: string }> {
    try { return JSON.parse((await this.kv.get(PAUSE)) ?? "{}"); } catch { return {}; }
  }

  /** queue an ended session's export file (idempotent per sessionId) */
  enqueueSession(file: ExportFile): Promise<UploadItem | null> {
    return this.serial(async () => {
      const body = sessionUploadBody(file.content, this.o.meta);
      const rec = studySessionRecordFromJsonl(file.content);
      return this.add({ id: body.sessionId, kind: "session", name: file.name.replace(/^.*\//, ""), ...(rec ? { study: { index: rec.index, scheduleHash: rec.scheduleHash, valid: rec.valid } } : {}) }, JSON.stringify(body));
    });
  }
  /** study sessions this queue has seen (any state, incl. uploaded ones still in the index) */
  async studyRecords(): Promise<StudySessionRecord[]> {
    return (await this.index()).filter((i) => i.kind === "session" && i.study).map((i) => ({ sessionId: i.id, ...i.study! }));
  }
  /** queue the study_start record (id = phaseD-<hash16>: re-enqueueing the same schedule is a no-op) */
  enqueueStudyStart(s: { scheduleHash: string; nSessions: number; createdAt: string; protocol?: number }): Promise<UploadItem | null> {
    return this.serial(async () => {
      const body = studyStartUploadBody(s, this.o.meta);
      return this.add({ id: body.id, kind: "study_start" }, JSON.stringify(body));
    });
  }
  private async add(base: { id: string; kind: UploadItem["kind"]; name?: string; study?: UploadItem["study"] }, body: string): Promise<UploadItem | null> {
    const items = await this.index();
    const had = items.find((i) => i.id === base.id);
    if (had && had.state !== "needs-export") return null; // already queued or uploaded
    const item: UploadItem = { ...base, bytes: utf8Bytes(body), state: "pending", attempts: 0, consecutive5xx: 0, nextAt: 0, createdAt: new Date(this.now()).toISOString() };
    const secret = findUploadSecret(body);
    if (secret) Object.assign(item, { state: "needs-export", lastError: "looks like it contains a key or token: not uploaded" });
    else if (item.bytes > UPLOAD_MAX_BYTES) Object.assign(item, { state: "needs-export", lastError: "larger than 1 MiB: not uploaded" });
    if (item.state === "pending") await this.kv.set(bodyKey(item.id), body);
    await this.saveIndex([...items.filter((i) => i.id !== item.id), item]);
    this.changed();
    return item;
  }

  async summary(): Promise<UploadSummary> {
    const items = await this.index();
    const p = await this.pause();
    const pending = items.filter((i) => i.state === "pending").length;
    return {
      pending, needsExport: items.filter((i) => i.state === "needs-export").length, done: items.filter((i) => i.state === "done").length,
      ...(pending && this.lastBlocked ? { blocked: this.lastBlocked } : {}), ...(p.until && p.until > this.now() ? { pausedUntil: p.until } : {}),
      items: items.filter((i) => i.state !== "done").map(({ id, kind, name, state, lastStatus, lastError }) => ({ id, kind, name, state, lastStatus, lastError })),
    };
  }
  private changed() { if (this.o.onChange) void this.summary().then(this.o.onChange, () => {}); }

  /** send every due item once (serialized). Returns the summary afterwards. */
  flush(opts: { force?: boolean } = {}): Promise<UploadSummary> {
    return this.serial(async () => {
      await this.flushOnce(!!opts.force);
      this.schedule();
      const s = await this.summary();
      this.o.onChange?.(s);
      return s;
    });
  }

  private async flushOnce(force: boolean) {
    const target = await this.o.target().catch(() => null);
    const items = await this.index();
    if (!items.some((i) => i.state === "pending")) { this.lastBlocked = undefined; return; }
    if (!target) { this.lastBlocked = "no-token"; return; }
    const fp = sha256HexSync(target.token).slice(0, 16);
    const p = await this.pause();
    if (p.tokenFp && p.tokenFp === fp) { this.lastBlocked = "auth"; return; } // 401 with this token: wait for a new one
    if (!force && p.until && p.until > this.now()) { this.lastBlocked = "rate-limited"; return; }
    this.lastBlocked = undefined;
    const f = this.o.fetchImpl ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
    for (const it of items) {
      if (it.state !== "pending" || (!force && it.nextAt > this.now())) continue;
      const body = await this.kv.get(bodyKey(it.id));
      if (!body) { Object.assign(it, { state: "needs-export", lastError: "queued body missing" }); continue; }
      it.attempts++;
      let res: Response;
      try {
        res = await f(target.url, { method: "POST", headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" }, body });
      } catch (e) {
        it.lastError = `network: ${(e as Error).message}`;
        it.lastStatus = 0;
        it.nextAt = this.now() + backoff(it.attempts);
        this.lastBlocked = "offline";
        break; // offline: don't hammer the rest
      }
      it.lastStatus = res.status;
      const err = await errorOf(res);
      if (res.status === 201 || (res.status === 409 && err.error === "session_exists")) {
        Object.assign(it, { state: "done", doneAt: new Date(this.now()).toISOString(), lastError: undefined, consecutive5xx: 0 });
        await this.removeBody(it.id);
      } else if (res.status === 401) {
        it.lastError = "device token invalid or revoked";
        await this.kv.set(PAUSE, JSON.stringify({ ...p, tokenFp: fp }));
        this.lastBlocked = "auth";
        break;
      } else if (res.status === 429) {
        const until = this.now() + retryAfterMs(res.headers.get("retry-after"), this.now());
        it.lastError = `rate limited (${err.error ?? "429"})`;
        await this.kv.set(PAUSE, JSON.stringify({ until }));
        this.lastBlocked = "rate-limited";
        break;
      } else if (res.status >= 400 && res.status < 500) {
        Object.assign(it, { state: "needs-export", lastError: `${res.status} ${err.error ?? ""}${err.reason ? ` (${err.reason})` : ""}`.trim() });
        await this.removeBody(it.id);
      } else {
        it.consecutive5xx++;
        it.lastError = `server error ${res.status}`;
        if (it.consecutive5xx >= UPLOAD_MAX_5XX && it.bytes > UPLOAD_BIG_BYTES) {
          Object.assign(it, { state: "needs-export", lastError: `${it.consecutive5xx} server errors in a row on a ${Math.round(it.bytes / 1024)} KB log` });
          await this.removeBody(it.id);
        } else it.nextAt = this.now() + backoff(it.consecutive5xx);
      }
    }
    // a working token clears an old 401 pause
    const cur = await this.pause();
    if (cur.tokenFp && cur.tokenFp !== fp) await this.kv.set(PAUSE, JSON.stringify({ ...(cur.until ? { until: cur.until } : {}) }));
    await this.saveIndex(items);
  }
  private async removeBody(id: string) {
    await this.kv.remove(bodyKey(id));
  }

  /** next timer: earliest nextAt / pause end; nothing when idle or waiting for a token */
  private schedule() {
    if (this.o.autoSchedule === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void (async () => {
      const items = (await this.index()).filter((i) => i.state === "pending");
      if (!items.length || this.lastBlocked === "no-token" || this.lastBlocked === "auth") return;
      const p = await this.pause();
      const at = Math.max(p.until ?? 0, Math.min(...items.map((i) => i.nextAt)));
      const ms = Math.min(Math.max(at - this.now(), 5_000), 30 * 60_000);
      this.timer = setTimeout(() => void this.flush(), ms);
      (this.timer as { unref?: () => void }).unref?.();
    })();
  }
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

/** Worker errors are OpenAI-style `{error:{message,type,code,reason?,permanent}}`; a flat `{error:"code"}` is accepted too */
async function errorOf(res: Response): Promise<{ error?: string; reason?: string }> {
  try {
    const j = (await res.json()) as { error?: unknown; reason?: unknown };
    const e = j?.error;
    if (e && typeof e === "object") {
      const o = e as { code?: unknown; reason?: unknown };
      return { ...(typeof o.code === "string" ? { error: o.code } : {}), ...(typeof o.reason === "string" ? { reason: o.reason } : {}) };
    }
    return { ...(typeof e === "string" ? { error: e } : {}), ...(typeof j?.reason === "string" ? { reason: j.reason } : {}) };
  } catch {
    return {};
  }
}

export function backoff(n: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, n - 1), 30 * 60_000);
}
export function retryAfterMs(h: string | null, now: number): number {
  if (!h) return 60_000;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(1, s) * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(1000, d - now) : 60_000;
}
