import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { nextPaint, runStreamedTurn } from "./chat-flow";
import { completeReply, failStreaming } from "./reply-state";
import { bridge, type Hud as HudState, type Info, type RatingInput, type SessionItem } from "./bridge";
import { SessionRatingCard, TurnProbe, type SessionRatingResult } from "./components/Rating";
import { AWAY_MS, probeScheduler } from "./rating";
import { Composer } from "./components/Composer";
import { Hud } from "./components/Hud";
import { Message, Thinking, type ChatMsg } from "./components/Message";
import { Sidebar } from "./components/Sidebar";
import { TranscriptViewer } from "./components/TranscriptViewer";
import { transcriptAllowed } from "./transcript";
import { pickerLabel } from "./components/ModelPicker";
import { TopBar } from "./components/TopBar";
import { StudyLostBanner } from "./components/StudyData";
import { AppleSignInScreen, useAppleAuth } from "./components/AppleSignIn";
import { shouldOfferAtLaunch, type AppleAuthView } from "./transport/apple-auth";
import { useTypingTelemetry } from "./telemetry";
import { cn } from "./lib";
import { useLayoutMode, useVisualViewportHeight } from "./layout";
import { FeedbackSheet, type FeedbackSheetPhase } from "./components/FeedbackSheet";
import { assembleReport, isReportShortcut, reportAllowed } from "./feedback/report";
import { flightRecorder, setRecorderStudy, snapshotScreenNow } from "./feedback/recorder";
import { feedbackBracket } from "./feedback/away";
import type { FeedbackLogEvent, SessionTranscript } from "./transport/types";

let nextId = 0;
const mid = () => `m${++nextId}`;

/** wait for the SIWA launch checks only when nothing is stored; a slow check never holds the launch past this */
const LAUNCH_GATE_WAIT_MS = 2500;
async function launchGate(a: NonNullable<ReturnType<typeof bridge>["appleAuth"]>): Promise<AppleAuthView | null> {
  try {
    if ((await a.status()).tokenSource) return null;
    const v = await Promise.race([a.launch(), new Promise<null>((r) => setTimeout(() => r(null), LAUNCH_GATE_WAIT_MS))]);
    return v?.launchOffer ? v : null;
  } catch {
    return null;
  }
}

/** Final text replaces the streamed one (backends trim); adds the message if nothing streamed. */

