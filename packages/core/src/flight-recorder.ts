/**
 * In-app bug report ("Report"): an always-on flight recorder + the report document a triage agent reads instead
 * of a screen recording. Schema: docs/FEEDBACK_REPORT_SCHEMA.md (`brianharness-feedback/1`). Browser-safe.
 *
 *   FlightRecorder        ring buffer of the last 200 {ts, type, data} events (memory only; never persisted)
 *   recordingBackend      wraps a ModelBackend: one `chat` event per Director reply (model, max_tokens, status, ms,
 *                         finish_reason, usage, truncated, error), read from the GenerateResult / error the P0 fix
 *                         attaches (backends.ts); the reply itself is untouched
 *   buildFeedbackReport   header + events + last 6 chat turns -> one JSON document <= 100 KB, redacted, study-safe
 *
 * Study safety: during a study session (header.study.inStudy) the report keeps study state as {inStudy, index} only
 * and drops plan / stateNote / mode / hypothesis / interest-map / blindGuess fields and arm-like string values from
 * every event, so a report never tells the arms apart. Building or sending a report touches no study, schedule,
 * timing or session record (the session log gets only the feedback_open / feedback_sent / feedback_closed lines).
 */
import type { GenerateRequest, GenerateResult, ModelBackend } from "./backends.js";

export const FEEDBACK_SCHEMA = "brianharness-feedback/1";
export const FEEDBACK_MAX_BYTES = 100 * 1024;
export const FLIGHT_RECORDER_CAPACITY = 200;
/** per-message cap in screen snapshots and chat turns (before any over-budget trimming) */
export const FEEDBACK_TEXT_CAP = 500;
export const FEEDBACK_CHAT_TURNS = 6;

export type FlightEventType = "screen" | "tap" | "chat" | "error" | "state";
export interface FlightEvent { ts: number; type: FlightEventType; data: Record<string, unknown> }

export class FlightRecorder {
  private buf: FlightEvent[] = [];
  private listeners = new Set<(e: FlightEvent) => void>();
  private studyFlag = false;
  private studyProbe: (() => boolean) | null = null;
  constructor(private o: { capacity?: number; now?: () => number } = {}) {}
  get capacity() { return this.o.capacity ?? FLIGHT_RECORDER_CAPACITY; }
  /**
   * study session in progress: from then on every event is stored study-scrubbed (studyScrubEvent: no raw error
   * text, no prompt sizes / prompt_tokens, no plan / mode). Set by the UI (hud.study) and probed from the transport
   * (the host's live session), so the first turn of a study session is covered before the UI catches up.
   */
  set study(v: boolean) { this.studyFlag = v; }
  get study(): boolean {
    if (this.studyFlag) return true;
    try { return !!this.studyProbe?.(); } catch { return false; }
  }
  setStudyProbe(fn: (() => boolean) | null) { this.studyProbe = fn; }
  /** never throws (a recorder bug must not break the app) */
  record(type: FlightEventType, data: Record<string, unknown> = {}): void {
    try {
      const raw: FlightEvent = { ts: this.o.now?.() ?? Date.now(), type, data };
      const r = ratingScrubEvent(raw); // always (study and practice): no absorption-rating value, label or state
      const e = this.study ? studyScrubEvent(r) : r;
      this.buf.push(e);
      if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
      for (const l of this.listeners) try { l(e); } catch { /* ignore */ }
    } catch { /* ignore */ }
  }
  /** oldest first (a copy) */
  events(): FlightEvent[] { return this.buf.slice(); }
  last(type?: FlightEventType): FlightEvent | undefined {
    for (let i = this.buf.length - 1; i >= 0; i--) if (!type || this.buf[i]!.type === type) return this.buf[i];
    return undefined;
  }
  clear() { this.buf = []; }
  onRecord(cb: (e: FlightEvent) => void): () => void { this.listeners.add(cb); return () => void this.listeners.delete(cb); }
}

