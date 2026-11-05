/**
 * E6: the actor-director chat shell. Protocol-4's App is untouched; this is a separate entry (web/ad.html).
 * tab_visible: Director tab (column >= 768 px, swipe-over from the right on phones), margin marks on replies that
 * used a note, evidence paragraph highlights, the injection animation, the "note waiting" chip.
 * blinded: chat + composer + the camera indicator only. No tab DOM, no marks, no chips, no tab-only field.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PanelRightIcon, CameraIcon, CameraOffIcon } from "lucide-react";
import { collectParaBoxes, evidenceParagraphs, type NoteCard } from "@brianharness/core/actor-director/browser";
import { Message } from "../components/Message";
import { Composer } from "../components/Composer";
import { cn } from "../lib";
import { DirectorTab } from "./DirectorTab";
import { InjectionLine, usePrefersReducedMotion } from "./InjectionLine";
import type { AdStore, AdView, VisibleView } from "./controller";

export type AdLayout = "phone" | "tablet";
function useAdLayout(forced?: AdLayout): AdLayout {
  const read = (): AdLayout => (typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches ? "phone" : "tablet");
  const [m, setM] = useState<AdLayout>(() => forced ?? read());
  useEffect(() => {
    if (forced) { setM(forced); return; }
    const q = matchMedia("(max-width: 767px)"); const on = () => setM(read());
    q.addEventListener("change", on); return () => q.removeEventListener("change", on);
  }, [forced]);
  return m;
}

export interface AdAppProps {
  store: AdStore;
  layout?: AdLayout;
  /** initial tab state (tab_visible only) */
  tabOpen?: boolean;
  reduceMotion?: boolean;
  /** screenshots: freeze the injection line on this card */
  holdInjection?: string | null;
  selectedCard?: string | null;
  /** monotonic clock for 5 s highlights (demo: the snapshot's mono) */
  now?: () => number;
  onCalibrate?: () => void;
}

export function AdApp(props: AdAppProps) {
  const view = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const layout = useAdLayout(props.layout);
  const [draft, setDraft] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);
  const store = props.store;
  const [open, setOpen] = useState(props.tabOpen ?? layout !== "phone");

  // composer: tap positions -> drift anchors, key TIMES only (never the key) -> local reading-window close
  const onPointer = useCallback((e: React.PointerEvent) => store.composerTap?.(e.clientX, e.clientY, e.timeStamp), [store]);
  const onKey = useCallback((e: React.KeyboardEvent) => store.composerKey?.(e.timeStamp), [store]);
  const send = useCallback(() => { const t = draft; setDraft(""); void store.send?.(t); }, [draft, store]);

  // tagged paragraph boxes, 4 Hz (the tab is outside the chat root, so it's never an AOI)
  useEffect(() => {
    if (!store.paragraphs || typeof window === "undefined") return;
    const id = setInterval(() => {
      const root = chatRef.current; if (!root) return;
      const sheet = document.querySelector('[data-ad-tab="sheet"][data-ad-tab-open="true"]')?.getBoundingClientRect();
      const all = collectParaBoxes(root);
      const boxes = all.filter((b) => !sheet || b.x + b.w <= sheet.left);
      const t = performance.now();
      // phone: the sheet covers the chat -> no paragraph is attributable; the controller logs tab_occluded (I4)
      store.occlusion?.(!!sheet && all.length > 0 && boxes.length === 0, t);
      store.paragraphs!(boxes, t, view.chat.some((m) => m.streaming));
    }, 250);
    return () => clearInterval(id);
  }, [store, view.chat]);

  useEffect(() => { chatRef.current?.scrollTo?.({ top: chatRef.current.scrollHeight }); }, [view.chat.length]);

  return (
    <div className="eeg-app flex h-dvh flex-col bg-background text-foreground" data-ad-app={view.sessionType === "tab_visible" ? "visible" : "plain"}>
      <TopBar view={view} layout={layout} tabOpen={open} {...(view.sessionType === "tab_visible" ? { onTab: () => setOpen((o) => !o) } : {})} onCalibrate={props.onCalibrate} onPause={() => void (view.camera.on ? store.pauseTracking?.() : store.resumeTracking?.())} />
      {view.sessionType === "tab_visible"
        ? <VisibleBody {...props} open={open} setOpen={setOpen} view={view} layout={layout} chatRef={chatRef} draft={draft} setDraft={setDraft} send={send} onPointer={onPointer} onKey={onKey} />
        : (
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col">
              <Chat view={view} chatRef={chatRef} />
              <div className="mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onPointerDownCapture={onPointer} onKeyDownCapture={onKey} data-ad-composer>
                <Composer value={draft} onChange={setDraft} onSend={send} busy={view.busy} />
              </div>
            </main>
          </div>
        )}
    </div>
  );
}

