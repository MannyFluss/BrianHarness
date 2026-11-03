/**
 * Phase D dogfood study (eeg-harness-sim/phaseD/PREREG_dogfood.md): a blinded, pre-generated
 * schedule of exactly 5 adaptive + 5 baseline sessions in a seeded random order.
 *
 * Blinding rules implemented here:
 *   - the schedule (seed + order) lives ONLY in the platform's secure store (iOS: BHKeychain key
 *     `study/phaseD/schedule`; Electron: the safeStorage-encrypted credentials file); never in
 *     settings, logs, exports, the CSV, the UI or the HUD
 *   - sessions log the study index (1..10) and the schedule's sha256, never the mode
 *   - the hash can be printed (dev/debug hooks); the order only through an explicit unseal call
 *     with a confirmation phrase, meant for after session 10
 *
 * Study progress (enabled / next index / last session / pending manual redo; never the mode) lives in the SAME
 * secure store as the schedule (key `study/phaseD/progress`, written with a read-back check), so a WKWebView
 * storage eviction cannot reset the study to index 1 while the schedule survives in the Keychain. Older builds
 * kept it in the settings KV: it is migrated on first read and the old copy removed. A schedule without progress
 * is recovered from the session records still on the device (local session logs + the durable upload ledger):
 * next = highest study index found + 1, or that index again if its sessions were all invalid; the next
 * session_start logs progressRecovered true. Nothing found -> "progress lost": no study session runs until the
 * participant uses Set next study session (setNext) after contacting the Researcher.
 */
import { makeRng } from "./rng.js";
import type { KeyValueStore } from "./platform/kv.js";
import type { ExportFile } from "./zip.js";

export type Adaptation = "adaptive" | "baseline";
export const STUDY_ID = "phaseD";
export const STUDY_SESSIONS = 10;
export const STUDY_SCHEDULE_KEY = "study/phaseD/schedule";
export const STUDY_PROGRESS_KEY = "study/phaseD/progress";
export const UNSEAL_PHRASE = "UNSEAL phaseD";
/** confirmation phrase for the progress-lost unblock ("Set next study session n") */
export const setNextPhrase = (n: number) => `SET NEXT ${n}`;
export const STUDY_PROGRESS_LOST_NOTE = "Study progress lost; contact the Researcher";
/** confirmation phrase for a manual reissue of index n ("Redo study session n") */
export const reissuePhrase = (n: number) => `REISSUE ${n}`;
/** optional free-text reason for a manual redo (logged as session_start.reissueReason) */
export const REISSUE_REASON_MAX = 120;
/**
 * Study protocol (freeze) version, stored in the sealed schedule as `protocol` and logged in session_start.study,
 * study_start and final. 1 = practice builds (<= 1438 / 11c71d1, which wrote no `protocol` field): a schedule
 * without it, or with a lower one, is discarded on launch together with the study progress (never the session
 * files or the upload queue), so "Start study" seals a fresh one. Sessions without `protocol` are practice.
 * 2 = builds 1604 / 2031 (Director replies cut by max_tokens 200: the Researcher treats them as practice).
 * 3 = the P0 cut-off fix (per-model max_tokens, finish_reason/truncated logged): a protocol-2 install restarts
 *     at index 1 with a new schedule (no progress recovery: recovery only matches the new schedule's hash).
 */
export const STUDY_PROTOCOL_VERSION = 3;
/** a study session counts only with >= this many user turns AND an answered session rating; else its index is reissued */
export const STUDY_MIN_USER_TURNS = 8;

