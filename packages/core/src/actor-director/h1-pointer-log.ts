/**
 * Step 3 Mac Pointer pilot: H1-style local session JSONL helpers.
 *
 * Gaze H1 writes a one-shot JSON report (fps/cpu/camera). Pointer mode has no camera/fps; instead we mirror the
 * AD main session log (ad/visible|blinded/<id>) to a dogfood file under the Mac shell's userData:
 *   ~/Library/Application Support/BrianHarness-Director/h1-pointer/<sessionId>.jsonl
 *
 * Line 0 is a preamble (schema bh-h1-pointer-session/1). Remaining lines are bh-ad/1 main-log events as written by
 * AdSessionLog (session_start with input_mode + models, pointer_l1, attention_digest, model_change, health, …).
 */
import type { BhAdEvent } from "../ad-contracts/index.js";

export const H1_POINTER_SESSION_SCHEMA = "bh-h1-pointer-session/1" as const;
/** relative path under the Director Mac userData (shell joins this) */
export const H1_POINTER_JSONL_DIR = "h1-pointer" as const;

export interface H1PointerPreamble {
  schema: typeof H1_POINTER_SESSION_SCHEMA;
  sessionId: string;
  input_mode: "pointer" | "gaze" | "none";
  /** fps N/A in pointer mode (gaze H1 only) */
  fps: null;
  /** camera N/A in pointer mode */
  camera: "n/a";
  actor_model?: string;
  director_model?: string;
  t: string;
  note: string;
}

export function h1PointerJsonlRelPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "session";
  return `${H1_POINTER_JSONL_DIR}/${safe}.jsonl`;
}

export function h1PointerPreamble(o: {
  sessionId: string;
  input_mode: "pointer" | "gaze" | "none";
  actor_model?: string;
  director_model?: string;
  t?: string;
}): H1PointerPreamble {
  return {
    schema: H1_POINTER_SESSION_SCHEMA,
    sessionId: o.sessionId,
    input_mode: o.input_mode,
    fps: null,
    camera: "n/a",
    ...(o.actor_model ? { actor_model: o.actor_model } : {}),
    ...(o.director_model ? { director_model: o.director_model } : {}),
    t: o.t ?? new Date().toISOString(),
    note: "Pointer pilot local JSONL: fps/camera N/A; body lines are bh-ad/1 main-log events",
  };
}

/** event types a pointer dogfood pass should be able to find after chip interaction + a turn */
export const POINTER_H1_BODY_TYPES = [
  "session_start", "aoi_layout", "pointer_l1", "attention_digest", "model_change", "health",
  "actor_turn", "user_turn", "director_call", "rail_check", "injection", "note_dropped", "session_end",
] as const;

export interface ParsedPointerH1Jsonl {
  preamble: H1PointerPreamble;
  events: BhAdEvent[];
  rawLines: string[];
}

export function parsePointerH1Jsonl(text: string): ParsedPointerH1Jsonl {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!rawLines.length) throw new Error("empty H1 pointer JSONL");
  const preamble = JSON.parse(rawLines[0]!) as H1PointerPreamble;
  if (preamble.schema !== H1_POINTER_SESSION_SCHEMA) throw new Error(`bad schema ${String(preamble.schema)}`);
  if (!preamble.sessionId) throw new Error("preamble missing sessionId");
  if (preamble.input_mode !== "pointer" && preamble.input_mode !== "gaze" && preamble.input_mode !== "none") {
    throw new Error(`bad input_mode ${String(preamble.input_mode)}`);
  }
  if (preamble.fps !== null) throw new Error("pointer H1 preamble fps must be null");
  if (preamble.camera !== "n/a") throw new Error("pointer H1 preamble camera must be n/a");
  const events = rawLines.slice(1).map((l, i) => {
    try { return JSON.parse(l) as BhAdEvent; }
    catch (e) { throw new Error(`line ${i + 2}: ${String((e as Error).message ?? e)}`); }
  });
  return { preamble, events, rawLines };
}

/** required fields after a Pointer dogfood chip pass (session_start + at least one pointer_l1 or digest with pointer) */
export function assertPointerH1SessionFields(parsed: ParsedPointerH1Jsonl): string[] {
  const miss: string[] = [];
  if (parsed.preamble.input_mode !== "pointer") miss.push("preamble.input_mode=pointer");
  const start = parsed.events.find((e) => e.type === "session_start") as Extract<BhAdEvent, { type: "session_start" }> | undefined;
  if (!start) miss.push("session_start");
  else {
    if (start.input_mode !== "pointer") miss.push("session_start.input_mode");
    if (!start.actor_model && !start.models?.actor) miss.push("session_start.actor_model");
    if (!start.director_model && !start.models?.director) miss.push("session_start.director_model");
    if (!start.pointer_config) miss.push("session_start.pointer_config");
  }
  const hasPointer =
    parsed.events.some((e) => e.type === "pointer_l1" && Array.isArray(e.events) && e.events.length > 0) ||
    parsed.events.some((e) => e.type === "attention_digest" && Array.isArray(e.digest.pointer) && (e.digest.pointer?.length ?? 0) > 0);
  if (!hasPointer) miss.push("pointer_l1|attention_digest.pointer");
  return miss;
}
