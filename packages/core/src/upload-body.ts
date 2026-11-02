/**
 * POST /v1/sessions request bodies (Worker docs/SESSIONS_API.md, allowlist as of Worker f71cc53). The Worker
 * rejects unknown fields with 400, so these builders emit exactly the allowed keys. `jsonl` is the session file
 * content unchanged (byte-identical to the BHExport / Files copy). Browser-safe.
 */
export interface UploadMeta { appVersion: string; platform: string; build?: string | number | null }
export interface SessionUploadBody {
  kind: "session"; sessionId: string; studyIndex?: number; scheduleHash?: string;
  appVersion: string; platform: string; build?: string | number; jsonl: string;
}
export interface StudyStartUploadBody {
  kind: "study_start"; id: string; scheduleHash: string; nSessions: number;
  appVersion: string; build: string | number | null; platform: string; createdAt: string;
}
export const SESSION_UPLOAD_KEYS = ["kind", "sessionId", "studyIndex", "scheduleHash", "appVersion", "platform", "build", "jsonl"] as const;
export const STUDY_START_UPLOAD_KEYS = ["kind", "id", "scheduleHash", "nSessions", "appVersion", "build", "platform", "createdAt"] as const;

/** body for one session file: sessionId / studyIndex / scheduleHash are read from its session_start line */
export function sessionUploadBody(jsonl: string, meta: UploadMeta): SessionUploadBody {
  const first = jsonl.slice(0, jsonl.indexOf("\n") < 0 ? undefined : jsonl.indexOf("\n"));
  let start: { type?: string; sessionId?: string; study?: { index?: number; scheduleHash?: string } } = {};
  try { start = JSON.parse(first); } catch { /* checked below */ }
  if (start.type !== "session_start" || typeof start.sessionId !== "string") throw new Error("session file does not start with session_start");
  const st = start.study;
  return {
    kind: "session", sessionId: start.sessionId,
    ...(typeof st?.index === "number" ? { studyIndex: st.index } : {}),
    ...(typeof st?.scheduleHash === "string" ? { scheduleHash: st.scheduleHash } : {}),
    appVersion: meta.appVersion, platform: meta.platform,
    ...(meta.build !== undefined && meta.build !== null ? { build: meta.build } : {}),
    jsonl,
  };
}

/** study_start: id = "phaseD-" + first 16 hex of the schedule hash (stable per sealed schedule -> idempotent 409 on retry) */
export function studyStartUploadBody(s: { scheduleHash: string; nSessions: number; createdAt: string }, meta: UploadMeta): StudyStartUploadBody {
  return { kind: "study_start", id: `phaseD-${s.scheduleHash.slice(0, 16)}`, scheduleHash: s.scheduleHash, nSessions: s.nSessions, appVersion: meta.appVersion, build: meta.build ?? null, platform: meta.platform, createdAt: s.createdAt };
}

/** secret patterns that must never be in an upload (mirrors the Worker's guard; used by tests and as a client pre-check) */
export const UPLOAD_SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/, /\bbhd_[A-Za-z0-9_-]{20,}/, /\bbhr_[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, /"(?:api[_-]?key|apikey|secret|password|authorization|access[_-]?token|auth[_-]?token)"\s*:\s*"[^"]{8,}"/i,
  /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16,}/, // Ollama-style key
];
export function findUploadSecret(body: string): string | null {
  for (const re of UPLOAD_SECRET_PATTERNS) { const m = re.exec(body); if (m) return re.source.slice(0, 24); }
  return null;
}
