/**
 * The state note: a short plain-text briefing injected as a system message before
 * every Director turn, like a HUD the model can read. Keep it under ~120 words.
 */
import type { DirectorPlan, FrameState } from "./types.js";
import type { InterestMap } from "./interest-map.js";
import { topicLabel } from "./topics.js";

const f2 = (x: number) => x.toFixed(2);

export function buildStateNote(frame: FrameState | null, map: InterestMap, plan: DirectorPlan): string {
  const lines: string[] = [`[DIRECTOR STATE · turn ${plan.turn}]`];
  if (frame) {
    const f = frame.features;
    const arrow = frame.lift > 0.05 ? "up" : frame.lift < -0.05 ? "down" : "flat";
    lines.push(`Last reply engagement ${f2(frame.engagement)} (${arrow} vs baseline ${f2(frame.baseline)}).`);
    const bits: string[] = [];
    if (f["typing.replyLatencyMs"] !== undefined) bits.push(`started typing after ${(f["typing.replyLatencyMs"] / 1000).toFixed(1)}s`);
    if (f["text.words"] !== undefined) bits.push(`${f["text.words"]} words`);
    if (f["typing.deletions"] !== undefined) bits.push(`${f["typing.deletions"]} deletions`);
    if (f["typing.pauses"] !== undefined) bits.push(`${f["typing.pauses"]} long pauses`);
    if (f["eeg.engagementIndex"] !== undefined) bits.push(`EEG index ${f2(f["eeg.engagementIndex"])}`);
    if (bits.length) lines.push(`Typing: ${bits.join(", ")}.`);
    if (frame.mentionedTopics.length) lines.push(`User brought up: ${frame.mentionedTopics.map(topicLabel).join(", ")}.`);
  } else {
    lines.push("No user reply yet: this is the opener.");
  }
  const top = map.topTopics(3);
  if (top.length) lines.push(`Interest map: ${top.map(([t, m, n]) => `${t} ${f2(m)} (n=${n.toFixed(1)})`).join(", ")}.`);
  const styles = map.topStyles(2);
  if (styles.length) lines.push(`Best question styles: ${styles.map(([s, m]) => `${s} ${f2(m)}`).join(", ")}.`);
  const hyp = map.hypothesis();
  lines.push(`Current hypothesis: ${hyp ? topicLabel(hyp) : "none yet"}.`);
  const target = plan.altTopic ? `${topicLabel(plan.topic)} vs ${topicLabel(plan.altTopic)}` : topicLabel(plan.topic);
  lines.push(`Plan: ${plan.mode.toUpperCase()} ${target}, ask a ${plan.style} question. (${plan.reason})`);
  return lines.join("\n");
}