export function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  /** typing indicator: on from the instant of send until the first token arrives */
  const [pending, setPending] = useState(true);
  const [hud, setHud] = useState<HudState | null>(null);
  const [stateNote, setStateNote] = useState("");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  /** a past session open read-only (sidebar row); the live session keeps running underneath, untouched */
  const [viewing, setViewing] = useState<SessionTranscript | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const layout = useLayoutMode();
  const phone = layout === "phone";
  useVisualViewportHeight();
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia("(max-width: 767px)").matches);
  // the Director HUD starts closed on every form factor (demo default, Nov 3 2026); the toggle and Cmd/Ctrl+H stay
  const [hudOpen, setHudOpen] = useState(false);
  // entering phone layout closes the overlays; leaving it restores the columns
  const prevLayout = useRef(layout);
  useEffect(() => {
    if (prevLayout.current === layout) return;
    const wasPhone = prevLayout.current === "phone";
    prevLayout.current = layout;
    if (phone) { setSidebarOpen(false); setHudOpen(false); }
    else if (wasPhone) setSidebarOpen(true); // the HUD stays as it was (closed unless toggled)
  }, [layout, phone]);
  const [tick, setTick] = useState(0);
  const [title, setTitle] = useState("New chat");
  const pickerRef = useRef<(() => void) | null>(null);
  // Reply-latency clock: completeAt of the Director's last message (fully rendered, stream end);
  // firstTokenAt is logged alongside. Engagement features use completeAt (see IOS_PORTING.md).
  const shownAt = useRef(Date.now());
  const firstTokenAt = useRef<number | undefined>(undefined);
  const stampedId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tel = useTypingTelemetry();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // ---- absorption ratings (evaluation only; logged as {type:"rating"} records) ----
  const [probe, setProbe] = useState<{ turn: number; shownAt: number; afterId: string } | null>(null);
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const [card, setCard] = useState<{ turn: number; shownAt: number } | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const cardState = useRef<SessionRatingResult | null>(null);
  const scheduler = useRef(probeScheduler("boot"));
  const userTurns = useRef(0);
  const logRating = useCallback((r: RatingInput) => {
    void bridge().rate?.(r).catch((err) => console.warn("[brianharness] rating not logged", err));
  }, []);
  const dismissProbe = useCallback((reason: string) => {
    const p = probeRef.current;
    if (!p) return;
    probeRef.current = null;
    setProbe(null);
    logRating({ scope: "turn", turn: p.turn, value: null, shownAt: p.shownAt, answeredAt: null, dismissed: true, reason });
  }, [logRating]);

  const refreshSessions = useCallback(async () => setSessions(await bridge().sessions()), []);

  /** One streamed Director turn: indicator first, then tokens, then the final text. */
  const streamTurn = useCallback(async <R extends { director: { text: string } }>(showPending: () => void, call: (onToken: (d: string) => void) => Promise<R>) => {
    const replyId = mid();
    const { result } = await runStreamedTurn({
      showPending: () =>
        flushSync(() => {
          showPending();
          setBusy(true);
          setPending(true);
        }),
      paint: () => nextPaint(window),
      call,
      onFirstToken: (text, at) => {
        setPending(false);
        setMessages((m) => [...m, { id: replyId, role: "assistant", text, streaming: true, firstTokenAt: at }]);
      },
      onText: (text) => setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, text } : x))),
    });
    return { result, replyId };
  }, []);

  const startNew = useCallback(async () => {
    try {
      const { result: r, replyId } = await streamTurn(() => { setViewing(null); setMessages([]); }, (onToken) => bridge().newSession(onToken));
      setMessages((m) => completeReply(m, replyId, r.director.text, r.director.truncated));
      scheduler.current = probeScheduler(r.sessionId); // seeded per session: reproducible probe turns
      userTurns.current = 0;
      setTitle(r.title ?? "New chat");
      setHud(r.hud);
      setStateNote(r.director.stateNote);
    } catch (err) {
      setMessages((m) => failStreaming(m, (err as Error).message, mid()));
    } finally {
      setPending(false);
      setBusy(false);
    }
    void refreshSessions();
  }, [refreshSessions, streamTurn]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode double-mount guard: one session per launch
    booted.current = true;
    void bridge().info().then(setInfo);
    // Not signed in (Sign in with Apple available, nothing in the Spider Cloud slot): the sign-in screen is the
    // ONLY launch screen and the first chat starts after it (signed in -> Spider Cloud, or Skip). Anything
    // else (a stored token, no BHAppleAuth, slow launch checks) starts the chat right away, as before.
    void (async () => {
      const a = bridge().appleAuth;
      const gate = a ? await launchGate(a) : null;
      if (gate) {
        siwaDecided.current = true; // the post-session offer below never shows a second screen
        setLaunchApple(gate);
        setSiwaGate(true);
        return;
      }
      void startNew();
    })();
  }, [startNew]);
  const [siwaGate, setSiwaGate] = useState(false);
  const leaveGate = useCallback(() => {
    setSiwaGate(false);
    void bridge().info().then(setInfo); // the provider may have become Spider Cloud (token saved)
    void startNew();
  }, [startNew]);

  // ---- Sign in with Apple launch screen (UI only; the session above starts regardless) ----
  // Decided ONCE per launch, after the launch checks and the first session's start: shown only with nothing
  // in the Spider Cloud slot, before the first turn, and never over a study session (shouldOfferAtLaunch).
  const appleView = useAppleAuth();
  const [launchApple, setLaunchApple] = useState<AppleAuthView | null>(null);
  const [siwaOpen, setSiwaOpen] = useState(false);
  const siwaDecided = useRef(false);
  useEffect(() => {
    const a = bridge().appleAuth;
    if (!a) return;
    let live = true;
    void a.launch().then((v) => live && setLaunchApple(v), () => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (siwaDecided.current || !launchApple || busy) return;
    siwaDecided.current = true;
    if (shouldOfferAtLaunch(launchApple, { sessionReady: true, study: !!hud?.study, userTurns: userTurns.current, drafting: !!draftRef.current, ratingOpen: !!cardRef.current, alreadyOffered: false })) setSiwaOpen(true);
  }, [launchApple, busy, hud]);

  // The commit that shows the Director's message COMPLETE (stream end) starts the reply-latency
  // clock (completeAt), once per message; its first-token time is kept for the turn log.
  // Pinned-to-bottom (report d2bd6006 P3): the transcript follows the newest message only while the user is at the
  // bottom. A programmatic scroll counts as pinned until it settles (a smooth scroll passes through "not at the bottom").
  const pinned = useRef(true);
  const autoScrollUntil = useRef(0);
  const pinToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const sc = scroller.current;
    if (!sc) return;
    autoScrollUntil.current = Date.now() + (behavior === "smooth" ? 900 : 150);
    pinned.current = true;
    sc.scrollTo({ top: sc.scrollHeight, behavior });
  }, []);
  const onTranscriptScroll = useCallback(() => {
    const sc = scroller.current;
    if (!sc || Date.now() < autoScrollUntil.current) return;
    pinned.current = sc.scrollHeight - sc.clientHeight - sc.scrollTop < 48;
  }, []);
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.streaming && stampedId.current !== last.id) {
      stampedId.current = last.id;
      shownAt.current = Date.now();
      firstTokenAt.current = last.firstTokenAt;
    }
    // the user's own message always brings the view down; a reply (streaming or complete) only if they were at the bottom
    if (last?.role === "user" || pinned.current) pinToBottom(last?.streaming ? "auto" : "smooth");
  }, [messages, pinToBottom]);
  // the iPad / iPhone keyboard (visualViewport resize -> --app-h) or any other resize shrinks the transcript while its
  // scrollTop stays put, which hid the newest reply while composing: re-pin after the resize if the user was at the bottom
  useEffect(() => {
    const sc = scroller.current;
    let raf = 0;
    const repin = () => { if (!pinned.current) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => pinToBottom("auto")); };
    const ro = typeof ResizeObserver === "undefined" || !sc ? null : new ResizeObserver(repin);
    if (sc) ro?.observe(sc);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", repin);
    window.addEventListener("resize", repin);
    return () => { ro?.disconnect(); vv?.removeEventListener("resize", repin); window.removeEventListener("resize", repin); cancelAnimationFrame(raf); };
  }, [pinToBottom]);
  // UI only (scroll nit, Nov 3): the composer dock floats over the transcript and grows (multi-line draft, extractor
  // warning, safe area) past the fixed pb-40, and a smooth scroll that starts far away after a very long reply can
  // stop short. So the transcript's bottom padding tracks the dock's real height, and once a reply is complete the
  // view is pinned to the bottom again after layout settles, so the "reply cut off" note clears the composer.
  const dock = useRef<HTMLDivElement>(null);
  const [dockPad, setDockPad] = useState<number | null>(null);
  useEffect(() => {
    const el = dock.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const sc = scroller.current;
      const atBottom = pinned.current || (!!sc && sc.scrollHeight - sc.clientHeight - sc.scrollTop < 48);
      setDockPad(Math.ceil(el.getBoundingClientRect().height) + 16);
      if (atBottom) requestAnimationFrame(() => pinToBottom("auto"));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pinToBottom]);
  useEffect(() => {
    const last = messages[messages.length - 1];
    const sc = scroller.current;
    if (!sc || !last || last.role !== "assistant" || last.streaming || !pinned.current) return;
    let f2 = 0;
    const f1 = requestAnimationFrame(() => { f2 = requestAnimationFrame(() => pinToBottom("auto")); });
    return () => { cancelAnimationFrame(f1); cancelAnimationFrame(f2); };
  }, [messages, pinToBottom]);

  // ---- in-app bug report (Report row, Cmd/Ctrl+Shift+R, window.__bhReport). UI only: opening the sheet doesn't
  // hide the page (no AWAY_MS), start or end a session, or touch ratings / study state.
  const [report, setReport] = useState<{ trigger: string } | null>(null);
  const [reportPhase, setReportPhase] = useState<FeedbackSheetPhase>({ kind: "idle" });
  const reportRef = useRef(report);
  reportRef.current = report;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const uiRef = useRef({ layout: layout as string, sidebarOpen, hudOpen, busy });
  uiRef.current = { layout, sidebarOpen, hudOpen, busy };
  const infoRef = useRef(info);
  infoRef.current = info;
  const canReport = !!bridge().feedback;
  // session log (Director-approved): feedback_open, then feedback_sent {report_id} on Send, then feedback_closed {sent}
  const reportSent = useRef(false);
  const logFeedback = (e: FeedbackLogEvent) => { void bridge().feedback?.log?.(e).catch(() => {}); };
  const openReport = useCallback((trigger: string) => {
    if (!reportAllowed({ canReport: !!bridge().feedback, reportOpen: !!reportRef.current, ratingCardOpen: !!cardRef.current, turnProbeOpen: !!probeRef.current })) {
      // a rating step is showing: blocked, nothing in the session log; the flight recorder notes only the trigger
      if (bridge().feedback && !reportRef.current) flightRecorder.record("state", { event: "report_blocked", trigger });
      return;
    }
    snapshotScreenNow(); // the screen as it was, before the sheet covers it
    flightRecorder.record("state", { event: "report_open", trigger });
    reportSent.current = false;
    const openedAt = Date.now();
    feedbackBracket.open(openedAt);
    logFeedback({ type: "feedback_open", ts: openedAt, trigger });
    reportRef.current = { trigger };
    setReportPhase({ kind: "idle" });
    setReport({ trigger });
  }, []);
  const closeReport = useCallback(() => {
    if (!reportRef.current) return;
    const closedAt = Date.now();
    feedbackBracket.close(closedAt);
    logFeedback({ type: "feedback_closed", ts: closedAt, sent: reportSent.current });
    reportRef.current = null;
    setReport(null);
  }, []);
  const sendReport = useCallback(async (note: string) => {
    const r = reportRef.current;
    const fb = bridge().feedback;
    if (!r || !fb) return;
    setReportPhase({ kind: "sending" });
    try {
      const doc = await assembleReport({ note, trigger: r.trigger, messages: messagesRef.current, recorder: flightRecorder, bridge: bridge(), info: infoRef.current, ui: uiRef.current });
      if (!reportSent.current) logFeedback({ type: "feedback_sent", ts: Date.now(), report_id: doc.report_id });
      reportSent.current = true;
      const result = await fb.send(doc);
      setReportPhase({ kind: "done", result });
    } catch (err) {
      setReportPhase({ kind: "done", result: { state: "failed", queued: false, reason: (err as Error).message } });
    }
  }, []);
  useEffect(() => { setRecorderStudy(!!hud?.study); }, [hud]);
  useEffect(() => {
    window.__bhReport = (o) => openReport(o?.source ?? "hook");
    return () => { delete window.__bhReport; };
  }, [openReport]);
  useEffect(() => {
    // the page is going away with the sheet open: close it, so feedback_open always gets its feedback_closed
    const onHide = () => closeReport();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [closeReport]);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setTick((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") { e.preventDefault(); setHudOpen((v) => !v); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (isReportShortcut(e)) { e.preventDefault(); openReport("shortcut"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openReport]);

  const send = useCallback(async (textArg?: string) => {
    const text = (textArg ?? draftRef.current).trim();
    if (!text) return;
    dismissProbe("sent");
    const events = tel.take(text.length);
    const sentAt = Date.now();
    const userMsg: ChatMsg = { id: mid(), role: "user", text };
    const prompt = { shownAt: shownAt.current, firstTokenAt: firstTokenAt.current };
    try {
      // indicator + user bubble are committed and painted BEFORE the transport is called
      const { result: r, replyId } = await streamTurn(
        () => {
          setMessages((m) => [...m, userMsg]);
          setDraft("");
        },
        (onToken) => bridge().reply({ text, events, sentAt, ...prompt }, onToken),
      );
      setMessages((m) => completeReply(m.map((x) => (x.id === userMsg.id ? { ...x, engagement: r.engagement } : x)), replyId, r.director.text, r.director.truncated));
      const turn = r.hud?.turn ?? ++userTurns.current;
      userTurns.current = turn;
      if (bridge().rate && scheduler.current.shouldProbe(turn)) setProbe({ turn, shownAt: Date.now(), afterId: replyId });
      setHud(r.hud);
      setStateNote(r.director.stateNote);
      if (r.title) setTitle(r.title);
    } catch (err) {
      setMessages((m) => failStreaming(m, (err as Error).message, mid()));
    } finally {
      setPending(false);
      setBusy(false);
      void refreshSessions();
    }
  }, [tel, refreshSessions, streamTurn, dismissProbe]);

  // typing a reply dismisses the turn probe (it must never block the conversation)
  useEffect(() => {
    if (draft && probeRef.current) dismissProbe("typed");
  }, [draft, dismissProbe]);

  /** End of session: the rating card first (if there was a conversation), then the new session. */
  const requestNew = useCallback(() => {
    dismissProbe("new-chat");
    if (cardRef.current) return;
    if (bridge().rate && userTurns.current > 0) setCard({ turn: userTurns.current, shownAt: Date.now() });
    else void startNew();
  }, [dismissProbe, startNew]);
  const closeCard = useCallback((res: SessionRatingResult, how: "done" | "skip" | "closed") => {
    const c = cardRef.current;
    if (!c) return;
    cardRef.current = null;
    cardState.current = null;
    setCard(null);
    logRating({ scope: "session", turn: c.turn, value: res.value, shownAt: c.shownAt, answeredAt: res.answeredAt, dismissed: res.value === null, ...(how !== "done" ? { reason: how === "skip" ? "skipped" : "closed" } : {}), hooked: res.hooked, blindGuess: res.blindGuess });
    if (how !== "closed") void startNew();
  }, [logRating, startNew]);

  // leaving: closing the app logs whatever is on screen; coming back after AWAY_MS = a new session
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      // time hidden while the Report sheet was open (e.g. the iOS share sheet of the export fallback) is not away
      if (hiddenAt && feedbackBracket.awayMs(hiddenAt, Date.now()) >= AWAY_MS) requestNew();
      hiddenAt = 0;
    };
    const onHide = () => {
      if (probeRef.current) dismissProbe("closed");
      if (cardRef.current) closeCard(cardState.current ?? { value: null, answeredAt: null, hooked: "", blindGuess: null }, "closed");
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
    };
  }, [requestNew, dismissProbe, closeCard]);

  // ---- past sessions, read-only (sidebar rows). Viewing reads the stored log only: no session starts, resumes or
  // ends, nothing is written to any session log, no rating is shown or dismissed. Blocked while a STUDY session is in
  // progress (rows disabled, and the transport refuses too), while a reply is coming, and while a rating step or the
  // Report sheet is showing; the live session underneath is never touched.
  const studyActive = !!hud?.study;
  const canOpenPast = !!bridge().sessionTranscript;
  const openLocked = !canOpenPast ? null
    : studyActive ? "Past chats open after this study session."
    : busy || card || probe ? "Past chats open once this step is done." : null;
  const openSession = useCallback(async (s: SessionItem) => {
    if (s.active) { setViewing(null); if (phone) setSidebarOpen(false); return; } // the current row: back to the live chat
    if (!transcriptAllowed({ canOpen: !!bridge().sessionTranscript, studyActive: !!hud?.study, busy: uiRef.current.busy, ratingCardOpen: !!cardRef.current, turnProbeOpen: !!probeRef.current, reportOpen: !!reportRef.current })) return;
    const t = await bridge().sessionTranscript!(s.id).catch(() => null);
    if (!t) return;
    flightRecorder.record("state", { event: "past_chat_open", turns: t.turns.length });
    setViewing(t);
    if (phone) setSidebarOpen(false);
  }, [hud, phone]);
  const closeViewer = useCallback(() => setViewing(null), []);
  useEffect(() => { if (studyActive) setViewing(null); }, [studyActive]);
  // back from a past chat: the live transcript was display:none, so pin it to the newest message again
  useEffect(() => { if (!viewing) pinToBottom("auto"); }, [viewing, pinToBottom]);

  // dev/debug only: schedule hash (never the order) and the explicit unseal command
  useEffect(() => {
    const dev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV || (() => { try { return localStorage.getItem("bh.debug") === "1"; } catch { return false; } })();
    if (!dev || !bridge().study?.hash) return;
    window.__bhStudy = { hash: () => bridge().study!.hash!(), unseal: (confirm: string) => bridge().study!.unseal!(confirm) };
  }, []);

  // Test/screenshot hook: types through the same telemetry path a human would.
  useEffect(() => {
    window.__eegDemo = {
      type: async (text: string) => {
        let cur = "";
        await new Promise((r) => setTimeout(r, 400));
        for (const ch of text) {
          cur += ch;
          tel.inject([{ t: Date.now(), kind: "insert", len: cur.length }]);
          setDraft(cur);
          await new Promise((r) => setTimeout(r, 45));
        }
        await send(cur);
        while (document.querySelector("[data-busy='true']")) await new Promise((r) => setTimeout(r, 50));
      },
      draft: (text: string) => setDraft(text),
      probe: () => setProbe({ turn: userTurns.current || 1, shownAt: Date.now(), afterId: "" }),
      endSession: () => requestNew(),
      openPicker: () => pickerRef.current?.(),
    };
  }, [send, tel, requestNew]);

  return (
    <div className="eeg-app flex" data-busy={busy ? "true" : "false"} data-layout={layout}>
      <Sidebar variant={phone ? "drawer" : "column"} open={sidebarOpen} sessions={sessions} onOpenSession={canOpenPast ? (x) => void openSession(x) : undefined} viewingId={viewing?.id ?? null} openLocked={openLocked} info={info} onNew={() => { if (phone) setSidebarOpen(false); setViewing(null); requestNew(); }} onClose={() => setSidebarOpen(false)} onInfo={setInfo} pickerRef={pickerRef} onReport={canReport ? () => { if (phone) setSidebarOpen(false); openReport("sidebar"); } : undefined} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar sidebarOpen={sidebarOpen && !phone} onOpenSidebar={() => { setSidebarOpen(true); if (phone) setHudOpen(false); }} hudOpen={hudOpen} onToggleHud={() => { setHudOpen((v) => !v); if (phone) setSidebarOpen(false); }}>
          <span className="font-title text-2xl tracking-tight md:text-3xl" title={viewing?.title ?? title}>{viewing?.title ?? title}</span>
        </TopBar>
        <StudyLostBanner />
        <div className="flex min-h-0 flex-1">
          {viewing && <TranscriptViewer t={viewing} onBack={closeViewer} onNew={() => { setViewing(null); requestNew(); }} />}
          <div className={cn("relative flex min-w-0 flex-1 flex-col", viewing && "hidden")} aria-hidden={viewing ? true : undefined}>
            <div ref={scroller} onScroll={onTranscriptScroll} className="flex-1 overflow-y-auto overscroll-contain">
              <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 pb-40 pt-6 md:px-6 md:pt-8" style={dockPad ? { paddingBottom: Math.max(160, dockPad) } : undefined} data-transcript>
                {messages.map((m) => <Message key={m.id} msg={m} />)}
                {probe && !pending && <TurnProbe onSkip={() => dismissProbe("skipped")} onRate={(v) => { const p = probeRef.current; if (!p) return; probeRef.current = null; setProbe(null); logRating({ scope: "turn", turn: p.turn, value: v, shownAt: p.shownAt, answeredAt: Date.now(), dismissed: false }); }} />}
                {pending && <Thinking tick={tick} />}
              </div>
            </div>
            <div ref={dock} className="eeg-composer-dock pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent pt-10">
              <div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-3 md:px-4">
                {hud?.extractorWarning && (
                  <div role="status" data-testid="extractor-warning" className="mb-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-center text-xs text-amber-200/90">
                    {hud.extractorWarning}
                  </div>
                )}
                <Composer value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} telemetryRef={tel.attach} />
                <div className="mt-2 truncate text-center text-xs text-muted-foreground/60">typing telemetry is logged locally · {pickerLabel(info)}</div>
              </div>
            </div>
          </div>
          {hudOpen && !phone && <Hud variant="column" hud={hud} stateNote={stateNote} />}
        </div>
      </main>
      <AppleSignInScreen open={siwaGate} gate view={appleView ?? launchApple} phone={phone} onClose={leaveGate} />
      <AppleSignInScreen open={siwaOpen && !card} view={appleView ?? launchApple} phone={phone} onClose={() => setSiwaOpen(false)} />
      <SessionRatingCard open={!!card} study={!!hud?.study} phone={phone} stateRef={cardState} onClose={closeCard} />
      {phone && <Hud variant="sheet" open={hudOpen} onClose={() => setHudOpen(false)} hud={hud} stateNote={stateNote} />}
      <FeedbackSheet open={!!report} phone={phone} phase={reportPhase} onSend={(n) => void sendReport(n)} onClose={closeReport} />
    </div>
  );
}