// ---------------------------------------------------------------- redaction
export const REDACTED = "[REDACTED]";
/**
 * a secret FIELD's replacement value: under 8 chars on purpose, so `"password":"[***]"` doesn't trip the
 * secret_field rule of the Worker scan / UPLOAD_SECRET_PATTERNS (`"<secret-ish key>":"<8+ chars>"`)
 */
export const REDACTED_FIELD = "[***]";
/** secret-looking substrings (superset of UPLOAD_SECRET_PATTERNS, upload-body.ts, and the Worker's scan.ts rules) */
export const FEEDBACK_SECRET_PATTERNS: RegExp[] = [
  /\bbh[dr]_[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT (e.g. an Apple identity token)
  /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16,}/g, // Ollama-style key
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
/** Shannon entropy, bits per char */
function entropy(t: string): number {
  const f = new Map<string, number>();
  for (const c of t) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const q = n / t.length; h -= q * Math.log2(q); }
  return h;
}
/**
 * The Worker's generic rule (scan.ts genericSecret), applied as a replacement: base64/base64url runs of 40+ chars with
 * upper + lower + >= 4 digits and >= 4 bits/char entropy, and hex segments of 48+ chars (except exactly 64, a sha256).
 */
function redactGenericRuns(t: string): string {
  return t.replace(/[A-Za-z0-9+/_=-]{40,}/g, (run) => {
    for (const seg of run.split(/[-=]/)) if (seg.length >= 48 && seg.length !== 64 && /^[0-9a-fA-F]+$/.test(seg)) return REDACTED;
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && (run.match(/[0-9]/g)?.length ?? 0) >= 4 && entropy(run) >= 4) return REDACTED;
    return run;
  });
}
/** field names whose value is always replaced: *key, *token (not *tokens), nonce, identityToken, appleUser, ... */
export function isSecretKey(k: string): boolean {
  const n = k.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return false;
  if (["nonce", "appleuser", "authorization", "auth", "secret", "password", "passwd", "passcode", "cookie", "setcookie", "credential", "credentials", "bearer", "otp"].includes(n)) return true;
  return n.endsWith("token") || n.endsWith("key") || n.endsWith("secret") || n.endsWith("nonce") || n.endsWith("password");
}
export function redactString(s: string): string {
  let out = s;
  for (const re of FEEDBACK_SECRET_PATTERNS) out = out.replace(re, (m) => (/^bearer\s/i.test(m) ? `Bearer ${REDACTED}` : REDACTED));
  return redactGenericRuns(out);
}
/** deep copy with secret fields and secret-looking strings replaced; non-JSON values dropped */
export function redactDeep<T>(v: T, depth = 0): T {
  if (depth > 12) return null as T;
  if (typeof v === "string") return redactString(v) as T;
  if (typeof v === "number") return (Number.isFinite(v) ? v : null) as T;
  if (v === null || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1)) as T;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === "function") continue;
      out[k] = isSecretKey(k) && x !== null && x !== "" ? REDACTED_FIELD : redactDeep(x, depth + 1);
    }
    return out as T;
  }
  return null as T;
}

// ---------------------------------------------------------------- absorption ratings (always, study or not)
/**
 * The 1-5 absorption ratings (per-turn probe, session rating) and the blinding check are study OUTPUTS: a report must
 * never carry a rating value, which option was checked, or the option's label / index (Researcher blinding check,
 * Nov 3 2026). The UI layer already records rating controls as a generic "rating option" (apps/desktop
 * feedback/snapshot.ts ratingControl); this is the core-side backstop, applied at record time and at report build.
 */
