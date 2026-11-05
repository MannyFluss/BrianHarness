/**
 * contract-v1.1: shared blinding rules (data in blinding.json, also read by tools/phaseD/check_blinding.mjs) and the
 * client-side mirror of the blinded guard the Researcher approved (Nov 4 2026). Fail closed: an upload the guard
 * can't prove clean is rejected with a code, and the client writes a health line (upload.blinded_guard).
 */
import BLINDING from "./blinding.json" with { type: "json" };
import type { BhAdEventType } from "./events.js";
import { DEFAULT_POINTER_CONFIG, INPUT_MODES, LEGACY_INPUT_MODE, MODE_FORBIDDEN_TYPES, pointerEventViolation, type InputMode, type PointerEvent } from "./input-mode.js";

/** regex fragments of the arm-key list (protocol 4's ARM_KEYS, verbatim) */
export const ARM_KEY_PATTERNS: readonly string[] = BLINDING.armKeyPatterns;
/** ^(?:adaptation|study[_-]?mode|...)$ with flag i: a key that check_blinding and the guard treat as an arm key */
export const armKeyRegExp = (): RegExp => new RegExp(`^(?:${ARM_KEY_PATTERNS.join("|")})$`, "i");
export const SEALED_ONLY_HEALTH_CODES: readonly string[] = BLINDING.sealedOnlyHealthCodes;
/** v1.3: event types sealed-only in EVERY session type (tab_visible included): never in a visible or blinded main log */
export const SEALED_EVERYWHERE_TYPES: readonly string[] = BLINDING.sealedEverywhereTypes;
/** v1.3: type -> field "reason" value -> the generic value a non-sealed log carries instead (note_dropped leak_judge -> withheld) */
export const SEALED_EVERYWHERE_REASONS: Readonly<Record<string, Readonly<Record<string, string>>>> = BLINDING.sealedEverywhereReasons;

/** why the guard rejected an upload (client health detail; proposed to InfrastructureBot for the server side) */
export const BLINDED_GUARD_CODES = [
  "not_bh_ad", // a line that is not a bh-ad/1 JSON object
  "no_session_start", // the first line is not session_start (fail closed: the session type is unknown)
  "session_id_mismatch", // a line from another session
  "arm_field", // session_start.arm / p_inject in a blinded main log
  "tab_only_field", // actor_turn.note_id / actor_request_sha256 in a blinded main log
  "sealed_type", // a SEALED_ONLY_TYPES line in a blinded main log
  "prompt_tokens", // non-null actor_turn.usage.prompt_tokens in a blinded main log
  "sealed_health", // a director.leak_breaker health line in a blinded main log
  "arm_key", // any key matching the shared arm-key list, at any depth, in a blinded main log line
  "sealed_base_not_blinded", // a ".sealed" upload whose base session (or its own session_start) is not blinded (v1.3: or tab_visible with a matching base)
  "sealed_everywhere", // (v1.3) a sealedEverywhereTypes line, or a sealed-only reason value, in a non-sealed (visible or blinded main) log
  "unknown_event_type", // (v1.5) a type not in blinding.json eventTypes (any upload; never dropped silently)
  "gaze_raw_forbidden", // (v1.5) a gaze_raw line (any upload: raw gaze never goes through the Worker)
  "sim_marker", // (v1.5) a sim-only marker (bh-ad-sim-look/1, bh-ad-sim-walk/1, ...) anywhere in a line (any upload: eval vs sim is not marked in an upload)
  "session_id_too_long", // (v1.5) a base session id over 121 chars (<id>.sealed must fit 128)
  "input_mode_mismatch", // (v1.5) a line the session's input_mode may not write (gaze lines in pointer/none, pointer_l1 in gaze/none, a digest with the wrong sources), or an unknown input_mode
  "pointer_not_interactive", // (v1.5) a pointer event on an AOI not marked interactive in that message's aoi_layout
  "pointer_text_presence", // (v1.5) pointer hover / dwell on a paragraph, or any pointer event on the composer (reading proxies)
  "pointer_invalid", // (v1.5) a pointer event of the wrong shape (kind, p<k> id, dwell_ms only on dwell) or a dwell under pointer_config.dwell_ms
] as const;
export type BlindedGuardCode = (typeof BLINDED_GUARD_CODES)[number];
export type GuardResult = { ok: true } | { ok: false; code: BlindedGuardCode; line: number };