export interface StudySchedule {
  study: typeof STUDY_ID;
  version: 1;
  seed: number;
  order: Adaptation[];
  createdAt: string;
  /** STUDY_PROTOCOL_VERSION at sealing; absent in practice schedules (build 1438) */
  protocol?: number;
}
/** what the host reports about the previous study session (validity check for index reissue) */
export interface StudySessionInfo {
  userTurns: number;
  /** a session-scope rating with a value (1..5) was logged; a dismissed card does not count */
  sessionRated: boolean;
}
/** what a session gets: the mode goes to the Director only; index + hash are logged */
export interface StudyAssignment {
  study: typeof STUDY_ID;
  index: number;
  total: number;
  scheduleHash: string;
  adaptation: Adaptation;
  protocol: number;
  /**
   * the previous study session was invalid (< STUDY_MIN_USER_TURNS user turns or no session rating): same index
   * (and mode) again; "manual" = the participant asked to redo this index (Settings > Study, manualReissue true)
   */
  reissueOf?: string;
  manualReissue?: true;
  /** manual redo only: the participant's short reason (<= REISSUE_REASON_MAX chars) */
  reissueReason?: string;
  /** the first session after the progress was rebuilt (from session records, or setNext after a loss) */
  progressRecovered?: true;
}
/** one study session found on the device (recovery source); never the mode */
export interface StudySessionRecord {
  sessionId?: string;
  index: number;
  scheduleHash: string;
  /** >= STUDY_MIN_USER_TURNS user turns and the LAST session rating answered */
  valid: boolean;
}
export interface StudyStatus {
  enabled: boolean;
  /** next (or current, if it had no replies yet) session index, 1..total; total+1 = finished */
  next: number;
  total: number;
  /** schedule exists in the secure store */
  scheduled: boolean;
  /** secure store unavailable (e.g. iOS Keychain -34018): the study cannot run */
  error?: string;
  /** a manual redo is pending: the next study session gets this index */
  pendingReissue?: number;
  /** schedule present but the progress could not be rebuilt: no study session runs until setNext */
  progressLost?: true;
  /** progress was rebuilt from session records; the next session_start logs progressRecovered */
  progressRecovered?: true;
}

/** Exactly n/2 adaptive + n/2 baseline, Fisher-Yates with the seeded RNG. */
export function generateSchedule(seed: number, n = STUDY_SESSIONS): Adaptation[] {
  const order: Adaptation[] = [...Array<Adaptation>(n / 2).fill("adaptive"), ...Array<Adaptation>(n - n / 2).fill("baseline")];
  const rng = makeRng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** SHA-256 in plain JS: crypto.subtle is secure-context-only (a LAN http:// page has none). */
export function sha256HexSync(text: string): string {
  const msg = new TextEncoder().encode(text);
  const len = msg.length, total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 2 ** 32));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K256[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + add[i]!) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexSync(text);
}

/** Secure string store (Keychain / encrypted file). Only get/set are needed. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** optional; without it a cleared key is stored as "" (= absent) */
  remove?(key: string): Promise<void>;
}

function randomSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  return c?.getRandomValues ? c.getRandomValues(new Uint32Array(1))[0]! : Math.floor(Math.random() * 2 ** 32);
}

interface Progress {
  enabled: boolean;
  next: number;
  /** the latest study session and its index (checked for validity when the next one starts) */
  last?: { sessionId: string; index: number };
  /** manual redo requested (Settings > Study): the next study session gets this index, then it is cleared */
  manualReissue?: number;
  manualReissueReason?: string;
  /** rebuilt after a loss: the next assignment logs progressRecovered, then it is cleared */
  recovered?: true;
  /** schedule without progress and nothing to rebuild it from: study sessions blocked until setNext */
  lost?: true;
}

