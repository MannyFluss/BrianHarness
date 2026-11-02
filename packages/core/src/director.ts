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
  /**
   * Anti-lock-in: after this many consecutive exploit turns on a hypothesis that is only
   * mildly liked (mean < strongMean), force one scouting turn elsewhere, whatever the lift.
   */
  scoutAfter?: number;
  /** strong hypotheses still get a scouting checkpoint, just less often */
  scoutAfterStrong?: number;
  strongMean?: number;
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
  const { exploreC = 0.35, maxExploitStreak = 4, openEvery = 4, scoutAfter = 2, scoutAfterStrong = 5, strongMean = 0.72 } = opts;
  if (turn === 0 || !frame) {
    return { turn, mode: "explore", topic: OPEN_TOPIC, style: "open", reason: "opener: let them pick the direction" };
  }
  const recent = history.slice(-2).map((p) => p.topic);
  const hyp = map.hypothesis();

  // A scouting checkpoint just found something hotter than the hypothesis: confirm it next turn
  // (one lucky reply has n=1 and can't beat the hypothesis on its own, so without this the
  // Director would scout, see the spike, and walk straight back into the trap).
  const last = history[history.length - 1];
  if (hyp && last?.scout) {
    const hypMean = map.topic(hyp).mean;
    // which scouted topic did they take? (either-or: the one they mentioned)
    const probed = [last.topic, last.altTopic].filter((t): t is string => !!t && t !== hyp && t !== OPEN_TOPIC);
    const taken = probed.find((t) => frame.mentionedTopics.includes(t)) ?? (probed.length === 1 ? probed[0] : undefined);
    if (taken && frame.engagement > hypMean + 0.03) {
      return { turn, mode: "explore", topic: taken, style: bestStyle(map, ["open", "either-or"], 0.1), reason: `scout on ${taken} beat ${hyp} (${frame.engagement.toFixed(2)} vs ${hypMean.toFixed(2)}): confirm it` };
    }
  }

  if (hyp) {
    // The user volunteered a different, barely-probed topic: that is the strongest
    // "look over here" signal there is, so follow it once even mid-exploit.
    const planned = [last?.topic, last?.altTopic];
    const volunteered = frame.mentionedTopics.find((t) => t !== hyp && !planned.includes(t) && map.topic(t).n < 1.5);
    if (volunteered) {
      return { turn, mode: "explore", topic: volunteered, style: bestStyle(map, ["open", "either-or"], 0.1), reason: `user brought up ${volunteered} unprompted while we were on ${last?.topic ?? hyp}: follow the lead` };
    }
    const streak = exploitStreak(history, hyp);
    const hypCell = map.topic(hyp);
    const checkpoint = hypCell.mean < strongMean ? scoutAfter : scoutAfterStrong;
    if (streak >= checkpoint) {
      // Lock-in trap: a long run on a topic says nothing about the topics we never tried.
      // Scout with an either-or over the two most promising untried topics: one turn, two probes.
      const ranked = map
        .allTopics()
        .filter((t) => t !== hyp && !recent.includes(t))
        .map((t) => [t, map.ucb("topic", t, exploreC * 1.5) + rng() * 0.02] as const)
        .sort((a, b) => b[1] - a[1]);
      const topic = ranked[0]![0];
      const altTopic = ranked[1]?.[0];
      return { turn, mode: "explore", topic, ...(altTopic ? { altTopic } : {}), style: altTopic ? "either-or" : "hypothetical", scout: true, reason: `scouting checkpoint: ${streak} turns on ${hyp} (mean ${hypCell.mean.toFixed(2)}), check ${topic}${altTopic ? ` / ${altTopic}` : ""} before committing` };
    }
    const cell = map.topic(hyp);
    const style: QuestionStyle = cell.n >= 3 && rng() < 0.5 ? "deep-dive" : bestStyle(map, ["open", "either-or"], 0.1);
    return { turn, mode: "exploit", topic: hyp, style, reason: `hypothesis ${hyp} at ${cell.mean.toFixed(2)}` };
  }

  // A contender leads the map but isn't confirmed yet (thin evidence or thin margin): probe it again
  // instead of wandering off. Capped at two confirms in a row so a flat user can't trap us here.
  const [leader] = map.topTopics(1);
  const base = map.userBaseline() ?? 0.45;
  if (leader && leader[1] >= base + 0.08 && leader[2] < 2.5) {
    const confirms = history.slice(-2).filter((p) => p.topic === leader[0]).length;
    if (confirms < 2) {
      return { turn, mode: "explore", topic: leader[0], style: bestStyle(map, ["open", "either-or"], 0.1), reason: `${leader[0]} leads (${leader[1].toFixed(2)} vs this user's ${base.toFixed(2)}) but isn't confirmed: probe again` };
    }
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
  const untried = map.allTopics().filter((t) => map.topic(t).n === 0).length;
  // early on, with most of the map dark, two-for-one either-or probes cover ground faster
  const style: QuestionStyle = untried >= 99 && rng() < 0.5 ? "either-or" : bestStyle(map, ["open", "deep-dive"], exploreC);
  const plan: DirectorPlan = { turn, mode: "explore", topic, style, reason: "scouting the least-known promising topic" };
  if (style === "either-or") plan.altTopic = ranked[1]?.[0];
  return plan;
}