const TAB_ONLY: Record<string, readonly string[]> = BLINDING.tabOnlyFields;
const SEALED_TYPES = new Set<string>(BLINDING.sealedOnlyTypes as BhAdEventType[]);
export const SEALED_SESSION_SUFFIX_SHARED: string = BLINDING.sealedSessionSuffix;
/** v1.5: the contract version the allowlist belongs to (equals CONTRACT_VERSION; a test keeps them equal) */
export const BLINDING_CONTRACT: string = BLINDING.contract;
/** v1.5: every bh-ad/1 v1.x event type; an upload line of any other type is rejected unknown_event_type */
export const EVENT_TYPES: readonly string[] = BLINDING.eventTypes;
export const UPLOAD_FORBIDDEN_TYPES: readonly string[] = BLINDING.uploadForbiddenTypes;
export const SIM_MARKER_RE = new RegExp(BLINDING.simMarkerPattern);
export const MAX_BASE_SESSION_ID_LENGTH: number = BLINDING.maxBaseSessionIdLength;
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
/** v1.5: rules for ONE line of ANY upload (main, blinded or sealed); null = clean */
export function uploadLineViolation(e: Line, raw: string): BlindedGuardCode | null {
  const type = String(e.type);
  if (UPLOAD_FORBIDDEN_TYPES.includes(type)) return "gaze_raw_forbidden";
  if (!EVENT_TYPE_SET.has(type)) return "unknown_event_type";
  if (SIM_MARKER_RE.test(raw)) return "sim_marker";
  return null;
}

type Line = Record<string, unknown>;
const isObj = (v: unknown): v is Line => !!v && typeof v === "object" && !Array.isArray(v);
const rawLines = (jsonl: string): string[] => jsonl.split("\n").filter((l) => l.trim());
const parse = (jsonl: string): Array<Line | null> =>
  rawLines(jsonl).map((l) => { try { const v = JSON.parse(l); return isObj(v) ? v : null; } catch { return null; } });

/** the first arm key found at any depth (path), or null */
export function findArmKey(v: unknown, re = armKeyRegExp(), path = ""): string | null {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const p = findArmKey(v[i], re, `${path}[${i}]`); if (p) return p; } return null; }
  if (!isObj(v)) return null;
  for (const [k, x] of Object.entries(v)) {
    if (re.test(k)) return `${path}.${k}`;
    const p = findArmKey(x, re, `${path}.${k}`);
    if (p) return p;
  }
  return null;
}

/** v1.3: a line that must never be in a non-sealed log (visible or blinded main) in any session type */
export function sealedEverywhereViolation(e: Line): boolean {
  const type = String(e.type);
  if (SEALED_EVERYWHERE_TYPES.includes(type)) return true;
  const m = SEALED_EVERYWHERE_REASONS[type];
  return !!m && typeof e.reason === "string" && e.reason in m;
}

