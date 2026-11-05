/**
 * E6 (ruling 3): composer keystroke TIMES for the reading window (first keystroke closes it). Intervals only:
 * the recorder stores performance.now() times of key events, never which key, never text, never the event.
 * Local only: nothing here is logged or uploaded until contract-v2 defines a field for it.
 */
export class KeystrokeTimes {
  private times: number[] = [];
  constructor(private readonly cap = 2000) {}
  /** call from keydown/beforeinput with the event's timeStamp (or performance.now()); the argument is a number only */
  record(t: number): void {
    if (!Number.isFinite(t)) return;
    if (this.times.length && t < this.times[this.times.length - 1]!) return;
    this.times.push(t);
    if (this.times.length > this.cap) this.times.splice(0, this.times.length - this.cap);
  }
  /** key times inside [from, to) (gaze clock), for reading_window */
  between(from: number, to = Infinity): number[] { return this.times.filter((t) => t >= from && t < to); }
  first(after: number): number | null { return this.times.find((t) => t >= after) ?? null; }
  /** inter-key intervals in ms inside the window */
  intervals(from: number, to = Infinity): number[] {
    const ts = this.between(from, to), out: number[] = [];
    for (let i = 1; i < ts.length; i++) out.push(ts[i]! - ts[i - 1]!);
    return out;
  }
  clear(before: number): void { this.times = this.times.filter((t) => t >= before); }
  get size() { return this.times.length; }
  /** for tests: the recorder holds numbers only */
  toJSON(): { n: number } { return { n: this.times.length }; }
}