/** Validity of a study session from its events (same rule as the host: user turns + the LAST session rating). */
export function studySessionRecord(events: Array<{ type?: string; [k: string]: unknown }>): StudySessionRecord | null {
  const start = events.find((e) => e.type === "session_start") as { sessionId?: unknown; study?: { index?: unknown; scheduleHash?: unknown } } | undefined;
  const st = start?.study;
  if (!st || typeof st.index !== "number" || typeof st.scheduleHash !== "string") return null;
  const userTurns = events.filter((e) => e.type === "user_turn").length;
  const r = events.filter((e) => e.type === "rating" && e.scope === "session");
  const lastVal = r.length ? r[r.length - 1]!.value : null;
  return {
    ...(typeof start!.sessionId === "string" ? { sessionId: start!.sessionId } : {}),
    index: st.index, scheduleHash: st.scheduleHash,
    valid: userTurns >= STUDY_MIN_USER_TURNS && lastVal !== null && lastVal !== undefined,
  };
}
export function studySessionRecordFromJsonl(jsonl: string): StudySessionRecord | null {
  const ev: Array<{ type?: string }> = [];
  for (const line of jsonl.split("\n")) { if (!line.trim()) continue; try { ev.push(JSON.parse(line)); } catch { /* skip */ } }
  return studySessionRecord(ev);
}
/**
 * Rebuild the next index from the study sessions found for this schedule: highest index h; next = h + 1 if any
 * session with index h was valid, else h (it is owed again). A valid index is never handed out again.
 * null = nothing found for this schedule.
 */
export function recoverNextIndex(records: StudySessionRecord[], scheduleHash: string): number | null {
  const mine = records.filter((r) => r && r.scheduleHash === scheduleHash && Number.isInteger(r.index) && r.index >= 1 && r.index <= STUDY_SESSIONS);
  if (!mine.length) return null;
  const h = Math.max(...mine.map((r) => r.index));
  return mine.some((r) => r.index === h && r.valid) ? h + 1 : h;
}

export class StudyController {
  constructor(
    private secret: SecretStore,
    /** LEGACY progress location (settings KV, builds <= E): read once, migrated into the secure store, removed */
    private legacyProgressKV: KeyValueStore,
    private opts: {
      randomSeed?: () => number;
      now?: () => Date;
      /** study sessions still on the device (local logs, upload ledger); used only when progress is missing */
      recover?: () => Promise<StudySessionRecord[]>;
    } = {},
  ) {}

  private static parse(raw: string): Progress {
    let p: Partial<Progress> = {};
    try { p = JSON.parse(raw) as Partial<Progress>; } catch { /* treated as missing fields */ }
    return { enabled: false, next: 1, ...p };
  }
  /**
   * Progress from the secure store. Throws if the secure store fails (Keychain unavailable): callers keep the
   * old Keychain-fail behaviour (status error, assign null). Missing -> migrate the legacy copy, else recover.
   */
  private async progress(): Promise<Progress> {
    const raw = await this.secret.get(STUDY_PROGRESS_KEY);
    if (raw) return StudyController.parse(raw);
    let legacy: string | null = null;
    try { legacy = await this.legacyProgressKV.get(STUDY_PROGRESS_KEY); } catch { /* unreadable = absent */ }
    if (legacy) {
      const p = StudyController.parse(legacy);
      await this.saveProgress(p); // read-back verified before the old copy goes
      try { await this.legacyProgressKV.remove(STUDY_PROGRESS_KEY); } catch { /* harmless: the secure copy wins */ }
      return p;
    }
    const sch = await this.rawSchedule();
    if (!sch) return { enabled: false, next: 1 };
    // schedule survived, progress did not (eviction / reinstall): never silently restart at index 1
    let records: StudySessionRecord[] = [];
    try { records = (await this.opts.recover?.()) ?? []; } catch { records = []; }
    const next = recoverNextIndex(records, sha256HexSync(sch));
    const p: Progress = next === null ? { enabled: false, next: 1, lost: true } : { enabled: true, next, recovered: true };
    await this.saveProgress(p);
    return p;
  }
  private async saveProgress(p: Progress) {
    const raw = JSON.stringify(p);
    await this.secret.set(STUDY_PROGRESS_KEY, raw);
    if ((await this.secret.get(STUDY_PROGRESS_KEY)) !== raw) throw new Error("secure store did not keep the study progress (read-back mismatch)");
  }
  private async rawSchedule(): Promise<string | null> {
    return (await this.secret.get(STUDY_SCHEDULE_KEY)) || null; // "" = cleared (SecretStore has no delete)
  }

