/**
 * E1: the bh-ad/1 session logger. A tab_visible session writes one log (ad/visible). A blinded session writes the
 * full log to ad/sealed and a redacted MAIN log to ad/blinded: sealed-only event types and director.leak_breaker
 * health are dropped, session_start loses arm / p_inject, actor_turn loses note_id / actor_request_sha256, gets
 * sealed:true and usage.prompt_tokens:null. Each log file has its own seq (0,1,2.. no gaps). Every main line is
 * re-checked with the shared blinded-guard rules before it is written (fail closed: a dirty line is not written
 * and the main log gets an upload.blinded_guard health line instead).
 *
 * v1.3 (Researcher ruling, 5:33 PM): leak_judge verdicts are sealed-only in EVERY session type through ONE code path.
 * Every session writes the full log to ad/sealed; the main log (ad/visible for tab_visible, ad/blinded for blinded) is
 * projectForMain(sessionType, body). For tab_visible that drops leak_judge and turns note_dropped reason "leak_judge"
 * into the generic "withheld" (the tab shows only "note dropped"). `tabLines` = the main-log lines, which is all the
 * Director tab may read; `lines` stay the full (sealed) lines for replay / research.
 */
import { BH_AD_SCHEMA, blindedMainLineViolation, SEALED_EVERYWHERE_REASONS, SEALED_EVERYWHERE_TYPES, SEALED_ONLY_HEALTH_CODES, SEALED_ONLY_TYPES, sealedEverywhereViolation } from "../ad-contracts/index.js";
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

/** v1.3: the projection every non-sealed log gets in every session type: drop sealed-everywhere types, map sealed reasons */
export function projectSealedEverywhere(body: BhAdEventBody): BhAdEventBody | null {
  if (SEALED_EVERYWHERE_TYPES.includes(body.type)) return null;
  const m = SEALED_EVERYWHERE_REASONS[body.type];
  const reason = (body as { reason?: unknown }).reason;
  if (m && typeof reason === "string" && reason in m) return { ...body, reason: m[reason] } as BhAdEventBody;
  return body;
}
/** THE main-log projection: blinded -> redactForMain, tab_visible -> projectSealedEverywhere; null = sealed only */
export function projectForMain(sessionType: SessionType, body: BhAdEventBody): BhAdEventBody | null {
  const p = projectSealedEverywhere(body);
  return p && sessionType === "blinded" ? redactForMain(p) : p;
}
/** what the Director tab may read from a list of full lines (the same projection; for callers that hold full lines) */
export function tabSafeLines<T extends BhAdEvent>(lines: readonly T[]): T[] {
  return lines.flatMap((l) => {
    const p = projectSealedEverywhere(l as BhAdEventBody);
    return p ? [p as unknown as T] : [];
  });
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
  private sealed: SeqLog;
  /** the full lines (the sealed log): replay, research, tests; never handed to the Director tab */
  readonly lines: BhAdEvent[] = [];
  /** the main-log lines (visible / blinded main): the only lines the Director tab reads */
  readonly tabLines: BhAdEvent[] = [];
  /** main-log lines the guard refused to write (should stay 0; tests assert it) */
  guardDrops = 0;
  /** optional sink for each main-log line (Mac H1 pointer JSONL mirror); never sealed-only bodies */
  onMainLine: ((ev: BhAdEvent) => void) | null = null;
  constructor(readonly storage: AdStorage, readonly sessionId: string, readonly sessionType: SessionType, readonly clock: AdClock) {
    this.main = new SeqLog(storage, sessionType === "blinded" ? "blinded" : "visible", sessionId);
    this.sealed = new SeqLog(storage, "sealed", sessionId);
  }
  get mainNamespace(): AdNamespace { return this.main.ns; }
  /** write one event; returns the full (tab / sealed) line */
  emit(body: BhAdEventBody): BhAdEvent {
    const full = this.sealed.write(this.sessionId, this.clock, body);
    this.lines.push(full);
    const red = projectForMain(this.sessionType, body);
    if (red) {
      const line = { schema: BH_AD_SCHEMA, sessionId: this.sessionId, seq: 0, ...red } as Record<string, unknown>;
      const code = sealedEverywhereViolation(line) ? "sealed_everywhere" : this.sessionType === "blinded" ? blindedMainLineViolation(line) : null;
      if (code) {
        this.guardDrops++;
        const guard = this.main.write(this.sessionId, this.clock, { type: "health", check: "upload", ok: false, code: "upload.blinded_guard", detail: code });
        this.tabLines.push(guard);
        this.onMainLine?.(guard);
      } else {
        const main = this.main.write(this.sessionId, this.clock, red);
        this.tabLines.push(main);
        this.onMainLine?.(main);
      }
    }
    return full;
  }
}
