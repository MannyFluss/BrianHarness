import type { Hud as HudState } from "../bridge";

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
export function Hud({ hud, stateNote }: { hud: HudState | null; stateNote: string }) {
  const f = hud?.frame?.features ?? {};
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l bg-background p-4 text-xs">
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
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">Waiting for your first reply.</span>
        )}
      </Section>
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
    </aside>
  );
}