function TopBar({ view, layout, onCalibrate, onPause, onTab, tabOpen }: { view: AdView; layout: AdLayout; onCalibrate?: () => void; onPause: () => void; onTab?: () => void; tabOpen?: boolean }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)] font-ui text-xs">
      <span className="font-title text-base">BrianHarness</span>
      <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground" data-ad-badge>{view.sessionType === "tab_visible" ? "Director tab" : "Study session"}</span>
      <span className="flex-1" />
      {onCalibrate && <button className="eeg-tap rounded-sm px-2 py-1 text-muted-foreground hover:bg-accent" onClick={onCalibrate}>{layout === "phone" ? "Calib." : "Calibrate"}</button>}
      <button onClick={onPause} className={cn("eeg-tap flex items-center gap-1 rounded-sm px-2 py-1", view.camera.on ? "text-signal" : "text-muted-foreground")} data-ad-camera-indicator={view.camera.on ? "on" : "off"} aria-label={view.camera.on ? "Camera on: tap to pause" : "Camera paused: tap to resume"}>
        {view.camera.on ? <CameraIcon className="size-4" /> : <CameraOffIcon className="size-4" />}{layout !== "phone" && (view.camera.on ? "Camera on" : "Paused")}
      </button>
      {onTab && <button onClick={onTab} aria-pressed={tabOpen} aria-label={tabOpen ? "Hide Director tab" : "Show Director tab"} className={cn("eeg-tap flex size-8 items-center justify-center rounded-md hover:bg-accent", tabOpen ? "text-foreground" : "text-muted-foreground")} data-ad-tab-toggle><PanelRightIcon className="size-4" /></button>}
    </header>
  );
}

function Chat({ view, chatRef, marks, onMark, highlight }: { view: AdView; chatRef: React.RefObject<HTMLDivElement | null>; marks?: Record<string, string>; onMark?: (msg: string) => void; highlight?: string[] }) {
  // evidence ids are a<k>.p<n> (1-based); the DOM tags data-p 0-based
  const css = highlight?.length ? highlight.map((a) => { const [m, p] = a.split(".p"); return `[data-msg="${m}"][data-p="${Number(p) - 1}"]`; }).join(",") + "{background:color-mix(in srgb,var(--signal) 22%,transparent);border-radius:3px;box-shadow:0 0 0 2px color-mix(in srgb,var(--signal) 22%,transparent)}" : "";
  return (
    <div ref={chatRef} className="min-h-0 flex-1 overflow-y-auto" data-ad-chat>
      {css && <style data-ad-highlight>{css}</style>}
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6 pl-8">
        {view.chat.map((m) => (
          <div key={m.id} className="relative">
            {marks?.[m.id] && <button className="ad-mark" aria-label={`Used Director note ${marks[m.id]}`} data-ad-mark={marks[m.id]} onClick={() => onMark?.(m.id)} />}
            <Message msg={m} aoi={m.role === "assistant" ? { msg: m.id } : undefined} />
          </div>
        ))}
        {view.busy && <div className="text-xs text-muted-foreground">…</div>}
      </div>
    </div>
  );
}

function VisibleBody(p: AdAppProps & { open: boolean; setOpen: (f: (o: boolean) => boolean) => void; view: VisibleView; layout: AdLayout; chatRef: React.RefObject<HTMLDivElement | null>; draft: string; setDraft: (v: string) => void; send: () => void; onPointer: (e: React.PointerEvent) => void; onKey: (e: React.KeyboardEvent) => void }) {
  const { view, layout } = p;
  const open = p.open, setOpen = (v: boolean) => p.setOpen(() => v);
  const [sel, setSel] = useState<string | null>(p.selectedCard ?? null);
  const reduce = usePrefersReducedMotion(p.reduceMotion);
  const now = (p.now ?? (() => (typeof performance !== "undefined" ? performance.now() : 0)))();
  const pullLive = useCallback(() => p.store.live(), [p.store]);
  // injection: a pending "waiting" note became an injected card -> run the line once
  const [flash, setFlash] = useState<string | null>(p.holdInjection ?? null);
  const lastWaiting = useRef<number | null>(null);
  useEffect(() => {
    if (view.pending?.state === "waiting") { lastWaiting.current = view.pending.turn; return; }
    if (lastWaiting.current !== null) {
      const c = view.tab.cards.find((x) => x.turn === lastWaiting.current && x.state === "injected");
      lastWaiting.current = null;
      if (c) { setFlash(c.key); const id = setTimeout(() => setFlash(null), 1400); return () => clearTimeout(id); }
    }
  }, [view.pending, view.tab.cards]);
  const card: NoteCard | undefined = view.tab.cards.find((c) => c.key === sel);
  const highlight = card ? evidenceParagraphs(card.evidence, view.events) : [];
  const onMark = (msg: string) => { const id = view.tab.marks[msg]; const c = view.tab.cards.find((x) => x.noteId === id); if (c) { setSel(c.key); setOpen(true); } };
  const tabProps = { view, pullLive, open, onClose: () => setOpen(false), selected: sel, onSelect: (c: NoteCard | null) => setSel(c?.key ?? null), onPause: () => void (view.camera.on ? p.store.pauseTracking?.() : p.store.resumeTracking?.()), now };
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <Chat view={view} chatRef={p.chatRef} marks={view.tab.marks} onMark={onMark} highlight={highlight} />
          <div className="mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {view.pending?.state === "waiting" && (
              <button className="mb-2 flex items-center gap-1.5 rounded-sm px-1 text-xs text-signal" data-ad-waiting onClick={() => setOpen(true)}>
                <span className="ad-pulse inline-block size-2 rounded-full bg-signal" />Director note waiting · goes with Send
              </button>
            )}
            <div className={cn(flash && "ad-composer-pulse")} onPointerDownCapture={p.onPointer} onKeyDownCapture={p.onKey} data-ad-composer>
              <Composer value={p.draft} onChange={p.setDraft} onSend={p.send} busy={view.busy} />
            </div>
          </div>
        </main>
        {layout !== "phone" && <DirectorTab {...tabProps} variant="column" />}
      </div>
      {layout === "phone" && <DirectorTab {...tabProps} variant="sheet" />}
      <InjectionLine from={flash} active={!!flash} reduceMotion={reduce} hold={!!p.holdInjection} />
    </>
  );
}