export const RATING_GENERIC_LABELS = new Set(["rating option", "blinding-check option", "rating control", "rating text field"]);
/** by PREFIX, case-insensitive: rating*, absorption* (e.g. absorption_value), hooked*, blindguess / blind_guess / blind-guess* */
const RATING_DROP_KEYS = /^(?:rating|absorption|hooked|blind[_-]?guess)/i;
const RATING_SCREENS = new Set(["turn-probe", "session-rating"]);
const DIGIT_LABEL = /^\s*[1-5]\s*$/;
function dropRatingKeys(v: unknown, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => dropRatingKeys(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!RATING_DROP_KEYS.test(k)) out[k] = dropRatingKeys(x, depth + 1);
  return out;
}
/** a control / tap inside the rating UI -> {label|name, control} only; idempotent, never throws */
export function ratingScrubEvent(e: FlightEvent): FlightEvent {
  try {
    const d = dropRatingKeys(e.data ?? {}) as Record<string, any>;
    const overlays: unknown[] = Array.isArray(d.overlays) ? d.overlays : [];
    const onRating = RATING_SCREENS.has(String(d.screen)) || overlays.some((o) => RATING_SCREENS.has(String(o)));
    // any 1-5 digit label on a rating screen is generic, whatever the control type (radio, button, ...); state dropped below
    const generic = (label: unknown) => RATING_GENERIC_LABELS.has(String(label)) || (onRating && DIGIT_LABEL.test(String(label)));
    if (e.type === "tap" && generic(d.name)) {
      const name = RATING_GENERIC_LABELS.has(String(d.name)) ? d.name : "rating option";
      return { ts: e.ts, type: e.type, data: { name, control: typeof d.control === "string" ? d.control : "radio", ...(typeof d.screen === "string" ? { screen: d.screen } : {}) } };
    }
    if (e.type === "screen" && Array.isArray(d.controls)) {
      d.controls = d.controls.map((c: any) => (c && generic(c.label) ? { label: RATING_GENERIC_LABELS.has(String(c.label)) ? c.label : "rating option", control: typeof c.control === "string" ? c.control : "radio" } : c));
    }
    return { ts: e.ts, type: e.type, data: d };
  } catch {
    return { ts: e.ts, type: e.type, data: {} };
  }
}

// ---------------------------------------------------------------- study safety
/** keys that could describe the Director's plan / the arm; dropped from every event during a study session */
const STUDY_DROP_KEYS = /^(?:plan|statenote|mode|hypothesis|toptopics|topstyles|interestmap|blindguess|adaptation|studymode|studyarm|arm|condition|assignment|schedule|schedulehash|order|seed)$/i;
const ARM_VALUE = /^\s*(?:adaptive|baseline|explore|exploit|relax)\s*$/i;
/**
 * prompt / state-note SIZE fields: the adaptive arm's Director prompt carries the plan + state note, so its size
 * tells the arms apart (Researcher). Kept as keys (same shape in both arms) but nulled, like the session log does.
 */
const STUDY_NULL_KEYS = /^(?:prompttokens|inputtokens|totaltokens|cachedtokens|prompt(?:chars|bytes|len|length|size)|statenote(?:chars|bytes|len|length|size|tokens)|system(?:prompt)?(?:chars|bytes|len|length|size|tokens)|messages(?:chars|bytes|len|length|size))$/i;
export function studySafe<T>(v: T, depth = 0): T {
  if (depth > 12) return null as T;
  if (typeof v === "string") return (ARM_VALUE.test(v) ? "[omitted]" : v) as T;
  if (Array.isArray(v)) return v.map((x) => studySafe(x, depth + 1)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (STUDY_DROP_KEYS.test(k.replace(/[_-]/g, ""))) continue;
      if (STUDY_NULL_KEYS.test(k.replace(/[_-]/g, ""))) { out[k] = null; continue; }
      if (k === "study" && x && typeof x === "object") { out[k] = coarseStudy(x as Record<string, unknown>); continue; }
      out[k] = studySafe(x, depth + 1);
    }
    return out as T;
  }
  return v;
}
/** the only study state a report carries */
export function coarseStudy(s: { inStudy?: unknown; index?: unknown } | null | undefined): { inStudy: boolean; index: number | null } {
  const inStudy = !!s && (s.inStudy === true || (s.inStudy === undefined && typeof s.index === "number"));
  return { inStudy, index: inStudy && typeof s?.index === "number" ? s.index : null };
}

