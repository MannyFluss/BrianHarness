// Read-only transcript of a past session (Sidebar -> tap a row). Built from the stored session JSONL: only the
// user turns and the Director's visible replies. Never the hidden opener cue (it is never logged), state notes,
// plans, sealed fields, ratings, study index / schedule / arm, telemetry or feedback records.
import type { SessionTranscript, TranscriptTurn } from "./transport/types";

type Ev = { type?: unknown; text?: unknown; t?: unknown; truncated?: unknown };

/** user_turn.text + non-empty director_turn.text, in log order; everything else is dropped */
export function transcriptTurns(events: readonly Ev[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const e of events) {
    if (!e || typeof e.text !== "string") continue;
    if (e.type === "user_turn") out.push({ role: "user", text: e.text });
    else if (e.type === "director_turn" && e.text.trim()) out.push({ role: "assistant", text: e.text, ...(e.truncated === true ? { cutOff: true } : {}) });
  }
  return out;
}

export function sessionTranscriptOf(id: string, title: string, events: readonly Ev[]): SessionTranscript {
  const start = events.find((e) => e?.type === "session_start");
  return { id, title, startedAt: typeof start?.t === "string" ? start.t : null, turns: transcriptTurns(events) };
}

/**
 * Opening a past session from the sidebar. Blocked (rows disabled) while a STUDY session is in progress, while a
 * reply is on its way, and while a rating step or the Report sheet is showing. Viewing never writes anything.
 */
export function transcriptAllowed(s: { canOpen: boolean; studyActive: boolean; busy: boolean; ratingCardOpen: boolean; turnProbeOpen: boolean; reportOpen: boolean }): boolean {
  return s.canOpen && !s.studyActive && !s.busy && !s.ratingCardOpen && !s.turnProbeOpen && !s.reportOpen;
}
