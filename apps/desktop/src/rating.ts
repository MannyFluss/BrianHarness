// Absorption ratings (Phase D ground truth; PREREG_dogfood.md). Evaluation only: ratings are logged
// as {type:"rating"} records and never reach engagement, the Director or the interest map.
//
// Per-turn probe "How absorbed are you right now?": ~1 in 5 turns, never on turn 1, randomized
// with a seeded RNG per session and a minimum gap. Shown-but-skipped probes are logged too
// (dismissed: true, value: null), so the response rate itself is analyzable.

/** P(probe | eligible turn). With MIN_GAP=3 the long-run rate is p/(1+p*(MIN_GAP-1)) = 1/5. */
export const PROBE_P = 1 / 3;
export const PROBE_MIN_GAP = 3;
/** first turn a probe may follow (turn 1 is never probed) */
export const PROBE_FIRST_TURN = 2;
/** coming back after this long hidden counts as leaving the session -> session rating card */
export const AWAY_MS = 20 * 60_000;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded probe schedule for one session: call shouldProbe(turn) once per completed user turn
 * (turn = 1-based user-turn number). Deterministic for a given seed, so a session's probe turns
 * are reproducible from its id.
 */
export function probeScheduler(seed: string, opts: { p?: number; minGap?: number; firstTurn?: number } = {}) {
  const p = opts.p ?? PROBE_P;
  const minGap = opts.minGap ?? PROBE_MIN_GAP;
  const first = opts.firstTurn ?? PROBE_FIRST_TURN;
  const rng = mulberry32(hash32(seed));
  let last = -Infinity;
  const decided = new Map<number, boolean>();
  return {
    shouldProbe(turn: number): boolean {
      const prior = decided.get(turn);
      if (prior !== undefined) return prior;
      const draw = rng(); // one draw per turn keeps the sequence independent of eligibility
      const yes = turn >= first && turn - last >= minGap && draw < p;
      if (yes) last = turn;
      decided.set(turn, yes);
      return yes;
    },
  };
}

export const RATING_LABELS = ["Not at all", "", "", "", "Completely"] as const;
export const BLIND_CHOICES = [
  { id: "adaptive", label: "Adaptive" },
  { id: "baseline", label: "Baseline" },
  { id: "no-idea", label: "No idea" },
] as const;