/**
 * The session log's short error code (session.ts errorCode, ee99b5a): err.code, "aborted", "http_<status>", else
 * "stream_error". Never err.message: an HTTP error message can quote up to 300 chars of the response body.
 */
export function shortErrorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; status?: unknown } | null | undefined;
  if (typeof e?.code === "string" && e.code) return e.code.slice(0, 64);
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "aborted";
  return typeof e?.status === "number" && Number.isInteger(e.status) ? `http_${e.status}` : "stream_error";
}
/** what an on-screen error message (`⚠ <message>`) becomes in a study session */
export const STUDY_ERROR_TEXT = "⚠ [error text omitted]";
const SAFE_NOTICE = /^(?:Reply cut off[^{}]{0,80}|Reply interrupted[^{}]{0,80}|Sending…|Thinking…)$/;
const studyNotice = (t: unknown) => (typeof t === "string" && SAFE_NOTICE.test(t) ? t : "[notice omitted]");
const isErrorText = (t: unknown) => typeof t === "string" && t.trimStart().startsWith("⚠");
/**
 * One flight event as it may exist during a study session (Researcher / prompt_tokens sweep): studySafe (no plan /
 * mode / arm words; prompt_tokens and every prompt / state-note size nulled), plus
 * - error: {source, plugin?, method?, code, status?, partial?, where?} only, never the message
 * - chat: error = {code} only
 * - screen: on-screen error messages -> STUDY_ERROR_TEXT; notices other than the fixed reply notes -> "[notice omitted]"
 * Idempotent, never throws.
 */
export function studyScrubEvent(e: FlightEvent): FlightEvent {
  try {
    const d = studySafe(e.data ?? {}) as Record<string, any>;
    if (e.type === "error") {
      const out: Record<string, unknown> = { source: typeof d.source === "string" ? d.source : "unknown", code: typeof d.code === "string" && d.code ? d.code : shortErrorCode(d) };
      for (const k of ["plugin", "method", "status", "partial", "where"]) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
      return { ts: e.ts, type: e.type, data: out };
    }
    if (e.type === "chat" && d.error) d.error = { code: typeof d.error === "object" && typeof d.error.code === "string" ? d.error.code : typeof d.error === "string" ? d.error : "stream_error" };
    if (e.type === "screen") {
      if (Array.isArray(d.messages)) d.messages = d.messages.map((m: any) => (m && isErrorText(m.text) ? { ...m, text: STUDY_ERROR_TEXT } : m));
      if (Array.isArray(d.notices)) d.notices = d.notices.map(studyNotice);
    }
    return { ts: e.ts, type: e.type, data: d };
  } catch {
    return { ts: e.ts, type: e.type, data: {} };
  }
}

// ---------------------------------------------------------------- chat events from the backend layer
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (s: unknown, n = 200) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : s == null ? null : String(s).slice(0, n));

/**
 * One `chat` event per generate() call. Fields come from the P0 fix: GenerateResult.{model, maxTokens, finishReason,
 * usage} on success, and err.{maxTokens, model, status, code} on failure. truncated = finish_reason "length", or a
 * failure after part of the reply streamed (same rule as director_turn.truncated).
 */
