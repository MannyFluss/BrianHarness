/**
 * E6: the actor-director mode's view store. Two sources:
 *  - LiveAdController: a real ActorDirectorSession (mock or Worker backends), a GazeTracker (plugin or the synthetic
 *    tracker), ParagraphVisibility from the tagged chat DOM, composer taps -> drift anchors, composer key TIMES
 *    (local only; never logged in v1, they only close the reading window at the first keystroke).
 *  - staticController(view): a fixed view (demo replays, screenshots, tests).
 * Blinded sessions: the view is a BlindedView. It has no tab model, no pending note, no live gaze, no margin
 * marks by construction; buildTabModel is never called and the session's full (sealed) lines never leave here.
 */
import {
  ActorDirectorSession, AdSessionLog, AdStorage, GazeSource, KeystrokeTimes, ParagraphVisibility, buildTabModel, calibrateBatch, calibrationStatus,
  gazeOptionsFromCalibration, accuracyWords, layoutFromScreen, gazeRef,
  type AdChatBackend, type CalibrationRecord, type LiveGaze, type ParaBox, type TabModel, type TokenCounter,
} from "@brianharness/core/actor-director/browser";
import type { Arm, AttentionEvent, BhAdEvent, DirectorOutput, GazeTracker, RailCode, ScreenInfo, SessionType } from "@brianharness/core/ad-contracts";
import type { KeyValueStore } from "@brianharness/core/browser";

export interface AdChatMsg { id: string; role: "user" | "assistant"; text: string; streaming?: boolean }
export interface CalibrationSummary { words: string; mode: "gaze" | "onscreen_only" | "none"; stale: string | null }
export interface PendingNote {
  turn: number;
  state: "thinking" | "no_note" | "blocked" | "waiting";
  output: DirectorOutput | null;
  railCodes: RailCode[];
  hint: string | null;
}
interface ViewBase { chat: AdChatMsg[]; busy: boolean; calibration: CalibrationSummary; camera: { on: boolean; paused: boolean } }
export interface VisibleView extends ViewBase {
  sessionType: "tab_visible";
  tab: TabModel;
  pending: PendingNote | null;
  live: LiveGaze | null;
  /** latest digest events (evidence ids -> paragraphs) */
  events: Array<Pick<AttentionEvent, "id" | "aoi">>;
}
export interface BlindedView extends ViewBase { sessionType: "blinded"; tab: null; pending: null; live: null; events: [] }
export type AdView = VisibleView | BlindedView;

export interface AdStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): AdView;
  /** the 10 Hz bottom layer pulls this (tab_visible only) */
  live(): LiveGaze | null;
  send?(text: string): Promise<void>;
  composerKey?(t: number): void;
  composerTap?(x: number, y: number, t: number): void;
  paragraphs?(boxes: ParaBox[], t: number, streaming: boolean): void;
  pauseTracking?(): Promise<void>;
  resumeTracking?(): Promise<void>;
}

export function staticController(view: AdView, liveFrames: LiveGaze[] = []): AdStore {
  let i = 0;
  return { subscribe: () => () => {}, getSnapshot: () => view, live: () => (view.sessionType === "tab_visible" && liveFrames.length ? liveFrames[i++ % liveFrames.length]! : view.live) };
}

/** a blinded view from chat only: nothing else can be passed in */
export function blindedView(chat: AdChatMsg[], calibration: CalibrationSummary, camera = { on: true, paused: false }, busy = false): BlindedView {
  return { sessionType: "blinded", chat: chat.map(({ id, role, text, streaming }) => ({ id, role, text, ...(streaming ? { streaming } : {}) })), busy, calibration, camera, tab: null, pending: null, live: null, events: [] };
}
export function visibleView(lines: readonly BhAdEvent[], chat: AdChatMsg[], o: { calibration: CalibrationSummary; camera?: { on: boolean; paused: boolean }; pending?: PendingNote | null; live?: LiveGaze | null; busy?: boolean }): VisibleView {
  const tab = buildTabModel(lines);
  const dig = [...lines].reverse().find((l): l is Extract<BhAdEvent, { type: "attention_digest" }> => l.type === "attention_digest");
  return { sessionType: "tab_visible", chat, busy: o.busy ?? false, calibration: o.calibration, camera: o.camera ?? { on: true, paused: false }, tab, pending: o.pending ?? null, live: o.live ?? null, events: dig ? dig.events.map((e) => ({ id: e.id, aoi: e.aoi })) : [] };
}
export function calibrationSummary(rec: CalibrationRecord | null, stale: string | null = null): CalibrationSummary {
  if (!rec) return { words: "Not calibrated: on-screen time only", mode: "none", stale };
  return { words: rec.mode === "gaze" ? `Gaze: ${accuracyWords(rec.errParas)}` : "On-screen time only (calibration was not accurate enough)", mode: rec.mode, stale };
}

