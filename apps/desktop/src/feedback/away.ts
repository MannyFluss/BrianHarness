// Away-time accounting vs the Report sheet. The only away rule in the app is App.tsx's "hidden for >= AWAY_MS ->
// session rating card / new session". Time the page spends hidden while the Report sheet is open (between
// feedback_open and feedback_closed: e.g. the iOS share sheet of the export fallback, or "Save to Files") is not
// time away, so it is subtracted (at most FEEDBACK_AWAY_CREDIT_MAX_MS per hidden span). UI only: features, timing, ratings and the schedule are untouched.
/**
 * The most a single hidden span can be credited for the Report sheet being open (Researcher, Nov 3 2026): a sheet left
 * open while the app sits in the background must not keep the session alive forever. Fixed, below AWAY_MS (20 min),
 * so e.g. 3 h hidden with the sheet open still counts as 2 h 50 min away. The sheet itself stays open.
 */
export const FEEDBACK_AWAY_CREDIT_MAX_MS = 10 * 60_000;
export class FeedbackBracket {
  private spans: Array<[number, number | null]> = [];
  open(t: number) { if (this.isOpen()) return; this.spans.push([t, null]); if (this.spans.length > 32) this.spans.splice(0, this.spans.length - 32); }
  close(t: number) { const s = this.spans.at(-1); if (s && s[1] === null) s[1] = Math.max(s[0], t); }
  isOpen() { const s = this.spans.at(-1); return !!s && s[1] === null; }
  /** ms of [from, to] spent with the Report sheet open */
  overlap(from: number, to: number): number {
    let ms = 0;
    for (const [a, b] of this.spans) { const lo = Math.max(a, from), hi = Math.min(b ?? to, to); if (hi > lo) ms += hi - lo; }
    return ms;
  }
  /** hidden time that counts as away: the hidden span minus the part inside a feedback bracket, that credit capped at
   *  FEEDBACK_AWAY_CREDIT_MAX_MS per hidden span */
  awayMs(hiddenAt: number, now: number): number {
    return Math.max(0, now - hiddenAt - Math.min(FEEDBACK_AWAY_CREDIT_MAX_MS, this.overlap(hiddenAt, now)));
  }
}
export const feedbackBracket = new FeedbackBracket();
