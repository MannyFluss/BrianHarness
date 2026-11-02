import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
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
  const shownAt = useRef(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const tel = useTypingTelemetry();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const refreshSessions = useCallback(async () => setSessions(await bridge().sessions()), []);

  const startNew = useCallback(async () => {
    setBusy(true);
    setMessages([]);
    const r = await bridge().newSession();
    setMessages([{ id: mid(), role: "assistant", text: r.director.text }]);
    setTitle(r.title ?? "New chat");
    setHud(r.hud);
    setStateNote(r.director.stateNote);
    setBusy(false);
    void refreshSessions();
  }, [refreshSessions]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode double-mount guard: one session per launch
    booted.current = true;
    void bridge().info().then(setInfo);
    void startNew();
  }, [startNew]);

  // The moment the Director's message is on screen starts the reply-latency clock.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") shownAt.current = Date.now();
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 80);
    return () => clearInterval(t);
  }, [busy]);

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
    setMessages((m) => [...m, userMsg]);
    setDraft("");
    setBusy(true);
    try {
      const r = await bridge().reply({ text, events, sentAt, shownAt: shownAt.current });
      setMessages((m) => [...m.map((x) => (x.id === userMsg.id ? { ...x, engagement: r.engagement } : x)), { id: mid(), role: "assistant", text: r.director.text }]);
      setHud(r.hud);
      setStateNote(r.director.stateNote);
      if (r.title) setTitle(r.title);
    } catch (err) {
      setMessages((m) => [...m, { id: mid(), role: "assistant", text: `⚠ ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
      void refreshSessions();
    }
  }, [tel, refreshSessions]);

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
                {busy && <Thinking tick={tick} />}
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