/** rules for ONE line of a blinded main log; null = clean */
export function blindedMainLineViolation(e: Line, re = armKeyRegExp()): BlindedGuardCode | null {
  const type = String(e.type);
  if (SEALED_TYPES.has(type)) return "sealed_type";
  if (type === "session_start" && ("arm" in e || "p_inject" in e)) return "arm_field";
  for (const f of TAB_ONLY[type] ?? []) if (f in e) return type === "session_start" ? "arm_field" : "tab_only_field";
  if (type === "actor_turn") {
    const u = e.usage;
    if (!isObj(u) || u.prompt_tokens !== null) return "prompt_tokens";
  }
  if (type === "health" && SEALED_ONLY_HEALTH_CODES.includes(String(e.code))) return "sealed_health";
  if (findArmKey(e, re)) return "arm_key";
  return null;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/**
 * v1.5: the input-mode fence over one log (main or sealed; lines[0] is session_start). Mode = session_start.input_mode
 * (absent = "gaze", contract-v1 .. v1.4). Pointer events must target an AOI marked interactive in the latest aoi_layout of
 * their message logged before them. Returns the first violation, or null.
 */
export function inputModeViolation(lines: readonly Line[]): { code: BlindedGuardCode; line: number } | null {
  const start = lines[0];
  if (!start) return null;
  const mode = (start.input_mode ?? LEGACY_INPUT_MODE) as InputMode;
  if (!(INPUT_MODES as readonly string[]).includes(mode)) return { code: "input_mode_mismatch", line: 1 };
  const pc = isObj(start.pointer_config) && typeof start.pointer_config.dwell_ms === "number" ? { dwell_ms: start.pointer_config.dwell_ms } : DEFAULT_POINTER_CONFIG;
  const forbidden = MODE_FORBIDDEN_TYPES[mode];
  const interactive = new Map<string, Set<string>>();
  for (let i = 1; i < lines.length; i++) {
    const e = lines[i]!, type = String(e.type), line = i + 1;
    if (type === "session_start") return { code: "input_mode_mismatch", line }; // one session, one mode
    if (forbidden.includes(type)) return { code: "input_mode_mismatch", line };
    if (type === "aoi_layout" && typeof e.msg === "string") {
      interactive.set(e.msg, new Set(arr(e.boxes).filter((b): b is Line => isObj(b) && b.interactive === true).map((b) => String(b.aoi))));
    }
    if (type === "attention_digest" && isObj(e.digest)) {
      const g = e.digest;
      if (g.input_mode !== undefined && g.input_mode !== mode) return { code: "input_mode_mismatch", line };
      const gazeish = arr(g.paras).length > 0 || arr(g.lookBacks).length > 0 || Number(g.offscreenMs ?? 0) > 0 || Number(g.composerPauses ?? 0) > 0 || arr(g.events).length > 0 || arr(e.events).length > 0;
      if (mode !== "gaze" && gazeish) return { code: "input_mode_mismatch", line };
      if (mode !== "pointer" && arr(g.pointer).length > 0) return { code: "input_mode_mismatch", line };
    }
    if (type === "pointer_l1") {
      for (const p of arr(e.events)) {
        if (!isObj(p)) return { code: "pointer_invalid", line };
        const v = pointerEventViolation(p as unknown as PointerEvent, interactive.get(String(p.msg)) ?? new Set(), pc);
        if (v === "pointer_shape" || v === "pointer_dwell_short") return { code: "pointer_invalid", line };
        if (v) return { code: v, line };
      }
    }
  }
  return null;
}

/**
 * The blinded guard over one upload (envelope.sessionId + jsonl). For a ".sealed" upload pass the base session's
 * main log (or null when unknown: rejected, fail closed). tab_visible main uploads pass (they carry arm openly).
 */
export function blindedGuard(sessionId: string, jsonl: string, baseMainJsonl?: string | null): GuardResult {
  const lines = parse(jsonl);
  const sealed = sessionId.endsWith(SEALED_SESSION_SUFFIX_SHARED);
  const base = sealed ? sessionId.slice(0, -SEALED_SESSION_SUFFIX_SHARED.length) : sessionId;
  if (base.length > MAX_BASE_SESSION_ID_LENGTH) return { ok: false, code: "session_id_too_long", line: 1 };
  const raws = rawLines(jsonl);
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    if (!e || e.schema !== "bh-ad/1") return { ok: false, code: "not_bh_ad", line: i + 1 };
    if (e.sessionId !== base) return { ok: false, code: "session_id_mismatch", line: i + 1 };
    const v = uploadLineViolation(e, raws[i]!);
    if (v) return { ok: false, code: v, line: i + 1 };
  }
  const start = lines[0];
  if (!start || start.type !== "session_start") return { ok: false, code: "no_session_start", line: 1 };
  const mv = inputModeViolation(lines as Line[]);
  if (mv) return { ok: false, ...mv };
  if (sealed) {
    // v1.3: a tab_visible session has a sealed companion too (leak_judge is sealed-only everywhere); the base must match
    if (start.session_type !== "blinded" && start.session_type !== "tab_visible") return { ok: false, code: "sealed_base_not_blinded", line: 1 };
    const b = baseMainJsonl ? parse(baseMainJsonl)[0] : null;
    if (!b || b.type !== "session_start" || b.session_type !== start.session_type || b.sessionId !== base) return { ok: false, code: "sealed_base_not_blinded", line: 1 };
    return { ok: true };
  }
  if (start.session_type === "tab_visible") {
    // v1.3: the visible log carries arm openly but never a leak_judge verdict (a blinded main log fails sealed_type first)
    for (let i = 0; i < lines.length; i++) if (sealedEverywhereViolation(lines[i]!)) return { ok: false, code: "sealed_everywhere", line: i + 1 };
    return { ok: true };
  }
  if (start.session_type !== "blinded") return { ok: false, code: "no_session_start", line: 1 };
  const re = armKeyRegExp();
  for (let i = 0; i < lines.length; i++) {
    const code = blindedMainLineViolation(lines[i]!, re);
    if (code) return { ok: false, code, line: i + 1 };
  }
  return { ok: true };
}