  /**
   * Discard a schedule sealed under an older protocol (or none = practice build): clears the schedule and the
   * study progress so "Start study" generates a fresh one. Touches nothing else (session files, upload queue).
   * Called on launch and before every study operation; a no-op when the protocol is current.
   */
  async ensureProtocol(): Promise<{ reset: boolean; from?: number | null }> {
    const raw = await this.rawSchedule();
    if (!raw) return { reset: false };
    let protocol: number | null = null;
    try { const p = (JSON.parse(raw) as StudySchedule).protocol; protocol = typeof p === "number" ? p : null; } catch { /* malformed: discard too */ }
    if (protocol !== null && protocol >= STUDY_PROTOCOL_VERSION) return { reset: false };
    if (this.secret.remove) await this.secret.remove(STUDY_SCHEDULE_KEY);
    else await this.secret.set(STUDY_SCHEDULE_KEY, "");
    if (await this.rawSchedule()) throw new Error("secure store did not clear the outdated study schedule");
    await this.saveProgress({ enabled: false, next: 1 });
    try { await this.legacyProgressKV.remove(STUDY_PROGRESS_KEY); } catch { /* the secure copy wins anyway */ }
    return { reset: true, from: protocol };
  }
  private async schedule(): Promise<{ raw: string; s: StudySchedule } | null> {
    const raw = await this.rawSchedule();
    if (!raw) return null;
    const s = JSON.parse(raw) as StudySchedule;
    if (s.study !== STUDY_ID || !Array.isArray(s.order) || s.order.length !== STUDY_SESSIONS) throw new Error("study schedule in the secure store is malformed");
    return { raw, s };
  }

  async status(): Promise<StudyStatus> {
    try { await this.ensureProtocol(); } catch { /* reported below via scheduled/error */ }
    try {
      const scheduled = !!(await this.rawSchedule());
      const p = await this.progress();
      return {
        enabled: p.enabled, next: p.next, total: STUDY_SESSIONS, scheduled, ...(p.manualReissue ? { pendingReissue: p.manualReissue } : {}),
        ...(p.lost ? { progressLost: true as const, error: STUDY_PROGRESS_LOST_NOTE } : {}), ...(p.recovered ? { progressRecovered: true as const } : {}),
      };
    } catch (err) {
      return { enabled: false, next: 1, total: STUDY_SESSIONS, scheduled: false, error: (err as Error).message };
    }
  }

  /**
   * Turn the study on. Generates the schedule once (before session 1) and stores it in the secure
   * store, verified by read-back; an existing schedule is never regenerated. Returns its hash.
   */
  async enable(): Promise<{ scheduleHash: string; protocol: number; createdAt: string }> {
    await this.ensureProtocol();
    let sch = await this.schedule();
    if (!sch) {
      const seed = (this.opts.randomSeed ?? randomSeed)() >>> 0;
      const s: StudySchedule = { study: STUDY_ID, version: 1, seed, order: generateSchedule(seed), createdAt: (this.opts.now?.() ?? new Date()).toISOString(), protocol: STUDY_PROTOCOL_VERSION };
      const raw = JSON.stringify(s);
      // fresh schedule: its progress first, so the schedule never exists without progress (no false "lost")
      const { lost: _l, recovered: _r, ...old } = await this.progress();
      void _l; void _r;
      await this.saveProgress({ ...old, enabled: true });
      await this.secret.set(STUDY_SCHEDULE_KEY, raw);
      if ((await this.rawSchedule()) !== raw) throw new Error("secure store did not keep the study schedule (read-back mismatch)");
      sch = { raw, s };
      return { scheduleHash: await sha256Hex(sch.raw), protocol: STUDY_PROTOCOL_VERSION, createdAt: s.createdAt };
    }
    const p = await this.progress();
    if (p.lost) throw new Error(STUDY_PROGRESS_LOST_NOTE);
    await this.saveProgress({ ...p, enabled: true });
    return { scheduleHash: await sha256Hex(sch.raw), protocol: sch.s.protocol ?? STUDY_PROTOCOL_VERSION, createdAt: sch.s.createdAt };
  }

