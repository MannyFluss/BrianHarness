#!/usr/bin/env node
/**
 * Phase D exporter: per-turn typing features joined with absorption ratings, one CSV row per
 * user_turn. Reads session JSONL (files or directories, e.g. an "Export logs" bundle unzipped).
 *
 * BLINDING: there is NO mode column. Sessions carry only the study index + schedule hash. The
 * mode is joined only when an UNSEALED schedule file is passed explicitly (after session 10):
 *   brianharness-export-ratings logs/ --schedule unsealed.json -o ratings.csv
 * The unsealed schedule's hash must match the sessions' scheduleHash (else it refuses).
 *
 * Message text is never exported (features only); "hooked" free text is, being an answer the
 * user gave to the rating card itself. Use --no-hooked to drop it.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

type Ev = Record<string, unknown> & { type?: string };
export interface SessionLog { file: string; events: Ev[] }
export interface UnsealedSchedule { order: string[]; scheduleHash?: string }

const META = ["sessionId", "studyIndex", "scheduleHash", "turn", "userTurn", "t", "engagement", "baseline", "text.words", "text.chars"] as const;
const RATING = ["turn_rating", "turn_rating_dismissed", "turn_rating_reason", "turn_rating_shownAt", "turn_rating_answeredAt", "session_rating", "session_rating_dismissed", "session_hooked", "session_blindGuess"] as const;
/** study_protocol: STUDY_PROTOCOL_VERSION (session_start.study.protocol, also in final); empty = practice build (1438) -> exclude.
 * reissue_of: the invalid previous session this one re-runs (same index), or "manual" (Settings > Redo);
 * reissue_reason: the optional free-text reason of a manual redo. */
/** interest labels: running top-1 after this turn (interest_update.top1) + the session's {type:'final'} record */
const LABELS = ["top1_running", "final_top1", "final_top3", "extractor_prompt_version", "extractor_model", "effective_tagger", "extractor_fallback", "extractor_fallback_reason", "extractor_calls_attempted", "extractor_calls_ok", "extractor_calls_failed", "extractor_calls_capped", "study_protocol", "reissue_of", "reissue_reason"] as const;

export function readSessionLogs(paths: string[]): SessionLog[] {
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else if (p.endsWith(".jsonl")) files.push(p);
  };
  for (const p of paths) walk(p);
  return files.map((file) => ({ file, events: readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } }) }));
}