export interface LiveOptions {
  sessionType: SessionType;
  arm: Arm;
  sessionId: string;
  userId: string;
  actor: AdChatBackend;
  director: AdChatBackend;
  counter: TokenCounter;
  kv: KeyValueStore;
  tracker: GazeTracker | null;
  screen: ScreenInfo;
  calibration: CalibrationRecord | null;
  consent: { camera: boolean; rawGaze: boolean };
  blind?: { index: number; total: number; scheduleHash: string };
  now?: () => number;
}

export class LiveAdController implements AdStore {
  private listeners = new Set<() => void>();
  private view: AdView;
  private chat: AdChatMsg[] = [];
  private busy = false;
  private session!: ActorDirectorSession;
  private log!: AdSessionLog;
  private gaze: GazeSource;
  private vis: ParagraphVisibility;
  private keys = new KeystrokeTimes();
  private history: number[] = [];
  private turn = 0;
  private openT: number | null = null;
  private streamDoneT: number | null = null;
  private closed = false;
  private paused = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastPendingKey = "";
  private now: () => number;
  private lastHead: { yaw: number; distCm: number } | null = null;

  private constructor(private o: LiveOptions) {
    this.now = o.now ?? (() => performance.now());
    const g = gazeOptionsFromCalibration(o.screen, o.calibration);
    this.gaze = new GazeSource({ ppd: g.ppd, viewport: g.viewport });
    this.vis = new ParagraphVisibility(g.viewport);
    this.view = this.build();
  }
  static async open(o: LiveOptions): Promise<LiveAdController> {
    const c = new LiveAdController(o);
    const storage = await AdStorage.open(o.kv);
    const clock = { now: () => Date.now(), mono: () => c.now() };
    c.log = new AdSessionLog(storage, o.sessionId, o.sessionType, clock);
    c.session = new ActorDirectorSession({
      log: c.log, userId: o.userId, sessionType: o.sessionType, arm: o.arm, actor: o.actor, director: o.director, counter: o.counter, consent: o.consent,
      gaze: { tracker: o.tracker ? "synthetic" : "none", permission: o.consent.camera ? "granted" : "denied" },
      device: { deviceModel: o.screen.deviceModel, platform: o.screen.platform, orientation: o.screen.orientation, widthPt: o.screen.widthPt, heightPt: o.screen.heightPt },
      ...(o.blind ? { blind: o.blind } : {}),
    });
    if (o.tracker) {
      await o.tracker.addListener("gaze", (e) => {
        if (c.paused) return;
        const batch = calibrateBatch(e.samples, o.calibration, o.screen.webview);
        const last = batch[batch.length - 1];
        if (last?.head) c.lastHead = { yaw: last.head.yaw, distCm: last.head.distCm };
        c.gaze.push(batch);
      });
    }
    c.session.start();
    c.busy = true; c.emit();
    const text = await c.session.opener();
    c.chat.push({ id: "a0", role: "assistant", text });
    c.busy = false; c.openReading();
    c.poll = setInterval(() => c.tick(), 100);
    return c;
  }
  dispose() { if (this.poll) clearInterval(this.poll); }

  // arrow properties: React calls these unbound (useSyncExternalStore, the 10 Hz pull)
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getSnapshot = () => this.view;
  live = (): LiveGaze | null => (this.o.sessionType === "tab_visible" && !this.paused ? this.gaze.live() : null);
  private emit() { this.view = this.build(); for (const l of this.listeners) l(); }