  async disable(): Promise<void> {
    const p = await this.progress();
    if (p.lost) return; // stays blocked (and disabled) until setNext
    await this.saveProgress({ ...p, enabled: false });
  }

  /**
   * Assignment for a session that is starting. last(id) = what the previous study session logged. If it was
   * invalid (< STUDY_MIN_USER_TURNS user turns, or no answered session rating), this session gets the same
   * index (and therefore the same mode) and logs reissueOf. A bare number = user turns only (old callers):
   * then only a 0-reply session is reissued.
   * null = study off, finished, or the secure store failed (the session then runs adaptive, unlogged).
   */
  async assign(sessionId: string, last: (sessionId: string) => number | StudySessionInfo): Promise<StudyAssignment | null> {
    try { await this.ensureProtocol(); } catch { return null; }
    let p: Progress;
    try { p = await this.progress(); } catch { return null; } // secure store failed: no study fields
    if (!p.enabled || p.lost) return null;
    let index = p.next;
    let next = p.next;
    let reissueOf: string | undefined;
    let lastInvalid = false;
    if (p.last) {
      const info = last(p.last.sessionId);
      lastInvalid = typeof info === "number" ? info === 0 : info.userTurns < STUDY_MIN_USER_TURNS || !info.sessionRated;
      if (lastInvalid) { index = p.last.index; reissueOf = p.last.sessionId; }
    }
    const manual = typeof p.manualReissue === "number" && p.manualReissue >= 1 && p.manualReissue <= STUDY_SESSIONS ? p.manualReissue : null;
    if (manual !== null) {
      index = manual;
      reissueOf = "manual";
      // an invalid previous session still owes its index: it comes right after the redo
      next = lastInvalid && p.last ? Math.min(p.next, p.last.index) : p.next;
    } else {
      next = index + 1;
    }
    if (index > STUDY_SESSIONS) return null;
    let sch: Awaited<ReturnType<StudyController["schedule"]>>;
    try {
      sch = await this.schedule();
    } catch {
      return null;
    }
    if (!sch) return null;
    try { await this.saveProgress({ enabled: true, next, last: { sessionId, index } }); } catch { return null; } // never hand out an index we could not record
    return {
      study: STUDY_ID, index, total: STUDY_SESSIONS, scheduleHash: await sha256Hex(sch.raw), adaptation: sch.s.order[index - 1]!, protocol: sch.s.protocol ?? STUDY_PROTOCOL_VERSION,
      ...(reissueOf ? { reissueOf } : {}), ...(manual !== null ? { manualReissue: true as const, ...(p.manualReissueReason ? { reissueReason: p.manualReissueReason } : {}) } : {}),
      ...(p.recovered ? { progressRecovered: true as const } : {}),
    };
  }

