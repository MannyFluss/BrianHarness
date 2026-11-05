/**
 * E6: a simulated N-turn actor-director session, end to end, with NO network: mock Actor + mock Director
 * (MockAdBackend), mock leak judge, and gaze from R2 replay files (bh-gaze-replay/1) streamed through ONE
 * GazeSource in 100 ms batches with composer-tap anchors, paragraph AOIs renamed to each Actor message, and
 * observeReading() fed from closeTurn(). Used by the 20-turn test, the screenshot harness and as the demo data the
 * web build shows with ?demo. Browser-safe (no fs): the caller loads the replay files.
 */
import type { BhAdEvent, GazeReplayFile, SessionType, Arm } from "../ad-contracts/index.js";
import { baselineUpdate, type Anchor, type Aoi, type Layout, type RawSample } from "./gaze-ref.js";
import { GazeSource } from "./gaze-stream.js";
import { streamPpd } from "./gaze-replay.js";
import { MockAdBackend, type AdChatBackend, type AdChatRequest } from "./director.js";
import { ActorDirectorSession } from "./session.js";
import { AdSessionLog, ManualClock } from "./log.js";
import { AdStorage } from "./storage.js";
import type { TokenCounter } from "./tokenizer.js";
import type { KeyValueStore } from "../platform/kv.js";

/** one R2 replay: the file plus the turn layout from its sidecar (layout, aois, anchors, timing; labels are never read) */
export interface SimReplay {
  name: string;
  file: Pick<GazeReplayFile, "samples" | "screen"> & { samples: RawSample[] };
  turn: { layout: Layout; aois: Aoi[]; anchors?: Anchor[]; open_t: number; stream_done_t: number; end_t: number; dist_cm?: number | null; msg: string };
}
export interface SimOptions {
  turns?: number;
  sessionType?: SessionType;
  arm?: Arm;
  pInject?: number;
  counter: TokenCounter;
  replays: SimReplay[];
  kv: KeyValueStore;
  sessionId?: string;
  seed?: number;
  /** calibration distance (ruling 3); null = from the samples before each reading window */
  distCm?: number | null;
  /** E7 replay: backends and switches (defaults: simActor / simDirector, Director on, the frozen prompt) */
  actor?: AdChatBackend;
  director?: AdChatBackend;
  judgeBackend?: AdChatBackend;
  directorEnabled?: () => boolean;
  directorPrompt?: { id: string; assemble: (withExamples: boolean) => string };
}
export interface SimChatMessage { id: string; role: "user" | "assistant"; text: string; mono: number }
export interface SimResult {
  sessionId: string; sessionType: SessionType;
  /** FULL lines (tab / sealed); for blinded sessions never hand these to the UI */
  lines: BhAdEvent[];
  chat: SimChatMessage[];
  storage: AdStorage;
  log: AdSessionLog;
  /** per turn: the gaze stream's live() at the reading window's end (for the bottom layer demo) */
  live: Array<ReturnType<GazeSource["live"]> & { turn: number }>;
  layout: Layout;
}

const QUESTIONS = [
  "How often should I feed my starter?", "Why does it smell like nail polish?", "Can I use whole wheat flour?", "What temperature is best?",
  "How do I know it's ready to bake?", "Can I keep it in the fridge?", "What's the float test?", "Why is my loaf so dense?",
  "How long should the bulk ferment be?", "Do I need a Dutch oven?", "What hydration should I start with?", "How do I get a more open crumb?",
  "Is rye better for starters?", "Can I skip a feeding?", "What does autolyse do?", "How do I shape a boule?", "Why does the crust go soft?",
  "How much salt?", "Can I freeze the dough?", "Any tips for my first bake?", "Thanks, one last thing?",
];