export function recordingBackend(b: ModelBackend, rec: FlightRecorder | null | undefined, now: () => number = Date.now): ModelBackend {
  if (!rec) return b;
  const generate = async (req: GenerateRequest): Promise<GenerateResult> => {
    const t0 = now();
    let streamedChars = 0;
    const onToken = req.onToken ? (d: string) => { streamedChars += d?.length ?? 0; req.onToken!(d); } : undefined;
    try {
      const g = await b.generate({ ...req, ...(onToken ? { onToken } : {}) });
      const finish = g.finishReason ?? null;
      rec.record("chat", {
        backend: b.id, model: g.model ?? b.id.replace(/^[a-z-]+:/, ""), max_tokens: num(g.maxTokens), status: b.id === "mock" ? null : 200, ms: now() - t0,
        finish_reason: finish, usage: { prompt_tokens: num(g.usage?.inputTokens), completion_tokens: num(g.usage?.outputTokens), reasoning_tokens: num(g.usage?.reasoningTokens) },
        truncated: finish === "length", error: null, streamed: !!onToken, chars: g.text?.length ?? 0,
      });
      return g;
    } catch (err) {
      const e = (err ?? {}) as { maxTokens?: unknown; model?: unknown; status?: unknown; code?: unknown; name?: unknown; message?: unknown };
      const code = shortErrorCode(e);
      const message = rec.study ? null : redactString(short(e.message, 300) ?? ""); // study: code only (record() scrubs too)
      rec.record("chat", {
        backend: b.id, model: typeof e.model === "string" ? e.model : b.id.replace(/^[a-z-]+:/, ""), max_tokens: num(e.maxTokens), status: num(e.status), ms: now() - t0,
        finish_reason: null, usage: { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null },
        truncated: streamedChars > 0, error: { code, message }, streamed: !!onToken, chars: streamedChars,
      });
      rec.record("error", { source: "stream", code, message, status: num(e.status), partial: streamedChars > 0 });
      throw err;
    }
  };
  return { get id() { return b.id; }, get paid() { return b.paid; }, generate };
}

/** rejections of a native (Capacitor) plugin's methods become `error` events {source:"native", plugin, method, code} */
export function recordPluginRejections<T extends object>(name: string, plugin: T, rec: FlightRecorder | null | undefined): T {
  if (!rec || !plugin) return plugin;
  return new Proxy(plugin, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string" || prop === "addListener" || prop === "removeAllListeners" || prop === "then") return v;
      return (...args: unknown[]) => {
        const r = v.apply(target, args);
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).then(undefined, (err: { code?: unknown; message?: unknown }) => {
            rec.record("error", { source: "native", plugin: name, method: prop, code: typeof err?.code === "string" ? err.code : null, message: redactString(short(err?.message, 300) ?? "") });
          });
        }
        return r;
      };
    },
  });
}

// ---------------------------------------------------------------- report
export interface FeedbackChatTurn { role: "user" | "assistant"; text: string; cutOff?: boolean; failed?: boolean; streaming?: boolean; error?: boolean }
export interface FeedbackHeaderInput {
  build?: string | number | null; commit?: string | null; appVersion?: string | null;
  device?: string | null; os?: string | null; orientation?: string | null; platform?: string | null;
  bundleId?: string | null;
  appState?: Record<string, unknown>; note?: string; sessionId?: string | null;
  study?: { inStudy: boolean; index?: number | null } | null;
  /** what opened the sheet: "sidebar" | "shortcut" | "shake" | "hook" */
  trigger?: string;
}
/**
 * The POST /v1/feedback body. Envelope (brianharness-worker docs/FEEDBACK.md): schema, report_id (uuid v4), kind,
 * created_at, summary (the note, <= 500 chars), app {version, build, commit} strings, filters {inStudy,
 * truncated_turns, last_error_code, platform}. The Worker treats `payload` as opaque; FEEDBACK_REPORT_SCHEMA.md.
 * Optional envelope fields are omitted when unknown (the Worker counts null as absent too).
 */
