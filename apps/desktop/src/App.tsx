import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { nextPaint, runStreamedTurn } from "./chat-flow";
import { bridge, type Hud as HudState, type Info, type SessionItem } from "./bridge";
import { Composer } from "./components/Composer";
import { Hud } from "./components/Hud";
import { Message, Thinking, type ChatMsg } from "./components/Message";
import { Sidebar } from "./components/Sidebar";
import { pickerLabel } from "./components/ModelPicker";
import { TopBar } from "./components/TopBar";
import { useTypingTelemetry } from "./telemetry";
import { useLayoutMode, useVisualViewportHeight } from "./layout";

let nextId = 0;
const mid = () => `m${++nextId}`;

/** Final text replaces the streamed one (backends trim); adds the message if nothing streamed. */
const completeReply = (m: ChatMsg[], replyId: string, text: string): ChatMsg[] =>
  m.some((x) => x.id === replyId) ? m.map((x) => (x.id === replyId ? { ...x, text, streaming: false } : x)) : [...m, { id: replyId, role: "assistant", text }];

export function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  /** typing indicator: on from the instant of send until the first token arrives */
  const [pending, setPending] = useState(true);
  const [hud, setHud] = useState<HudState | null>(null);
  const [stateNote, setStateNote] = useState("");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const layout = useLayoutMode();
  const phone = layout === "phone";
  useVisualViewportHeight();
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia("(max-width: 767px)").matches);
  const [hudOpen, setHudOpen] = useState(() => !matchMedia("(max-width: 767px)").matches);
  // entering phone layout closes the overlays; leaving it restores the columns
  const prevLayout = useRef(layout);
  useEffect(() => {
    if (prevLayout.current === layout) return;
    const wasPhone = prevLayout.current === "phone";
    prevLayout.current = layout;
    if (phone) { setSidebarOpen(false); setHudOpen(false); }
    else if (wasPhone) { setSidebarOpen(true); setHudOpen(true); }
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
      const { result: r, replyId } = await streamTurn(() => setMessages([]), (onToken) => bridge().newSession(onToken));
      setMessages((m) => completeReply(m, replyId, r.director.text));
      setTitle(r.title ?? "New chat");
      setHud(r.hud);
      setStateNote(r.director.stateNote);
    } catch (err) {
      setMessages((m) => [...m, { id: mid(), role: "assistant", text: `⚠ ${(err as Error).message}` }]);
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
    void startNew();
  }, [startNew]);

  // The commit that shows the Director's message COMPLETE (stream end) starts the reply-latency
  // clock (completeAt), once per message; its first-token time is kept for the turn log.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.streaming && stampedId.current !== last.id) {
      stampedId.current = last.id;
      shownAt.current = Date.now();
      firstTokenAt.current = last.firstTokenAt;
    }
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: last?.streaming ? "auto" : "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setTick((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") { e.preventDefault(); setHudOpen((v) => !v); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebarOpen((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = useCallback(async (textArg?: string) => {
    const text = (textArg ?? draftRef.current).trim();
    if (!text) return;
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
      setMessages((m) => completeReply(m.map((x) => (x.id === userMsg.id ? { ...x, engagement: r.engagement } : x)), replyId, r.director.text));
      setHud(r.hud);
      setStateNote(r.director.stateNote);
      if (r.title) setTitle(r.title);
    } catch (err) {
      setMessages((m) => [...m.map((x) => (x.streaming ? { ...x, streaming: false } : x)), { id: mid(), role: "assistant", text: `⚠ ${(err as Error).message}` }]);
    } finally {
      setPending(false);
      setBusy(false);
      void refreshSessions();
    }
  }, [tel, refreshSessions, streamTurn]);

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
      openPicker: () => pickerRef.current?.(),
    };
  }, [send, tel]);

  return (
    <div className="eeg-app flex" data-busy={busy ? "true" : "false"} data-layout={layout}>
      <Sidebar variant={phone ? "drawer" : "column"} open={sidebarOpen} sessions={sessions} info={info} onNew={() => { if (phone) setSidebarOpen(false); void startNew(); }} onClose={() => setSidebarOpen(false)} onInfo={setInfo} pickerRef={pickerRef} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar sidebarOpen={sidebarOpen && !phone} onOpenSidebar={() => { setSidebarOpen(true); if (phone) setHudOpen(false); }} hudOpen={hudOpen} onToggleHud={() => { setHudOpen((v) => !v); if (phone) setSidebarOpen(false); }}>
          <span className="font-title text-2xl tracking-tight md:text-3xl" title={title}>{title}</span>
        </TopBar>
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div ref={scroller} className="flex-1 overflow-y-auto overscroll-contain">
              <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 pb-40 pt-6 md:px-6 md:pt-8">
                {messages.map((m) => <Message key={m.id} msg={m} />)}
                {pending && <Thinking tick={tick} />}
              </div>
            </div>
            <div className="eeg-composer-dock pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent pt-10">
              <div className="pointer-events-auto mx-auto w-full max-w-[46rem] px-3 md:px-4">
                <Composer value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} telemetryRef={tel.attach} />
                <div className="mt-2 truncate text-center text-xs text-muted-foreground/60">typing telemetry is logged locally · {pickerLabel(info)}</div>
              </div>
            </div>
          </div>
          {hudOpen && !phone && <Hud variant="column" hud={hud} stateNote={stateNote} />}
        </div>
      </main>
      {phone && <Hud variant="sheet" open={hudOpen} onClose={() => setHudOpen(false)} hud={hud} stateNote={stateNote} />}
    </div>
  );
}
