/**
 * The Director policy. Like Left 4 Dead's AI Director it reads the player's state
 * every "frame" (turn) and decides pacing, but here the dial is curiosity, not zombies:
 *   EXPLORE  (build-up)  scout topics the map knows little about (UCB bandit)
 *   EXPLOIT  (peak)      lean into the current hypothesis
 *   RELAX    (cool-down) after a long exploit streak with falling engagement, change scenery
 * The policy is pure and deterministic given (map, frame, history, rng). The language
 * model never decides strategy; it only voices the plan. "Director decides, model speaks."
 */
import type { DirectorPlan, FrameState, QuestionStyle } from "./types.js";
import type { InterestMap } from "./interest-map.js";
import type { Rng } from "./rng.js";

/** Pseudo-topic for broad "what are you into?" questions that let the user steer. */
export const OPEN_TOPIC = "_open";

export interface DirectorPolicyOptions {
  exploreC?: number;
  maxExploitStreak?: number;
  /** ask a broad open question every N explore turns */
  openEvery?: number;
}

function exploitStreak(history: DirectorPlan[], topic: string): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i]!;
    if (p.mode === "exploit" && p.topic === topic) n++;
    else break;
  }
  return n;
}

function bestStyle(map: InterestMap, exclude: QuestionStyle[], c: number): QuestionStyle {
  const styles = map.allStyles().filter((s) => !exclude.includes(s));
  return styles.sort((a, b) => map.ucb("style", b, c) - map.ucb("style", a, c))[0]!;
}

export function planTurn(
  turn: number,
  map: InterestMap,
  frame: FrameState | null,
  history: DirectorPlan[],
  rng: Rng,
  opts: DirectorPolicyOptions = {},
): DirectorPlan {
  const { exploreC = 0.35, maxExploitStreak = 4, openEvery = 4 } = opts;
  if (turn === 0 || !frame) {
    return { turn, mode: "explore", topic: OPEN_TOPIC, style: "open", reason: "opener: let them pick the direction" };
  }
  const recent = history.slice(-2).map((p) => p.topic);
  const hyp = map.hypothesis();

  if (hyp) {
    const streak = exploitStreak(history, hyp);
    if (streak >= maxExploitStreak && frame.lift < -0.05) {
      const topic = map
        .allTopics()
        .filter((t) => t !== hyp)
        .sort((a, b) => map.ucb("topic", b, exploreC) - map.ucb("topic", a, exploreC))[0]!;
      return { turn, mode: "relax", topic, style: rng() < 0.5 ? "hypothetical" : "personal-story", reason: `${streak} turns on ${hyp} and engagement dipping: change scenery` };
    }
    const cell = map.topic(hyp);
    const style: QuestionStyle = cell.n >= 3 && rng() < 0.5 ? "deep-dive" : bestStyle(map, ["open", "either-or"], 0.1);
    return { turn, mode: "exploit", topic: hyp, style, reason: `hypothesis ${hyp} at ${cell.mean.toFixed(2)}` };
  }

  // Follow the user's lead: a spontaneously mentioned, little-probed topic is the best scout target.
  const lead = frame.mentionedTopics.find((t) => map.topic(t).n < 2.5 && !recent.includes(t));
  if (lead) {
    return { turn, mode: "explore", topic: lead, style: bestStyle(map, ["open", "either-or", "deep-dive"], exploreC), reason: "user brought it up" };
  }

  const exploreTurns = history.filter((p) => p.mode === "explore").length;
  if (exploreTurns > 0 && exploreTurns % openEvery === 0 && history[history.length - 1]?.style !== "open") {
    return { turn, mode: "explore", topic: OPEN_TOPIC, style: "open", reason: "periodic open question so the user can steer" };
  }

  const ranked = map
    .allTopics()
    .filter((t) => !recent.includes(t))
    .map((t) => [t, map.ucb("topic", t, exploreC) + rng() * 0.02] as const)
    .sort((a, b) => b[1] - a[1]);
  const topic = ranked[0]![0];
  const style = bestStyle(map, ["open", "deep-dive"], exploreC);
  const plan: DirectorPlan = { turn, mode: "explore", topic, style, reason: "scouting the least-known promising topic" };
  if (style === "either-or") plan.altTopic = ranked[1]?.[0];
  return plan;
}