  /**
   * Manual redo (Settings > Study "Redo study session n"): the next study session gets index n again (same mode,
   * never shown) and logs reissueOf "manual" + manualReissue true. Needs the phrase reissuePhrase(n) and an index
   * that was already assigned (1..next-1, at most 10). Persisted in the study progress; the schedule and its hash
   * are untouched. A later request replaces a pending one.
   */
  async requestReissue(n: number, confirm: string, reason?: string): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
    await this.ensureProtocol();
    if (!Number.isInteger(n) || n < 1 || n > STUDY_SESSIONS) return { ok: false, error: `study session must be 1..${STUDY_SESSIONS}` };
    if (confirm.trim() !== reissuePhrase(n)) return { ok: false, error: `type "${reissuePhrase(n)}" to confirm` };
    const why = (reason ?? "").replace(/\s+/g, " ").trim();
    if (why.length > REISSUE_REASON_MAX) return { ok: false, error: `reason: at most ${REISSUE_REASON_MAX} characters` };
    if (!(await this.rawSchedule())) return { ok: false, error: "no study schedule (start the study first)" };
    const p = await this.progress();
    if (p.lost) return { ok: false, error: `${STUDY_PROGRESS_LOST_NOTE} (then use Set next study session)` };
    if (n > p.next - 1) return { ok: false, error: `study session ${n} has not been run yet` };
    const { manualReissueReason: _old, ...rest } = p;
    void _old;
    await this.saveProgress({ ...rest, manualReissue: n, ...(why ? { manualReissueReason: why } : {}) });
    return { ok: true, index: n };
  }

  /**
   * Unblock after "Study progress lost" (or correct the next index on the Researcher's instruction): the next
   * study session gets index n (1..10). Needs the phrase setNextPhrase(n) and a sealed schedule. The schedule is
   * untouched; the next session_start logs progressRecovered true.
   */
  async setNext(n: number, confirm: string): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
    await this.ensureProtocol();
    if (!Number.isInteger(n) || n < 1 || n > STUDY_SESSIONS) return { ok: false, error: `study session must be 1..${STUDY_SESSIONS}` };
    if (confirm.trim() !== setNextPhrase(n)) return { ok: false, error: `type "${setNextPhrase(n)}" to confirm` };
    if (!(await this.rawSchedule())) return { ok: false, error: "no study schedule (start the study first)" };
    await this.saveProgress({ enabled: true, next: n, recovered: true });
    return { ok: true, index: n };
  }

  /** drop a pending manual redo */
  async cancelReissue(): Promise<void> {
    const { manualReissue: _drop, manualReissueReason: _r, ...p } = await this.progress();
    void _drop; void _r;
    await this.saveProgress(p);
  }

  /** sha256 of the stored schedule (safe to print: reveals nothing about the order). */
  async hash(): Promise<string | null> {
    const raw = await this.rawSchedule();
    return raw ? sha256Hex(raw) : null;
  }

  /** The sealed schedule, only with the exact confirmation phrase (after session 10). */
  /** raw = the exact secure-store string; scheduleHash = sha256 hex of raw (re-check: sha256(raw) === scheduleHash). */
  async unseal(confirm: string): Promise<StudySchedule & { scheduleHash: string; raw: string }> {
    if (confirm !== UNSEAL_PHRASE) throw new Error(`unseal needs the confirmation phrase "${UNSEAL_PHRASE}"`);
    const sch = await this.schedule();
    if (!sch) throw new Error("no study schedule in the secure store");
    return { ...sch.s, scheduleHash: await sha256Hex(sch.raw), raw: sch.raw };
  }
}

/**
 * The unsealed schedule as a file: content = the exact secure-store string (no trailing newline, no
 * re-serialisation), so sha256(file bytes) === scheduleHash. export-ratings --schedule accepts it directly.
 */
export function scheduleExportFile(u: { raw: string; scheduleHash: string }): ExportFile {
  return { name: `phaseD-schedule-${u.scheduleHash.slice(0, 12)}.json`, content: u.raw, mimeType: "application/json" };
}

/** SecretStore over a CredentialStoreLike (Electron's encrypted credentials file). */
export function credentialSecretStore(store: {
  read(id: string): Promise<unknown>;
  modify(id: string, fn: (cur: unknown) => Promise<unknown>): Promise<unknown>;
}): SecretStore {
  return {
    get: async (key) => {
      const c = (await store.read(key)) as { type?: string; value?: string } | undefined;
      return c && c.type === "secret" && typeof c.value === "string" ? c.value : null;
    },
    set: async (key, value) => void (await store.modify(key, async () => ({ type: "secret", value }))),
  };
}