  private build(): AdView {
    const stale = this.o.calibration && this.lastHead ? calibrationStatus(this.o.calibration, { ...this.lastHead, orientation: this.o.screen.orientation, t: this.now() }) : null;
    const calibration = calibrationSummary(this.o.calibration, stale?.stale ? stale.words : null);
    const camera = { on: !!this.o.tracker && !this.paused, paused: this.paused };
    if (this.o.sessionType !== "tab_visible" || !this.log) return blindedView(this.chat, calibration, camera, this.busy);
    return visibleView(this.log.lines, [...this.chat], { calibration, camera, busy: this.busy, pending: this.pendingNote(), live: null });
  }
  private pendingNote(): PendingNote | null {
    const p = this.session?.peekPending();
    if (!p) return null;
    if (!p.settled) return { turn: p.turn, state: "thinking", output: null, railCodes: [], hint: null };
    if (!p.output?.note) return { turn: p.turn, state: "no_note", output: p.output, railCodes: [], hint: null };
    if (!p.rails?.pass) return { turn: p.turn, state: "blocked", output: p.output, railCodes: p.rails?.blocked_by ?? [], hint: null };
    return { turn: p.turn, state: "waiting", output: p.output, railCodes: [], hint: p.rails.actor_text };
  }
  private tick() {
    if (this.o.sessionType !== "tab_visible") return;
    const p = this.session.peekPending();
    const k = p ? `${p.turn}:${p.settled}` : "";
    if (k !== this.lastPendingKey) { this.lastPendingKey = k; this.emit(); }
  }

  private openReading() { this.openT = this.now(); this.streamDoneT = this.openT; this.closed = false; this.emit(); }
  /** the visible tagged paragraphs (the tab is not tagged, so its area is never an AOI) */
  paragraphs = (boxes: ParaBox[], t: number, streaming: boolean) => { this.vis.update(t, boxes, streaming); this.gaze.setAois(this.vis.aois(t)); }
  composerTap = (x: number, y: number, t: number) => { this.gaze.anchor({ t, x, y, kind: "tap" }); }
  /** a key event's time only; the first one after a reply closes the reading window and starts the Director */
  composerKey = (t: number) => {
    this.keys.record(t);
    if (!this.closed && this.openT !== null && t >= this.openT) { this.closeReading(t); this.session.beginDirector(); this.emit(); }
  }
  private closeReading(endT: number) {
    if (this.closed || this.openT === null) return;
    this.closed = true;
    const msg = `a${this.turn}`;
    const aois = this.vis.aois(endT).filter((a) => a.msg === msg);
    if (!aois.length) return;
    const layout = layoutFromScreen(this.o.screen);
    const out = this.gaze.closeTurn({ layout, aois, msg, open_t: this.openT, stream_done_t: this.streamDoneT ?? this.openT, end_t: endT, turn: this.turn, history: this.history, first_event_id: this.turn * 10 + 1, anchors: [] });
    this.history = gazeRef.baselineUpdate(this.history, (out.dwell as Array<{ gazeMs: number; words: number } | undefined>).filter((d): d is { gazeMs: number; words: number } => !!d));
    this.session.observeReading({ digest: out.digest, events: out.events, faceFrac: out.gaze_quality?.faceFrac ?? null, baselineParagraphs: this.history.length });
  }
  send = async (text: string) => {
    if (this.busy || !text.trim()) return;
    const t = this.now();
    this.closeReading(t);
    this.chat.push({ id: `u${this.turn}`, role: "user", text });
    this.busy = true; this.emit();
    const reply = await this.session.send(text);
    this.turn++;
    this.chat.push({ id: `a${this.turn}`, role: "assistant", text: reply });
    this.busy = false;
    this.gaze.clear(t - 60000);
    this.keys.clear(t);
    this.openReading();
  }
  pauseTracking = async () => { this.paused = true; await this.o.tracker?.pause(); this.emit(); }
  resumeTracking = async () => { this.paused = false; await this.o.tracker?.resume(); this.emit(); }
  async end() { this.dispose(); await this.session.end("user"); this.emit(); }
}
