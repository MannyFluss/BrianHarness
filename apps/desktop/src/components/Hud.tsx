import { XIcon } from "lucide-react";
import type { Hud as HudState } from "../bridge";
import { cn } from "../lib";

function Bar({ value, label, sub }: { value: number; label: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs"><span className="text-foreground">{label}</span><span className="text-muted-foreground">{sub ?? value.toFixed(2)}</span></div>
      <div className="h-1.5 overflow-hidden rounded-sm bg-accent"><div className="h-full rounded-sm bg-signal transition-[width] duration-300" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} /></div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2"><span className="text-xs uppercase tracking-widest text-muted-foreground/70">{title}</span><span className="h-px flex-1 bg-border/60" /></div>
      {children}
    </section>
  );
}

// The Director HUD: a debug overlay like a game's dev console. Shows what the Director "sees".
// column: right-hand panel (iPad landscape / Mac). sheet: bottom sheet over the chat (iPhone).
export function Hud({ hud, stateNote, variant = "column", open = true, onClose }: { hud: HudState | null; stateNote: string; variant?: "column" | "sheet"; open?: boolean; onClose?: () => void }) {
  if (variant === "sheet") {
    return (
      <>
        <button aria-label="Close HUD" tabIndex={open ? 0 : -1} onClick={onClose} className={cn("fixed inset-0 z-40 bg-black/50 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")} />
        <aside role="dialog" aria-label="Director HUD" aria-hidden={!open} className={cn("fixed inset-x-0 bottom-0 z-50 flex max-h-[72dvh] flex-col rounded-t-2xl border-t bg-background shadow-2xl shadow-black/70 transition-transform duration-200", open ? "translate-y-0" : "pointer-events-none translate-y-full")}>
          <div className="flex shrink-0 items-center justify-between px-4 pt-2">
            <span className="mx-auto h-1 w-10 rounded-full bg-border" />
          </div>
          <div className="flex shrink-0 items-center justify-between px-4 pb-1">
            <span className="text-xs uppercase tracking-widest text-muted-foreground">Director HUD</span>
            <button onClick={onClose} aria-label="Close HUD" className="eeg-tap flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><XIcon className="size-4" /></button>
          </div>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><HudBody hud={hud} stateNote={stateNote} /></div>
        </aside>
      </>
    );
  }
  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l bg-background p-4 text-xs xl:w-80">
      <HudBody hud={hud} stateNote={stateNote} />
    </aside>
  );
}

function HudBody({ hud, stateNote }: { hud: HudState | null; stateNote: string }) {
  const f = hud?.frame?.features ?? {};
  const timed = f["typing.src.timedShare"];
  const sec = (k: string) => (f[k] !== undefined ? `${(f[k]! / 1000).toFixed(1)}s` : "–");
  const rel = f["typing.timingReliability"];
  const flags = [f["typing.dictated"] ? "dictated" : "", f["typing.pasted"] ? "pasted" : "", f["typing.autocorrections"] ? `autocorrect ×${f["typing.autocorrections"]}` : "", f["typing.predictive"] ? `predictive ×${f["typing.predictive"]}` : ""].filter(Boolean);
  return (
    <div className="flex flex-col gap-5 text-xs">
      <Section title="This turn">
        {hud?.frame ? (
          <>
            <Bar label="engagement" value={hud.frame.engagement} />
            <Bar label="baseline" value={hud.frame.baseline} />
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
              <span>latency</span><span className="text-right text-foreground">{((f["typing.replyLatencyMs"] ?? 0) / 1000).toFixed(1)}s</span>
              <span>words</span><span className="text-right text-foreground">{f["text.words"] ?? 0}</span>
              <span>deletions</span><span className="text-right text-foreground">{f["typing.deletions"] ?? 0}</span>
              <span>edits</span><span className="text-right text-foreground">{f["typing.edits"] ?? 0}</span>
              <span>long pauses</span><span className="text-right text-foreground">{f["typing.pauses"] ?? 0}</span>
              <span>chars/sec</span><span className="text-right text-foreground">{(f["typing.charsPerSec"] ?? 0).toFixed(1)}</span>
              <span title="Director message complete -> first key">to first key</span><span className="text-right text-foreground">{sec("typing.latencyToFirstKeyMs")}</span>
              <span title="Director message complete -> send">to submit</span><span className="text-right text-foreground">{sec("typing.latencyToSubmitMs")}</span>
              <span title="median inter-key gap (keyed inserts only)">key gap (median)</span><span className="text-right text-foreground">{f["typing.gapMedianMs"] !== undefined ? `${Math.round(f["typing.gapMedianMs"]!)}ms` : "–"}</span>
              {rel !== undefined && (<><span title="share of inserted characters that were keyed; fluency/hesitation are down-weighted by it">timing reliability</span><span className="text-right text-foreground">{Math.round(rel * 100)}%</span></>)}
              {flags.length > 0 && (<><span>flags</span><span className="text-right text-signal" data-typing-flags>{flags.join(" · ")}</span></>)}
              {timed !== undefined && (<><span>key-timed</span><span className="text-right text-foreground" title="share of inserted characters with per-key timing (autocorrect / predictive / dictation have none)">{Math.round(timed * 100)}%</span></>)}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">Waiting for your first reply.</span>
        )}
      </Section>
      {hud?.study ? (
        <Section title="Study">
          <div className="text-foreground" data-hud-study>Study session {hud.study.index}/{hud.study.total}</div>
          {hud.extractorWarning && <div className="text-amber-300/80" data-hud-extractor-warning>{hud.extractorWarning}</div>}
          <div className="text-muted-foreground">Blinded: what the Director has learned and plans is hidden until the study is unsealed.</div>
        </Section>
      ) : (<>
      <Section title="Interest map">
        {hud?.topTopics.length ? hud.topTopics.map(([t, m, n]) => <Bar key={t} label={t} value={m} sub={`${m.toFixed(2)} · n${n.toFixed(1)}`} />) : <span className="text-muted-foreground">Empty save file.</span>}
        <div className="text-muted-foreground">hypothesis: <span className="text-foreground">{hud?.hypothesis ?? "none yet"}</span></div>
      </Section>
      <Section title="Question styles">
        {hud?.topStyles.length ? hud.topStyles.map(([s, m]) => <Bar key={s} label={s} value={m} />) : <span className="text-muted-foreground">No data.</span>}
      </Section>
      <Section title="Director plan">
        {hud?.plan && <div className="text-foreground"><span className="uppercase">{hud.plan.mode}</span> {hud.plan.topic}{hud.plan.altTopic ? ` / ${hud.plan.altTopic}` : ""} · {hud.plan.style}</div>}
        <pre className="whitespace-pre-wrap rounded-md border border-border/60 bg-card p-2 font-ui text-[11px] leading-snug text-muted-foreground">{stateNote || "…"}</pre>
      </Section>
      </>)}
    </div>
  );
}