const csvCell = (v: unknown) => {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function ratingsCsv(logs: SessionLog[], opts: { schedule?: UnsealedSchedule; hooked?: boolean } = {}): string {
  const rows: Array<Record<string, unknown>> = [];
  const featureKeys = new Set<string>();
  const hashes = new Set<string>();
  for (const { events } of logs) {
    const start = events.find((e) => e.type === "session_start") as (Ev & { sessionId?: string; study?: { index?: number; scheduleHash?: string; protocol?: number }; reissueOf?: string; reissueReason?: string }) | undefined;
    if (!start) continue;
    const study = start.study;
    if (study?.scheduleHash) hashes.add(study.scheduleHash);
    const ratings = events.filter((e) => e.type === "rating");
    const lastOf = <T extends Ev>(xs: T[]) => xs[xs.length - 1];
    const sess = lastOf(ratings.filter((r) => r.scope === "session"));
    const fin = lastOf(events.filter((e) => e.type === "final")) as (Ev & { top1?: string | null; top3?: string[]; extractorPromptVersion?: string; model?: string; effectiveTagger?: string; fallback?: boolean; fallbackReason?: string; extractorCalls?: { attempted: number; ok: number; failed: number; capped: number } }) | undefined;
    const top1At = new Map<number, unknown>();
    for (const iu of events.filter((e) => e.type === "interest_update")) if ("top1" in iu) top1At.set(iu.turn as number, iu.top1);
    for (const u of events.filter((e) => e.type === "user_turn")) {
      const features = (u.features ?? {}) as Record<string, number>;
      for (const k of Object.keys(features)) if (k.startsWith("typing.") || k.startsWith("text.") || k.startsWith("extractor.")) featureKeys.add(k);
      // rating.turn is the 1-based user reply number (= hud.turn after that reply) = user_turn.turn + 1
      const userTurn = (u.turn as number) + 1;
      const tr = lastOf(ratings.filter((r) => r.scope === "turn" && r.turn === userTurn));
      rows.push({
        sessionId: start.sessionId,
        studyIndex: study?.index,
        scheduleHash: study?.scheduleHash,
        turn: u.turn,
        userTurn,
        t: u.t,
        engagement: u.engagement,
        baseline: u.baseline,
        ...features,
        turn_rating: tr?.value,
        turn_rating_dismissed: tr ? tr.dismissed : undefined,
        turn_rating_reason: tr?.reason,
        turn_rating_shownAt: tr?.shownAt,
        turn_rating_answeredAt: tr?.answeredAt,
        session_rating: sess?.value,
        session_rating_dismissed: sess ? sess.dismissed : undefined,
        session_hooked: opts.hooked === false ? undefined : sess?.hooked,
        session_blindGuess: sess?.blindGuess,
        top1_running: top1At.get(u.turn as number),
        final_top1: fin?.top1 ?? undefined,
        final_top3: fin?.top3?.join(" | "),
        extractor_prompt_version: fin?.extractorPromptVersion,
        extractor_model: fin?.model,
        effective_tagger: fin?.effectiveTagger,
        extractor_fallback: fin?.fallback,
        extractor_fallback_reason: fin?.fallbackReason,
        extractor_calls_attempted: fin?.extractorCalls?.attempted,
        extractor_calls_ok: fin?.extractorCalls?.ok,
        extractor_calls_failed: fin?.extractorCalls?.failed,
        extractor_calls_capped: fin?.extractorCalls?.capped,
        study_protocol: study?.protocol ?? (fin as { protocol?: number } | undefined)?.protocol,
        reissue_of: start.reissueOf,
        reissue_reason: start.reissueReason,
      });
    }
  }
  const cols: string[] = [...META, ...[...featureKeys].filter((k) => !(META as readonly string[]).includes(k)).sort(), ...RATING, ...LABELS];
  if (opts.schedule) {
    const sh = opts.schedule;
    if (!Array.isArray(sh.order)) throw new Error("--schedule: not an unsealed schedule (no order[])");
    if (sh.scheduleHash && hashes.size && ![...hashes].every((h) => h === sh.scheduleHash)) throw new Error(`--schedule: hash ${sh.scheduleHash.slice(0, 12)}… does not match the sessions' scheduleHash (${[...hashes].map((h) => h.slice(0, 12)).join(", ")}…)`);
    cols.push("mode");
    for (const r of rows) if (typeof r.studyIndex === "number") r.mode = sh.order[r.studyIndex - 1];
  }
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

/**
 * --schedule file: either the raw schedule export (exact Keychain string; its sha256 IS the scheduleHash) or an
 * unseal() result JSON carrying scheduleHash (+ raw, which is then re-hashed and must agree).
 */
export function readScheduleFile(path: string): UnsealedSchedule {
  const text = readFileSync(path, "utf8");
  const o = JSON.parse(text) as UnsealedSchedule & { raw?: string };
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  if (typeof o.raw === "string" && o.scheduleHash && sha(o.raw) !== o.scheduleHash) throw new Error("--schedule: sha256(raw) does not match scheduleHash");
  return o.scheduleHash ? o : { ...o, scheduleHash: sha(text) };
}

function main(argv: string[]) {
  const inputs: string[] = [];
  let out: string | undefined, schedule: string | undefined, hooked = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-o" || a === "--out") out = argv[++i];
    else if (a === "--schedule") schedule = argv[++i];
    else if (a === "--no-hooked") hooked = false;
    else if (a === "-h" || a === "--help") return void console.log("usage: brianharness-export-ratings <session.jsonl|dir>... [-o out.csv] [--schedule unsealed.json] [--no-hooked]");
    else inputs.push(a);
  }
  if (!inputs.length) throw new Error("give session JSONL files or directories");
  for (const p of inputs) if (!existsSync(p)) throw new Error(`not found: ${p}`);
  const csv = ratingsCsv(readSessionLogs(inputs), { hooked, ...(schedule ? { schedule: readScheduleFile(schedule) } : {}) });
  if (out) writeFileSync(out, csv);
  else process.stdout.write(csv);
}

if (process.argv[1] && /export-ratings\.(ts|js)$/.test(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`export-ratings: ${(err as Error).message}`);
    process.exit(1);
  }
}