export interface FeedbackReport {
  schema: typeof FEEDBACK_SCHEMA;
  report_id: string;
  kind: "bug";
  created_at: string;
  summary?: string;
  app: { bundle_id?: string; version?: string; build?: string; commit?: string };
  filters: { inStudy: boolean; truncated_turns: number; last_error_code?: string; platform: "ios" | "desktop" | "web" };
  payload: FeedbackPayload;
}
export interface FeedbackPayload {
  header: {
    report_id: string; build: string | null; commit: string | null; app_version: string | null; device: string | null; os: string | null;
    orientation: string | null; platform: string | null; app_state: Record<string, unknown>; note: string; last_error_summary: string | null;
    sessionId: string | null; study: { inStudy: boolean; index: number | null }; trigger: string | null;
    counts: { events_recorded: number; events_included: number; events_dropped: number; text_cap: number; bytes: number };
  };
  events: FlightEvent[];
  chat_turns: FeedbackChatTurn[];
}
export const FEEDBACK_SUMMARY_MAX = 500;
/** Worker filters.platform */
export function envelopePlatform(p: string | null | undefined): "ios" | "desktop" | "web" {
  const s = String(p ?? "").toLowerCase();
  if (/^ios|iphone|ipad/.test(s)) return "ios";
  if (/electron|desktop|darwin|mac|win|linux/.test(s)) return "desktop";
  return "web";
}
/** summary: newlines / tabs allowed, other control characters removed (Worker rule) */
// eslint-disable-next-line no-control-regex
const summaryText = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, FEEDBACK_SUMMARY_MAX);
/** the newest error code: an `error` event's code or a failed chat's error.code */
export function lastErrorCode(events: FlightEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!; const d = e.data as Record<string, any>;
    if (e.type === "error") return typeof d.code === "string" && d.code ? d.code.slice(0, 128) : String(d.source ?? "error").slice(0, 128);
    if (e.type === "chat" && d.error) return String(d.error.code ?? "chat_error").slice(0, 128);
  }
  return null;
}

/** RFC 4122 v4 from getRandomValues (crypto.randomUUID needs a secure context; a LAN http:// page has none) */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** one line: the newest error / failed chat / cut-off reply, e.g. "chat gpt-oss:20b-cloud finish_reason=length (truncated) 12.3s ago" */
export function lastErrorSummary(events: FlightEvent[], now = Date.now()): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const ago = `${Math.max(0, Math.round((now - e.ts) / 100) / 10)}s ago`;
    const d = e.data as Record<string, any>;
    if (e.type === "error") return oneLine(`error[${d.source ?? "?"}]${d.plugin ? ` ${d.plugin}.${d.method}` : ""}${d.code ? ` ${d.code}` : ""}${d.message ? `: ${d.message}` : ""} (${ago})`);
    if (e.type === "chat" && (d.error || d.truncated)) {
      return oneLine(`chat ${d.model ?? "?"} ${d.error ? `error ${d.error.code}${d.status ? ` HTTP ${d.status}` : ""}${d.error.message ? `: ${d.error.message}` : ""}` : `finish_reason=${d.finish_reason}`}${d.truncated ? " (truncated)" : ""} max_tokens=${d.max_tokens ?? "?"} (${ago})`);
    }
  }
  return null;
}
const oneLine = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > 240 ? `${t.slice(0, 239)}…` : t; };

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);
function capTexts<T>(v: T, n: number, depth = 0): T {
  if (depth > 12) return v;
  if (typeof v === "string") return cap(v, n) as T;
  if (Array.isArray(v)) return v.map((x) => capTexts(x, n, depth + 1)) as T;
  if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = capTexts(x, n, depth + 1); return o as T; }
  return v;
}
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/**
 * The report document. Redacted, study-safe when header.study.inStudy, at most maxBytes (UTF-8 of the JSON):
 * over budget -> drop the oldest events first (down to the newest 20), then cap every string shorter (500 -> 40
 * chars, chat turns and the note included), then drop the remaining oldest events.
 */