/** mock Director: hypotheses that evolve, a note on most turns citing the strongest event, one lint-blocked note, one no-note */
export function simDirector(): MockAdBackend {
  return new MockAdBackend([], (req: AdChatRequest) => {
    const input = req.messages[1]!.content;
    const ev = /\b(e\d+)\b/.exec(input)?.[1];
    const para = /\b(a\d+\.p\d+)\b/.exec(input)?.[1];
    const k = Number(/after a(\d+)/.exec(input)?.[1] ?? "0") + 1;
    const hypotheses = [
      { label: "wants practical steps", conf: Math.min(0.9, 0.45 + k * 0.03), evidence: [para ?? `a${k - 1}`] },
      ...(k > 3 ? [{ label: "worried about failure", conf: k % 3 === 0 ? 0.62 : 0.41, evidence: [ev ?? para ?? `a${k - 1}`] }] : []),
      ...(k > 8 ? [{ label: "ready to bake soon", conf: 0.55, evidence: [`u${k - 1}`] }] : []),
    ];
    const context_update = { summary: `Learning sourdough basics, turn ${k}: feeding, timing and first bake.`, hypotheses, changed: k % 3 === 0 ? ["worried about failure"] : [] };
    const cite = ev ?? para;
    if (!cite || k % 5 === 0) return { text: JSON.stringify({ context_update, intent: "let them lead", note: null, no_note_reason: "Nothing new since the last note; they're following fine." }) };
    const blocked = k % 7 === 0;
    const note = {
      id: `n${k}`, rationale: `${cite} stood out in the last message (slower than usual); a concrete example may help.`,
      ...(blocked ? { observation: "You read the second paragraph slowly." } : { observation: "The timing part seemed to matter most to them." }),
      suggestion: { move: k % 2 ? "give_example" : "go_deeper", text: k % 2 ? `give one concrete example about step ${k}` : "go deeper on why the timing matters" },
      value: "A concrete anchor tends to help here.", evidence: [cite], confidence: 0.55 + (k % 4) * 0.08, expires_after_turns: 1,
    };
    return { text: "```json\n" + JSON.stringify({ context_update, intent: blocked ? "point at the slow part" : "make it concrete", note, no_note_reason: null }) + "\n```" };
  });
}
/** mock Actor: the reply's paragraphs ARE the replay's paragraph texts, so the AOIs line up with the rendered message */
export function simActor(replays: SimReplay[]): MockAdBackend {
  let k = 0;
  return new MockAdBackend([], (req) => {
    const user = req.messages[req.messages.length - 1]!.content;
    const r = replays[k++ % replays.length]!;
    const paras = [...r.turn.aois].sort((a, b) => a.order - b.order).map((a) => a.text ?? "");
    if (user === "(session start)") return { text: paras.join("\n\n") };
    // follows the hint on alternate calls: answers first, then one concrete example / why the timing matters
    const sys = req.messages[0]!.content;
    const hint = /If it fits after answering them: (.*?)\.?(?: \(h:|$)/m.exec(sys)?.[1];
    if (hint && k % 2 === 0) paras[paras.length - 1] += /example/.test(hint) ? " For example, one concrete step: feed it at the same time every day." : " The timing matters because the yeast and bacteria peak at different times.";
    return { text: paras.join("\n\n"), usage: { prompt_tokens: null } };
  });
}

export async function runSimSession(o: SimOptions): Promise<SimResult> {
  const turns = o.turns ?? 20;
  const sessionType = o.sessionType ?? "tab_visible";
  const storage = await AdStorage.open(o.kv);
  const clock = new ManualClock();
  const sessionId = o.sessionId ?? `sim-${sessionType}`;
  const log = new AdSessionLog(storage, sessionId, sessionType, clock);
  const r0 = o.replays[0]!;
  const layout = r0.turn.layout;
  const screen = r0.file.screen;
  const s = new ActorDirectorSession({
    log, userId: "sim", sessionType, arm: o.arm ?? "on", ...(o.pInject !== undefined ? { pInject: o.pInject } : {}),
    actor: o.actor ?? simActor(o.replays), director: o.director ?? simDirector(), counter: o.counter, consent: { camera: true, rawGaze: false }, seed: o.seed ?? 7,
    gaze: { tracker: "synthetic", permission: "granted" },
    device: { deviceModel: screen.deviceModel, platform: screen.platform, orientation: screen.orientation, widthPt: screen.widthPt, heightPt: screen.heightPt },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
    ...(o.judgeBackend ? { judgeBackend: o.judgeBackend } : {}), ...(o.directorEnabled ? { directorEnabled: o.directorEnabled } : {}),
    ...(o.directorPrompt ? { directorPrompt: o.directorPrompt } : {}),
    ...(sessionType === "blinded" ? { blind: { index: 1, total: 4, scheduleHash: "0".repeat(64) } } : {}),
  });
  const chat: SimChatMessage[] = [];
  const live: SimResult["live"] = [];
  const ppd = streamPpd(layout, r0.file.samples, { dist_cm: o.distCm ?? null, open_t: r0.turn.open_t });
  const gaze = new GazeSource({ ppd, viewport: { w: layout.viewport_w, h: layout.viewport_h } });
  let history: number[] = [];
  s.start();
  chat.push({ id: "a0", role: "assistant", text: await s.opener(), mono: clock.mono() });
  for (let t = 0; t < turns - 1; t++) {
    const r = o.replays[t % o.replays.length]!;
    const msg = `a${t}`;
    const base = clock.mono();
    const shift = (x: number) => x + base;
    const rename = (id: string) => id.replace(/^a\d+/, msg);
    const aois: Aoi[] = r.turn.aois.map((a) => ({ ...a, id: rename(a.id), msg, ...(a.visible ? { visible: a.visible.map(([v0, v1]) => [shift(v0), Math.min(shift(v1), 1e12)] as [number, number]) } : {}), ...(a.complete_t !== undefined ? { complete_t: shift(a.complete_t) } : {}) }));
    gaze.setAois(aois);
    const ss = [...r.file.samples].sort((a, b) => a.t - b.t).map((x) => ({ ...x, t: shift(x.t) }));
    const anchors = (r.turn.anchors ?? []).map((a) => ({ ...a, t: shift(a.t) })).sort((a, b) => a.t - b.t);
    let i = 0, ai = 0;
    const first = ss[0]?.t ?? base;
    for (let w = first + 100; i < ss.length; w += 100) {
      const batch: RawSample[] = [];
      while (i < ss.length && ss[i]!.t < w) batch.push(ss[i++]!);
      if (batch.length) gaze.push(batch);
      while (ai < anchors.length && anchors[ai]!.t + 100 <= w) gaze.anchor(anchors[ai++]!);
    }
    while (ai < anchors.length) gaze.anchor(anchors[ai++]!);
    const end = shift(r.turn.end_t);
    const out = gaze.closeTurn({ layout, aois, msg, open_t: shift(r.turn.open_t), stream_done_t: shift(r.turn.stream_done_t), end_t: end, turn: t, history, first_event_id: t * 10 + 1, anchors: [] });
    live.push({ ...gaze.live(), turn: t });
    history = baselineUpdate(history, (out.dwell as Array<{ gazeMs: number; words: number } | undefined>).filter((d): d is { gazeMs: number; words: number } => !!d).map((d) => ({ gazeMs: d.gazeMs, words: d.words })));
    clock.advance(Math.max(0, end - base));
    s.observeReading({ digest: out.digest, events: out.events, faceFrac: out.gaze_quality?.faceFrac ?? 0.95, baselineParagraphs: history.length });
    clock.advance(800);
    const q = QUESTIONS[t % QUESTIONS.length]!;
    chat.push({ id: `u${t}`, role: "user", text: q, mono: clock.mono() });
    const reply = await s.send(q);
    chat.push({ id: `a${t + 1}`, role: "assistant", text: reply, mono: clock.mono() });
    gaze.clear(end);
    clock.advance(1000);
  }
  await s.end("replay_end");
  await storage.flush();
  return { sessionId, sessionType, lines: log.lines, chat, storage, log, live, layout };
}
