/**
 * E1: build the POST /v1/ad-sessions envelope for one stored log, behind the client-side blinded guard.
 * Fail closed: when the guard refuses, nothing is built and an upload.blinded_guard health line (detail = the guard
 * code only, never an event type or arm) is appended to the main log the user sees.
 * A session uploads twice: its main log as <id> and its sealed log as <id>.sealed (v1.3: blinded, or tab_visible with a
 * tab_visible base; leak_judge verdicts live only in the sealed log in every session type).
 */
import { AD_UPLOAD_MAX_BYTES, BH_AD_SCHEMA, blindedGuard, SEALED_SESSION_SUFFIX } from "../ad-contracts/index.js";
import type { AdUploadEnvelope, BlindedGuardCode } from "../ad-contracts/index.js";
import type { AdClock } from "./log.js";
import type { AdNamespace, AdStorage } from "./storage.js";

export type AdUploadBuild =
  | { ok: true; envelope: AdUploadEnvelope; bytes: number }
  | { ok: false; code: BlindedGuardCode | "not_found" | "raw_gaze_local_only" | "too_large"; line?: number };

function appendHealth(storage: AdStorage, ns: AdNamespace, id: string, clock: AdClock, body: Record<string, unknown>) {
  const prev = storage.read(ns, id) ?? "";
  const seq = prev.split("\n").filter((l) => l.trim()).length;
  storage.appendLine(ns, id, JSON.stringify({ schema: BH_AD_SCHEMA, t: new Date(clock.now()).toISOString(), mono: clock.mono(), sessionId: id, seq, type: "health", ...body }));
}

export function buildAdUpload(
  storage: AdStorage, ns: AdNamespace, sessionId: string, meta: { appVersion: string; platform: string; build?: string | number | null }, clock: AdClock,
): AdUploadBuild {
  const jsonl = storage.read(ns, sessionId);
  if (jsonl === null) return { ok: false, code: "not_found" };
  const uploadId = ns === "sealed" ? sessionId + SEALED_SESSION_SUFFIX : sessionId;
  // v1.3: a tab_visible session has a sealed companion too; its base is the visible log
  const mainNs: AdNamespace = ns === "sealed" ? (storage.read("blinded", sessionId) !== null ? "blinded" : "visible") : ns;
  if (/"type":"gaze_raw"/.test(jsonl)) return { ok: false, code: "raw_gaze_local_only" };
  const g = blindedGuard(uploadId, jsonl, ns === "sealed" ? storage.read(mainNs, sessionId) : undefined);
  if (!g.ok) {
    appendHealth(storage, mainNs, sessionId, clock, { check: "upload", ok: false, code: "upload.blinded_guard", detail: g.code });
    return { ok: false, code: g.code, line: g.line };
  }
  const envelope: AdUploadEnvelope = { schema: BH_AD_SCHEMA, sessionId: uploadId, appVersion: meta.appVersion, platform: meta.platform, build: meta.build ?? null, jsonl };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  if (bytes > AD_UPLOAD_MAX_BYTES) {
    appendHealth(storage, mainNs, sessionId, clock, { check: "upload", ok: false, code: "upload.too_large", detail: `${bytes} bytes > ${AD_UPLOAD_MAX_BYTES}` });
    return { ok: false, code: "too_large" };
  }
  return { ok: true, envelope, bytes };
}
