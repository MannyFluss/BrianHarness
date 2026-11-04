/**
 * Worker contract (from InfrastructureBot's Worker branch actor-director @ 9bc90f1, not deployed). Adopted as-is;
 * any change goes to InfrastructureBot as a request, not a divergence.
 */

/** every /v1/chat/completions request from the Actor/Director mode sends this header */
export const ROLE_HEADER = "X-BH-Role" as const;
/** missing/empty header = "actor" (old clients); anything else -> 400 invalid_role */
export const ROLES = ["actor", "director", "judge"] as const;
export type Role = (typeof ROLES)[number];
/** per-device per-UTC-day caps (ROLE_CAP_*), counted inside DEVICE_DAILY_CAP (200), not on top of it */
export const ROLE_CAPS = { actor: 200, director: 100, judge: 100 } as const satisfies Record<Role, number>;

/** POST /v1/ad-sessions body. The server checks only this envelope, that each jsonl line is a JSON object, and its secret scan. */
export interface AdUploadEnvelope {
  schema: "bh-ad/1";
  /** 1-128 chars [A-Za-z0-9._:-], starting with a letter or digit; 409 session_exists on a repeat */
  sessionId: string;
  /** 1-64 chars */
  appVersion: string;
  /** 1-32 chars: "ios" | "mac" | "web" */
  platform: string;
  /** optional, e.g. "20261104.1335"; string (1-64) or number */
  build?: string | number | null;
  /** the bh-ad/1 log: one JSON object per line ("\n"-separated) */
  jsonl: string;
}
/** the whole request body (envelope + jsonl) must be <= this, else 413 ad_log_too_large */
export const AD_UPLOAD_MAX_BYTES = 1048576;
export const AD_SESSION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
/** sealed companion log of a blinded session: uploaded as its own envelope with this sessionId suffix */
export const SEALED_SESSION_SUFFIX = ".sealed" as const;

export interface AdUploadOk { id: string; kind: "ad_session"; schema: "bh-ad/1"; received_at: string; bytes: number; lines: number; sha256: string }

export const WORKER_ERROR_CODES = [
  "invalid_role", // 400 bad X-BH-Role
  "role_cap_actor", "role_cap_director", "role_cap_judge", // 429 (scope "role")
  "daily_cap_device", "daily_cap_global", // 429
  "ad_log_too_large", // 413
  "invalid_json", "invalid_ad_upload", "invalid_jsonl", // 400
  "upload_rejected", // 422 secret scan
  "session_exists", // 409
  "upload_cap_device", "upload_cap_global", // 429
] as const;
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];
/** error body: { error: { message, type, code, ...extra } }; 429s also send a retry-after header (seconds) */
export interface WorkerErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "rate_limit_error" | "server_error" | string;
    code: WorkerErrorCode | string;
    limit?: number; used?: number; reset_at?: string;
    /** role caps and chat caps */
    role?: Role; scope?: "role" | "device" | "global";
    field?: string; line?: number; reason?: string; permanent?: boolean;
  };
}
