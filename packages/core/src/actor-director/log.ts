/**
 * E1: the bh-ad/1 session logger. A tab_visible session writes one log (ad/visible). A blinded session writes the
 * full log to ad/sealed and a redacted MAIN log to ad/blinded: sealed-only event types and director.leak_breaker
 * health are dropped, session_start loses arm / p_inject, actor_turn loses note_id / actor_request_sha256, gets
 * sealed:true and usage.prompt_tokens:null. Each log file has its own seq (0,1,2.. no gaps). Every main line is
 * re-checked with the shared blinded-guard rules before it is written (fail closed: a dirty line is not written
 * and the main log gets an upload.blinded_guard health line instead).
 */
import { BH_AD_SCHEMA, blindedMainLineViolation, SEALED_ONLY_HEALTH_CODES, SEALED_ONLY_TYPES } from "../ad-contracts/index.js";
import type { BhAdEvent, BhAdEventBody, SessionType } from "../ad-contracts/index.js";
import type { AdNamespace, AdStorage } from "./storage.js";

export interface AdClock { /** wall clock, ms since epoch */ now(): number; /** monotonic ms */ mono(): number }
export const systemAdClock = (): AdClock => {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  return { now: () => Date.now(), mono: () => Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - t0) * 1000) / 1000 };
};
/** a hand-driven clock for tests and replays */
export class ManualClock implements AdClock {
  constructor(public wall = Date.parse("2026-11-04T23:10:00.000Z"), public monoMs = 0) {}
  now() { return this.wall + this.monoMs; }
  mono() { return this.monoMs; }
  advance(ms: number) { this.monoMs += ms; }
}

/** main-log projection of a blinded session's event body; null = sealed only */
export function redactForMain(body: BhAdEventBody): BhAdEventBody | null {
  if ((SEALED_ONLY_TYPES as readonly string[]).includes(body.type)) return null;
  if (body.type === "health" && body.code && SEALED_ONLY_HEALTH_CODES.includes(body.code)) return null;
  if (body.type === "session_start") {
    const { arm: _a, p_inject: _p, ...rest } = body;
    return { ...rest, session_type: "blinded", tab: "hidden", sealed: true };
  }
  if (body.type === "actor_turn") {
    const { note_id: _n, actor_request_sha256: _s, ...rest } = body;
    return { ...rest, usage: { ...rest.usage, prompt_tokens: null }, sealed: true };
  }
  return body;
}

class SeqLog {
  seq = 0;
  constructor(readonly storage: AdStorage, readonly ns: AdNamespace, readonly id: string) {
    const prev = storage.read(ns, id);
    if (prev) this.seq = prev.split("\n").filter((l) => l.trim()).length;
  }
  write(sessionId: string, clock: AdClock, body: BhAdEventBody): BhAdEvent {
    const ev = { schema: BH_AD_SCHEMA, t: new Date(clock.now()).toISOString(), mono: clock.mono(), sessionId, seq: this.seq++, ...body } as BhAdEvent;
    this.storage.appendLine(this.ns, this.id, JSON.stringify(ev));
    return ev;
  }
}

export class AdSessionLog {
  private main: SeqLog;
  private sealed: SeqLog | null;
  readonly lines: BhAdEvent[] = [];
  /** main-log lines the guard refused to write (should stay 0; tests assert it) */
  guardDrops = 0;
  constructor(readonly storage: AdStorage, readonly sessionId: string, readonly sessionType: SessionType, readonly clock: AdClock) {
    this.main = new SeqLog(storage, sessionType === "blinded" ? "blinded" : "visible", sessionId);
    this.sealed = sessionType === "blinded" ? new SeqLog(storage, "sealed", sessionId) : null;
  }
  get mainNamespace(): AdNamespace { return this.main.ns; }
  /** write one event; returns the full (tab / sealed) line */
  emit(body: BhAdEventBody): BhAdEvent {
    if (!this.sealed) { const ev = this.main.write(this.sessionId, this.clock, body); this.lines.push(ev); return ev; }
    const full = this.sealed.write(this.sessionId, this.clock, body);
    this.lines.push(full);
    const red = redactForMain(body);
    if (red) {
      const code = blindedMainLineViolation({ schema: BH_AD_SCHEMA, sessionId: this.sessionId, seq: 0, ...red } as Record<string, unknown>);
      if (code) {
        this.guardDrops++;
        this.main.write(this.sessionId, this.clock, { type: "health", check: "upload", ok: false, code: "upload.blinded_guard", detail: code });
      } else this.main.write(this.sessionId, this.clock, red);
    }
    return full;
  }
}
