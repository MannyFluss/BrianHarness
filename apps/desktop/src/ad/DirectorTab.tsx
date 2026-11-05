/**
 * E6: the Director tab (tab_visible sessions only). Replaces the HUD slot in this mode and reuses the Hud
 * variants' geometry: "column" = live side panel (iPad landscape / Mac, >= 768 px), "sheet" here = swipe-over panel
 * from the RIGHT edge (iPhone portrait). Three layers: top context, middle insights (share bar + note cards),
 * bottom live data (10 Hz). It never renders for a BlindedView (the type has no tab).
 */
import { useEffect, useMemo, useState } from "react";
import { XIcon, PauseIcon, PlayIcon, CameraIcon } from "lucide-react";
import { highlighted, type LiveGaze, type NoteCard as Card, type TabModel } from "@brianharness/core/actor-director/browser";
import { cn } from "../lib";
import type { PendingNote, VisibleView } from "./controller";

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2"><span className="text-xs uppercase tracking-widest text-muted-foreground/70">{title}</span><span className="h-px flex-1 bg-border/60" />{right}</div>
      {children}
    </section>
  );
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function TopLayer({ tab, now }: { tab: TabModel; now: number }) {
  const t = tab.top;
  if (!t) return <Section title="Context"><p className="text-muted-foreground">The Director hasn't read anything yet.</p></Section>;
  const fresh = highlighted(t.mono, now);
  return (
    <Section title="Context" right={<span className="text-[10px] text-muted-foreground">after a{t.turn - 1}</span>}>
      <p className={cn("leading-snug text-foreground", fresh && "ad-fresh")} data-ad-summary>{t.summary}</p>
      <div className="flex flex-col gap-1.5" data-ad-hypotheses>
        {t.hypotheses.map((h) => (
          <div key={h.label} className={cn("flex flex-col gap-0.5 rounded-sm", fresh && (h.isNew || t.changed.includes(h.label)) && "ad-fresh")}>
            <div className="flex items-baseline justify-between"><span>{h.label}</span><span className="text-muted-foreground">{pct(h.conf)} sure</span></div>
            <div className="h-1 overflow-hidden rounded-sm bg-accent"><div className="h-full bg-signal" style={{ width: pct(h.conf) }} /></div>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground">Intent: <span className="text-foreground">{t.intent}</span></p>
    </Section>
  );
}

const SEG = [
  { k: "system", label: "System", cls: "bg-[#5b6b8c]" },
  { k: "history", label: "History", cls: "bg-[#3c4a3f]" },
  { k: "user", label: "You", cls: "bg-[#8d8d8d]" },
  { k: "director", label: "Director", cls: "bg-signal" },
] as const;

export function ShareBar({ tab, onOpen, open }: { tab: TabModel; onOpen: () => void; open: boolean }) {
  const s = tab.share;
  if (!s) return null;
  const spark = tab.session.spark, max = Math.max(0.05, ...spark);
  return (
    <div className="flex flex-col gap-1.5" data-ad-share>
      <button onClick={onOpen} aria-expanded={open} className="flex h-3 w-full overflow-hidden rounded-sm bg-accent" aria-label={`Actor request breakdown: ${s.words}`}>
        {SEG.map((g) => <span key={g.k} className={g.cls} style={{ width: `${(s.parts[g.k] / s.total) * 100}%`, minWidth: g.k === "director" && s.parts.director ? 3 : 0 }} />)}
      </button>
      <div className="flex items-center justify-between"><span data-ad-share-words>{s.words}</span></div>
      <div className="flex items-end gap-2">
        <span className="flex-1 text-muted-foreground" data-ad-session-line>{tab.session.words}</span>
        <svg width="72" height="16" viewBox={`0 0 ${Math.max(1, spark.length - 1)} 1`} preserveAspectRatio="none" aria-hidden className="shrink-0">
          <polyline fill="none" stroke="var(--signal)" strokeWidth="0.08" vectorEffect="non-scaling-stroke" points={spark.map((v, i) => `${i},${1 - v / max}`).join(" ")} />
        </svg>
      </div>
      {open && (
        <div className="rounded-md border bg-card p-2" data-ad-breakdown>
          {SEG.map((g) => <div key={g.k} className="flex justify-between"><span className="flex items-center gap-1.5"><span className={cn("inline-block size-2 rounded-sm", g.cls)} />{g.label}</span><span>{s.parts[g.k].toLocaleString("en-US")} tok</span></div>)}
          <div className="mt-1 flex justify-between border-t pt-1"><span>Total</span><span>{s.total.toLocaleString("en-US")} tok</span></div>
          {s.noteId && <HintText text={tab.cards.find((c) => c.noteId === s.noteId)?.hint ?? null} />}
        </div>
      )}
    </div>
  );
}
function HintText({ text }: { text: string | null }) {
  if (!text) return null;
  return <pre className="mt-2 whitespace-pre-wrap rounded-sm bg-[color-mix(in_srgb,var(--signal)_14%,transparent)] p-1.5 text-[10.5px] leading-snug text-foreground" data-ad-hint>{text}</pre>;
}

const STATE_WORDS: Record<Card["state"], string> = {
  considering: "Considering", no_note: "No note", blocked: "Blocked", injected: "Injected", shadow: "Held back", dropped: "Dropped", error: "No answer",
};
const yn = (b: boolean | null) => (b === null ? "–" : b ? "yes" : "no");

export function NoteCardView({ card, selected, onSelect, pulse, now }: { card: Card; selected: boolean; onSelect: (c: Card) => void; pulse: boolean; now: number }) {
  return (
    <article data-ad-card={card.key} data-ad-state={card.state} onClick={() => onSelect(card)}
      className={cn("flex cursor-pointer flex-col gap-1 rounded-md border p-2", selected ? "border-signal" : "border-border/70", pulse && "ad-pulse", highlighted(card.mono, now) && "ad-fresh")}>
      <div className="flex items-center justify-between">
        <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wider", card.state === "injected" ? "bg-signal text-background" : card.state === "blocked" ? "bg-amber-600/80 text-background" : "bg-accent text-muted-foreground")}>{STATE_WORDS[card.state]}</span>
        <span className="text-[10px] text-muted-foreground">for a{card.turn} · read {card.readMsg}{card.noteId ? ` · ${card.noteId}` : ""}</span>
      </div>
      {card.state === "no_note" && <p className="text-muted-foreground">Director's reason: <span className="text-foreground">{card.reason}</span></p>}
      {card.state === "blocked" && <p className="text-amber-400">Safety rail: {card.railCodes.join(", ")} <span className="text-muted-foreground">(not the Director's judgment)</span></p>}
      {(card.state === "dropped" || card.state === "error" || card.state === "shadow") && <p className="text-muted-foreground">{card.reason}</p>}
      {card.observation && <p>Observed: {card.observation}</p>}
      {card.suggestion && <p>Suggests{card.move ? ` (${card.move.replace("_", " ")})` : ""}: {card.suggestion}</p>}
      {card.evidence.length > 0 && <p className="text-muted-foreground">Evidence: {card.evidence.map((e) => <span key={e} className="mr-1 rounded-sm bg-accent px-1 text-foreground" data-ad-evidence={e}>{e}</span>)}</p>}
      {selected && (
        <>
          {card.rationale && <p className="text-muted-foreground">Why: {card.rationale}</p>}
          {card.confidence !== null && <p className="text-muted-foreground">Confidence {pct(card.confidence)}{card.kind ? ` · ${card.kind}` : ""}{card.repaired ? " · repaired once" : ""}</p>}
          <HintText text={card.hint} />
        </>
      )}
      {card.outcome && (
        <p className="text-muted-foreground" data-ad-outcome>
          Followed? <span className="text-foreground">{yn(card.outcome.followed)}</span> · answered first? <span className="text-foreground">{yn(card.outcome.answeredFirst)}</span> · leaks: <span className={card.outcome.leaks.length ? "text-amber-400" : "text-foreground"}>{card.outcome.leaks.length ? card.outcome.leaks.join(", ") : "none"}</span>
          {card.outcome.nextDwellRatio !== null && <> · next reply read at {card.outcome.nextDwellRatio.toFixed(1)}× usual</>}
        </p>
      )}
    </article>
  );
}

export function PendingCardView({ p }: { p: PendingNote }) {
  const n = p.output?.note;
  return (
    <article data-ad-card="pending" data-ad-state={p.state} className={cn("flex flex-col gap-1 rounded-md border border-dashed p-2", p.state === "waiting" && "ad-pulse border-signal")}>
      <div className="flex items-center justify-between">
        <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider">{p.state === "thinking" ? "Considering…" : p.state === "waiting" ? "Waiting for Send" : p.state === "blocked" ? "Blocked" : "No note"}</span>
        <span className="text-[10px] text-muted-foreground">for a{p.turn}</span>
      </div>
      {p.state === "no_note" && <p className="text-muted-foreground">Director's reason: <span className="text-foreground">{p.output?.no_note_reason}</span></p>}
      {p.state === "blocked" && <p className="text-amber-400">Safety rail: {p.railCodes.join(", ")}</p>}
      {n?.suggestion && <p>Suggests: {n.suggestion.text}</p>}
      {p.state === "waiting" && <p className="text-muted-foreground">Goes to the Actor with your next message (unless it's held back as a control).</p>}
    </article>
  );
}

/** bottom layer: renders at 10 Hz from store.live() */
export function LiveLayer({ tab, pullLive, camera, onPause, calibration, occluded = false }: { tab: TabModel; pullLive: () => LiveGaze | null; camera: VisibleView["camera"]; onPause?: () => void; calibration: VisibleView["calibration"]; occluded?: boolean }) {
  const [live, setLive] = useState<LiveGaze | null>(() => pullLive());
  useEffect(() => { const id = setInterval(() => setLive(pullLive()), 100); return () => clearInterval(id); }, [pullLive]);
  const b = tab.bottom;
  return (
    <Section title="Live" right={
      <button onClick={onPause} className="eeg-tap flex items-center gap-1 rounded-sm px-1 text-[10px] text-muted-foreground hover:bg-accent" data-ad-camera={camera.on ? "on" : "off"} aria-label={camera.on ? "Pause tracking" : "Resume tracking"}>
        <CameraIcon className={cn("size-3", camera.on ? "text-signal" : "text-muted-foreground")} />{camera.on ? "camera on" : camera.paused ? "paused" : "off"}{camera.on ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
      </button>}>
      <p className="text-muted-foreground" data-ad-calibration>{calibration.words}{calibration.stale ? ` · ${calibration.stale}` : ""}</p>
      <div className="flex flex-col gap-1" data-ad-minimap>
        {b.paras.map((p) => (
          <div key={p.aoi} className={cn("flex items-center gap-2 rounded-sm border px-1.5 py-1", live?.target === p.aoi ? "border-signal" : "border-transparent")} style={{ background: `color-mix(in srgb, var(--signal) ${Math.round(p.shade * 38)}%, transparent)` }}>
            <span className="w-12 shrink-0 text-muted-foreground">{p.aoi}</span><span className="flex-1 truncate">{p.words}</span>
          </div>
        ))}
        {!b.paras.length && <p className="text-muted-foreground">No reading data yet.</p>}
      </div>
      <div className="flex justify-between text-muted-foreground" data-ad-live>
        <span>Looking at: <span className="text-foreground">{occluded ? "chat covered by this tab (not counted)" : live?.target ?? (live?.point ? "outside the chat" : "–")}</span></span>
        <span>Tracking {live ? `${pct(live.quality)}${live.faceFrac < 0.7 ? " · face lost" : ""}` : "–"}</span>
      </div>
      {b.ticker.length > 0 && <ul className="flex flex-col gap-0.5" data-ad-ticker>{b.ticker.map((e) => <li key={e.id}><span className="text-muted-foreground">{e.id}</span> {e.words}</li>)}</ul>}
    </Section>
  );
}

export interface TabProps {
  view: VisibleView;
  pullLive: () => LiveGaze | null;
  variant: "column" | "sheet";
  open: boolean;
  onClose?: () => void;
  selected: string | null;
  onSelect: (c: Card | null) => void;
  onPause?: () => void;
  now: number;
}
export function DirectorTab({ view, pullLive, variant, open, onClose, selected, onSelect, onPause, now }: TabProps) {
  const [breakdown, setBreakdown] = useState(false);
  const tab = view.tab;
  const body = useMemo(() => (
    <div className="flex flex-col gap-5 text-xs">
      <TopLayer tab={tab} now={now} />
      <Section title="Insights">
        <ShareBar tab={tab} open={breakdown} onOpen={() => setBreakdown((b) => !b)} />
        <div className="flex flex-col gap-2" data-ad-cards>
          {view.pending && <PendingCardView p={view.pending} />}
          {tab.cards.map((c) => <NoteCardView key={c.key} card={c} selected={selected === c.key} onSelect={(x) => onSelect(selected === x.key ? null : x)} pulse={false} now={now} />)}
        </div>
      </Section>
      <LiveLayer tab={tab} pullLive={pullLive} camera={view.camera} onPause={onPause} calibration={view.calibration} occluded={!!view.occluded} />
    </div>
  ), [tab, view.pending, view.camera, view.calibration, breakdown, selected, now, pullLive, onPause, onSelect]);
  if (variant === "sheet") {
    return (
      <>
        <button aria-label="Close Director tab" tabIndex={open ? 0 : -1} onClick={onClose} className={cn("fixed inset-0 z-40 bg-black/50 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")} />
        <aside role="dialog" aria-label="Director tab" aria-hidden={!open} data-ad-tab="sheet" data-ad-tab-open={open ? "true" : "false"}
          className={cn("ad-swipe fixed inset-y-0 right-0 z-50 flex w-[88vw] max-w-[380px] flex-col border-l bg-background shadow-2xl shadow-black/70 transition-transform duration-200", open ? "translate-x-0" : "pointer-events-none translate-x-full")}>
          <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className="text-xs uppercase tracking-widest text-muted-foreground">Director</span>
            <button onClick={onClose} aria-label="Close Director tab" className="eeg-tap flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
          </div>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{body}</div>
        </aside>
      </>
    );
  }
  if (!open) return null;
  return <aside data-ad-tab="column" data-ad-tab-open="true" className="w-96 shrink-0 overflow-y-auto border-l bg-background p-4">{body}</aside>;
}
