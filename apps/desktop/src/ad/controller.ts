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
  gazeOptionsFromCalibration, accuracyWords, layoutFromScreen, gazeRef, type Preflight,
  type AdChatBackend, type CalibrationRecord, type LiveGaze, type ParaBox, type TabModel, type TokenCounter,
} from "@brianharness/core/actor-director/browser";
import type { Arm, AttentionEvent, BhAdEvent, DirectorOutput, GazeSrc, GazeStatus, GazeTracker, RailCode, ScreenInfo, SessionType } from "@brianharness/core/ad-contracts";
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
  /** the Director sheet covers the chat (phone): gaze is not attributed to paragraphs (I4) */
  occluded?: boolean;
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
  /** the tab covers the chat (phone sheet open over it) from t; false when it stops covering */
  occlusion?(covered: boolean, t: number): void;
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

/**
 * the session_start gaze.tracker label from what the tracker actually runs (IOS Dev I4: a present tracker is not
 * necessarily synthetic): start mode "synthetic" -> "synthetic"; "camera" -> the tracker kind (arkit | mediapipe);
 * not started yet -> the src of the first sample if one is known; otherwise "none".
 */
export function trackerLabel(status: Pick<GazeStatus, "mode" | "tracker"> | null, firstSrc?: GazeSrc | null): GazeSrc | "none" {
  if (status?.mode === "synthetic") return firstSrc === "replay" ? "replay" : "synthetic";
  if (status?.mode === "camera" && status.tracker) return status.tracker;
  return firstSrc ?? "none";
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
  /** override for session_start gaze.tracker; default: trackerLabel(await tracker.getStatus()) */
  trackerKind?: GazeSrc | "none";
  /** stored calibrations (per device model + orientation); consulted on rotation */
  calStore?: { load(deviceModel: string, orientation: ScreenInfo["orientation"]): CalibrationRecord | null };
  /** called with a message's aoi_layout boxes each time it is logged (first full layout of a reply, after a rotation); the demo drives synthetic gaze from it */
  onReadingLayout?: (msg: string, boxes: Array<{ aoi: string; words: number; x: number; y: number; w: number; h: number }>) => void;
  /** E7 preflight: started with the mode (then every 60 s), consulted before each Director call */
  preflight?: Preflight;
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
  private layoutDirty = false;
  private layoutLoggedFor: string | null = null;
  private occStart: number | null = null;
  /** occluded spans [t0,t1] in the current reading window */
  private occSpans: Array<[number, number]> = [];

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
    const kind = o.trackerKind ?? (o.tracker ? trackerLabel(await o.tracker.getStatus().catch(() => null)) : "none");
    c.session = new ActorDirectorSession({
      log: c.log, userId: o.userId, sessionType: o.sessionType, arm: o.arm, actor: o.actor, director: o.director, counter: o.counter, consent: o.consent,
      gaze: { tracker: kind, permission: o.consent.camera ? "granted" : "denied" },
      ...(o.preflight ? { preflight: o.preflight } : {}),
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
    if (o.preflight) await o.preflight.start();
    c.busy = true; c.emit();
    const text = await c.session.opener();
    c.chat.push({ id: "a0", role: "assistant", text });
    c.busy = false; c.openReading();
    c.poll = setInterval(() => c.tick(), 100);
    return c;
  }
  dispose() { if (this.poll) clearInterval(this.poll); this.o.preflight?.stop(); }
  /** E7: the preflight's status line ("code: plain words"), "" when every check passes */
  get healthLine(): string { return this.o.preflight?.lastReport?.statusLine ?? ""; }

  // arrow properties: React calls these unbound (useSyncExternalStore, the 10 Hz pull)
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getSnapshot = () => this.view;
  live = (): LiveGaze | null => {
    if (this.o.sessionType !== "tab_visible" || this.paused) return null;
    const g = this.gaze.live();
    return g && this.occStart !== null ? { ...g, target: null } : g;
  }
  private emit() { this.view = this.build(); for (const l of this.listeners) l(); }

  private build(): AdView {
    const stale = this.o.calibration && this.lastHead ? calibrationStatus(this.o.calibration, { ...this.lastHead, orientation: this.o.screen.orientation, t: this.now() }) : null;
    const calibration = calibrationSummary(this.o.calibration, stale?.stale ? stale.words : null);
    const camera = { on: !!this.o.tracker && !this.paused, paused: this.paused };
    if (this.o.sessionType !== "tab_visible" || !this.log) return blindedView(this.chat, calibration, camera, this.busy);
    return { ...visibleView(this.log.lines, [...this.chat], { calibration, camera, busy: this.busy, pending: this.pendingNote(), live: null }), occluded: this.occStart !== null };
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
  paragraphs = (boxes: ParaBox[], t: number, streaming: boolean) => {
    this.vis.update(t, boxes, streaming); this.gaze.setAois(this.vis.aois(t));
    const msg = `a${this.turn}`;
    if (!streaming && (this.layoutDirty || this.layoutLoggedFor !== msg) && boxes.some((b) => b.msg === msg)) this.logLayout();
  }
  /** aoi_layout for the current reply: once when it is first fully laid out, again after a rotation / resize */
  private logLayout() {
    if (!this.log) return;
    const msg = `a${this.turn}`;
    this.layoutDirty = false; this.layoutLoggedFor = msg;
    const boxes = this.vis.layoutBoxes(msg);
    this.session.logGaze({ type: "aoi_layout", turn: this.turn, msg, orientation: this.o.screen.orientation, boxes });
    this.o.onReadingLayout?.(msg, boxes);
  }
  /**
   * phone sheet over the chat (I4, contract v1.2 tab_occluded): while covered, gaze is not attributed to paragraphs
   * (the app passes no boxes, so every visible interval is closed) and the span is excluded from per-paragraph
   * reading features: in a window with occlusion, a paragraph with no uncovered gaze is left out of the digest
   * (unknown: it may have been read under the sheet), never labelled "skipped".
   * The span is logged when the cover lifts, or at the window's close (then continues into the next window).
   */
  occlusion = (covered: boolean, t: number) => {
    if (covered && this.occStart === null) { this.occStart = t; this.vis.update(t, [], false); this.gaze.setAois(this.vis.aois(t)); this.emit(); }
    else if (!covered && this.occStart !== null) { this.endOcclusion(t); this.emit(); }
  }
  private endOcclusion(t: number) {
    if (this.occStart === null) return;
    const t0 = this.occStart;
    this.occStart = null;
    if (t <= t0) return;
    this.occSpans.push([t0, t]);
    if (this.log && this.o.sessionType === "tab_visible") this.session.logGaze({ type: "tab_occluded", turn: this.turn, msg: `a${this.turn}`, t0, t1: t, ms: Math.round(t - t0) });
  }
  get occluded(): boolean { return this.occStart !== null; }
  /**
   * rotation / resize (IOS Dev I4): take the new screen info, swap to the stored calibration for the new orientation
   * (restoring a native-fit model into the tracker), or run uncalibrated (on-screen time only) and log
   * gaze.calibration_stale when none is stored; rebuild the gaze geometry; re-log aoi_layout with the new boxes
   * (now if given, else on the next paragraphs() call). The open reading window keeps its time span; samples before
   * the change are dropped (they were mapped with the old geometry).
   */
  orientationChanged = async (screen: ScreenInfo, boxes?: ParaBox[], t = this.now()) => {
    const prev = this.o.screen;
    const rotated = screen.orientation !== prev.orientation || screen.deviceModel !== prev.deviceModel;
    const resized = screen.webview.width !== prev.webview.width || screen.webview.height !== prev.webview.height;
    if (!rotated && !resized) return;
    this.o.screen = screen;
    if (rotated) {
      const rec = this.o.calStore?.load(screen.deviceModel, screen.orientation) ?? null;
      this.o.calibration = rec;
      this.lastHead = null;
      if (rec?.model && this.o.tracker) await this.o.tracker.restoreCalibration({ orientation: screen.orientation, model: rec.model }).catch(() => ({ ok: false }));
      if (!rec) this.session.logGaze({ type: "health", check: "calibration.valid", ok: false, code: "gaze.calibration_stale", detail: `no stored calibration for ${screen.orientation}: on-screen time only until you calibrate` });
    }
    const g = gazeOptionsFromCalibration(screen, this.o.calibration);
    this.gaze = new GazeSource({ ppd: g.ppd, viewport: g.viewport });
    this.vis = new ParagraphVisibility(g.viewport);
    this.layoutDirty = true;
    if (boxes) this.paragraphs(boxes, t, false);
    this.emit();
  }
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
    const wasCovered = this.occStart !== null;
    if (wasCovered) this.endOcclusion(endT);
    const covered = this.occSpans.length > 0;
    // a paragraph never uncovered-and-visible in this window is excluded (not "skipped") when the tab covered the chat
    const aois = this.vis.aois(endT).filter((a) => a.msg === msg && (!covered || (a.visible ?? []).some(([x, y]) => y > (this.openT ?? 0) && x < endT && y > x)));
    this.occSpans = [];
    if (wasCovered) this.occStart = endT;
    if (!aois.length) return;
    const layout = layoutFromScreen(this.o.screen);
    const run = (as: typeof aois) => this.gaze.closeTurn({ layout, aois: as, msg, open_t: this.openT!, stream_done_t: this.streamDoneT ?? this.openT!, end_t: endT, turn: this.turn, history: this.history, first_event_id: this.turn * 10 + 1, anchors: [] });
    let out = run(aois);
    if (covered) {
      // the reader may have read it under the sheet: a paragraph with no uncovered gaze is unknown, left out (not "skipped")
      const seen = new Set((out.dwell as Array<{ aoi: string; gazeMs: number } | undefined>).filter((d) => d && d.gazeMs > 0).map((d) => d!.aoi));
      const keep = aois.filter((a) => seen.has(a.id));
      if (!keep.length) return;
      if (keep.length !== aois.length) out = run(keep);
    }
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
