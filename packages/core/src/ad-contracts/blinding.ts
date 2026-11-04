/**
 * contract-v1.1: shared blinding rules (data in blinding.json, also read by tools/phaseD/check_blinding.mjs) and the
 * client-side mirror of the blinded guard the Researcher approved (Nov 4 2026). Fail closed: an upload the guard
 * can't prove clean is rejected with a code, and the client writes a health line (upload.blinded_guard).
 */
import BLINDING from "./blinding.json" with { type: "json" };
import type { BhAdEventType } from "./events.js";

/** regex fragments of the arm-key list (protocol 4's ARM_KEYS, verbatim) */
export const ARM_KEY_PATTERNS: readonly string[] = BLINDING.armKeyPatterns;
/** ^(?:adaptation|study[_-]?mode|...)$ with flag i: a key that check_blinding and the guard treat as an arm key */
export const armKeyRegExp = (): RegExp => new RegExp(`^(?:${ARM_KEY_PATTERNS.join("|")})$`, "i");
export const SEALED_ONLY_HEALTH_CODES: readonly string[] = BLINDING.sealedOnlyHealthCodes;

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
  "sealed_base_not_blinded", // a ".sealed" upload whose base session (or its own session_start) is not blinded
] as const;
export type BlindedGuardCode = (typeof BLINDED_GUARD_CODES)[number];
export type GuardResult = { ok: true } | { ok: false; code: BlindedGuardCode; line: number };

const TAB_ONLY: Record<string, readonly string[]> = BLINDING.tabOnlyFields;
const SEALED_TYPES = new Set<string>(BLINDING.sealedOnlyTypes as BhAdEventType[]);
export const SEALED_SESSION_SUFFIX_SHARED: string = BLINDING.sealedSessionSuffix;

type Line = Record<string, unknown>;
const isObj = (v: unknown): v is Line => !!v && typeof v === "object" && !Array.isArray(v);
const parse = (jsonl: string): Array<Line | null> =>
  jsonl.split("\n").filter((l) => l.trim()).map((l) => { try { const v = JSON.parse(l); return isObj(v) ? v : null; } catch { return null; } });

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

/**
 * The blinded guard over one upload (envelope.sessionId + jsonl). For a ".sealed" upload pass the base session's
 * main log (or null when unknown: rejected, fail closed). tab_visible main uploads pass (they carry arm openly).
 */
export function blindedGuard(sessionId: string, jsonl: string, baseMainJsonl?: string | null): GuardResult {
  const lines = parse(jsonl);
  const sealed = sessionId.endsWith(SEALED_SESSION_SUFFIX_SHARED);
  const base = sealed ? sessionId.slice(0, -SEALED_SESSION_SUFFIX_SHARED.length) : sessionId;
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    if (!e || e.schema !== "bh-ad/1") return { ok: false, code: "not_bh_ad", line: i + 1 };
    if (e.sessionId !== base) return { ok: false, code: "session_id_mismatch", line: i + 1 };
  }
  const start = lines[0];
  if (!start || start.type !== "session_start") return { ok: false, code: "no_session_start", line: 1 };
  if (sealed) {
    if (start.session_type !== "blinded") return { ok: false, code: "sealed_base_not_blinded", line: 1 };
    const b = baseMainJsonl ? parse(baseMainJsonl)[0] : null;
    if (!b || b.type !== "session_start" || b.session_type !== "blinded" || b.sessionId !== base) return { ok: false, code: "sealed_base_not_blinded", line: 1 };
    return { ok: true };
  }
  if (start.session_type === "tab_visible") return { ok: true };
  if (start.session_type !== "blinded") return { ok: false, code: "no_session_start", line: 1 };
  const re = armKeyRegExp();
  for (let i = 0; i < lines.length; i++) {
    const code = blindedMainLineViolation(lines[i]!, re);
    if (code) return { ok: false, code, line: i + 1 };
  }
  return { ok: true };
}