export function buildFeedbackReport(
  input: { events: FlightEvent[]; chatTurns: FeedbackChatTurn[]; header: FeedbackHeaderInput },
  o: { now?: number; reportId?: string; maxBytes?: number } = {},
): FeedbackReport {
  const now = o.now ?? Date.now();
  const maxBytes = o.maxBytes ?? FEEDBACK_MAX_BYTES;
  const h = input.header;
  const study = coarseStudy(h.study ?? null);
  const safe = <T>(v: T): T => (study.inStudy ? studySafe(redactDeep(v)) : redactDeep(v));
  const reportId = o.reportId ?? uuidV4();
  // study: every event study-scrubbed again (events recorded before the flag was set, e.g. a practice chat earlier
  // in the buffer, get the same treatment): no raw error text, no prompt sizes, no plan / mode
  // always: the rating backstop (no rating value / checked option / label, study or practice)
  const srcEvents = input.events.map((e) => (study.inStudy ? studyScrubEvent(ratingScrubEvent(e)) : ratingScrubEvent(e)));
  let events = safe(srcEvents.map((e) => ({ ts: e.ts, type: e.type, data: capTexts(e.data, FEEDBACK_TEXT_CAP) })));
  const recorded = input.events.length;
  let turns = safe(input.chatTurns.slice(-FEEDBACK_CHAT_TURNS).map((t) => {
    const text = String(t.text ?? "");
    return { ...t, text: study.inStudy && (t.error || isErrorText(text)) ? STUDY_ERROR_TEXT : cap(text, FEEDBACK_TEXT_CAP) };
  }));
  const lastErr = lastErrorSummary(srcEvents, now);
  const s = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  const baseHeader = safe({
    report_id: reportId, build: s(h.build), commit: s(h.commit), app_version: s(h.appVersion), device: s(h.device), os: s(h.os), orientation: s(h.orientation), platform: s(h.platform),
    app_state: h.appState ?? {}, note: cap(String(h.note ?? "").trim(), 4000), last_error_summary: lastErr ? redactString(lastErr) : null,
    sessionId: s(h.sessionId), study, trigger: s(h.trigger),
  });
  if (study.inStudy) baseHeader.study = study; // studySafe keeps it coarse; make it exact
  let textCap = FEEDBACK_TEXT_CAP;
  const summary = summaryText(redactString(String(h.note ?? "")));
  const code = lastErrorCode(srcEvents);
  const truncatedTurns = srcEvents.filter((e) => e.type === "chat" && (e.data as { truncated?: unknown }).truncated === true).length;
  const app: FeedbackReport["app"] = {};
  if (h.bundleId) app.bundle_id = String(h.bundleId).slice(0, 256);
  if (baseHeader.app_version) app.version = baseHeader.app_version.slice(0, 64);
  if (baseHeader.build) app.build = baseHeader.build.slice(0, 64);
  if (baseHeader.commit) app.commit = baseHeader.commit.slice(0, 64);
  const make = (): FeedbackReport => ({
    schema: FEEDBACK_SCHEMA, report_id: reportId, kind: "bug", created_at: new Date(now).toISOString(),
    ...(summary ? { summary } : {}),
    app,
    filters: { inStudy: study.inStudy, truncated_turns: truncatedTurns, ...(code ? { last_error_code: redactString(code) } : {}), platform: envelopePlatform(h.platform) },
    payload: {
      header: { ...baseHeader, counts: { events_recorded: recorded, events_included: events.length, events_dropped: recorded - events.length, text_cap: textCap, bytes: 0 } },
      events, chat_turns: turns,
    },
  });
  const size = (r: FeedbackReport) => utf8(JSON.stringify(r));
  let r = make();
  // 1) oldest events first (keep the newest 20 for now)
  while (size(r) > maxBytes && events.length > 20) {
    const over = size(r) - maxBytes;
    const avg = Math.max(1, utf8(JSON.stringify(events)) / events.length);
    events = events.slice(Math.min(events.length - 20, Math.max(1, Math.ceil(over / avg))));
    r = make();
  }
  // 2) then message text, shorter and shorter
  for (const n of [300, 200, 120, 80, 40]) {
    if (size(r) <= maxBytes) break;
    textCap = n;
    events = events.map((e) => ({ ...e, data: capTexts(e.data, n) }));
    turns = turns.map((t) => ({ ...t, text: cap(t.text, n) }));
    baseHeader.note = cap(baseHeader.note, Math.max(n * 4, 400));
    r = make();
  }
  // 3) whatever it takes
  while (size(r) > maxBytes && events.length) { events = events.slice(Math.max(1, Math.ceil(events.length / 4))); r = make(); }
  r.payload.header.counts.bytes = size(r);
  r.payload.header.counts.bytes = size(r); // the count's own digits
  return r;
}
