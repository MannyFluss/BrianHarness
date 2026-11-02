import { FakeEegSource, HarnessSession, MockBackend, SessionStore, type ModelBackend } from "@brianharness/core";
import type { Persona } from "./personas.js";
import { SimUser } from "./sim-user.js";

export interface RunOptions {
  turns?: number;
  seed?: number;
  backend?: ModelBackend;
  fakeEeg?: boolean;
  /** write JSONL logs + save files here (omit for in-memory) */
  dataDir?: string;
}

export interface RunResult {
  persona: string;
  passion: string;
  seed: number;
  turns: number;
  found: boolean;
  /** 1-based turn after which the hypothesis was the passion and never changed again */
  turnsToFind: number | null;
  firstHit: number | null;
  finalHypothesis: string | null;
  topTopics: Array<[string, number, number]>;
  favoriteStyle: string;
  topStyle: string | null;
  hypothesisByTurn: Array<string | null>;
  meanEngagementOnPassion: number | null;
  meanEngagementElsewhere: number | null;
  sessionId: string;
}

export async function runPersona(persona: Persona, opts: RunOptions = {}): Promise<RunResult> {
  const turns = opts.turns ?? 12;
  const seed = opts.seed ?? 1;
  let clock = Date.UTC(2026, 0, 1);
  let truth = 0.3;
  const sources = opts.fakeEeg ? [new FakeEegSource(() => truth, { seed: seed * 31 })] : [];
  const store = opts.dataDir ? new SessionStore(opts.dataDir) : null;
  const session = new HarnessSession({
    userId: `sim-${persona.id}-s${seed}`,
    backend: opts.backend ?? new MockBackend(seed),
    store,
    sources,
    clock: () => clock,
    seed,
    sessionId: store ? undefined : `sim-${persona.id}-${seed}`,
  });
  const user = new SimUser(persona, seed * 7919);
  let d = await session.start();
  const hyps: Array<string | null> = [];
  const onPassion: number[] = [];
  const elsewhere: number[] = [];
  for (let i = 0; i < turns; i++) {
    session.markShown(clock);
    const r = user.respond(d.text, clock);
    truth = r.truth;
    if (opts.fakeEeg) (sources[0] as FakeEegSource).generate({ from: clock, to: r.sentAt });
    clock = r.sentAt;
    const out = await session.reply(r.text, r.events, r.sentAt);
    (r.topic === persona.passion ? onPassion : elsewhere).push(out.user.frame.engagement);
    hyps.push(out.user.hypothesis);
    d = out.director;
    clock += 1500; // reading time
  }
  await session.end();
  let turnsToFind: number | null = null;
  for (let i = hyps.length - 1; i >= 0; i--) {
    if (hyps[i] === persona.passion) turnsToFind = i + 1;
    else break;
  }
  const firstIdx = hyps.indexOf(persona.passion);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const hud = session.hud();
  return {
    persona: persona.id,
    passion: persona.passion,
    seed,
    turns,
    found: hyps[hyps.length - 1] === persona.passion,
    turnsToFind,
    firstHit: firstIdx >= 0 ? firstIdx + 1 : null,
    finalHypothesis: hyps[hyps.length - 1] ?? null,
    topTopics: hud.topTopics,
    favoriteStyle: persona.favoriteStyle,
    topStyle: hud.topStyles[0]?.[0] ?? null,
    hypothesisByTurn: hyps,
    meanEngagementOnPassion: avg(onPassion),
    meanEngagementElsewhere: avg(elsewhere),
    sessionId: session.id,
  };
}

export interface Summary {
  persona: string;
  runs: number;
  foundRate: number;
  meanTurnsToFind: number | null;
  styleHitRate: number;
  /** final hypothesis is a wrong topic (the lock-in trap's end state) */
  wrongFinal: number;
  /** no hypothesis at all at the end (the low-confidence failure) */
  noHypothesis: number;
  /** runs with a wrong hypothesis held for >= 6 consecutive turns at any point */
  lockIns: number;
}

export function summarize(results: RunResult[]): Summary[] {
  const by = new Map<string, RunResult[]>();
  for (const r of results) by.set(r.persona, [...(by.get(r.persona) ?? []), r]);
  return [...by.entries()].map(([persona, rs]) => {
    const found = rs.filter((r) => r.found && r.turnsToFind !== null);
    return {
      persona,
      runs: rs.length,
      foundRate: found.length / rs.length,
      meanTurnsToFind: found.length ? found.reduce((a, r) => a + r.turnsToFind!, 0) / found.length : null,
      styleHitRate: rs.filter((r) => r.topStyle === r.favoriteStyle).length / rs.length,
      wrongFinal: rs.filter((r) => r.finalHypothesis !== null && r.finalHypothesis !== r.passion).length,
      noHypothesis: rs.filter((r) => r.finalHypothesis === null).length,
      lockIns: rs.filter((r) => longestWrongStreak(r) >= 6).length,
    };
  });
}

export function longestWrongStreak(r: RunResult): number {
  let best = 0, cur = 0;
  for (const h of r.hypothesisByTurn) {
    cur = h !== null && h !== r.passion ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}
