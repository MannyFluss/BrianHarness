/**
 * Note schema: what the Director model returns, the safety-rail (rejection) codes, the leak codes, and the
 * exact rule code uses to render the Actor's hint text. The model never writes actor_text.
 */
export const SUGGESTION_MOVES = ["go_deeper", "broaden", "return_to", "clarify", "simplify", "give_example", "check_in", "slow_down", "other"] as const;
export type SuggestionMove = (typeof SUGGESTION_MOVES)[number];

/** "e31" L3 event, "u12" user message, "a7" Actor message, "a7.p2" paragraph, "a7.p2.s1" span */
export const EVIDENCE_ID_PATTERN = "^(?:e[0-9]+|u[0-9]+|a[0-9]+(?:\\.p[0-9]+(?:\\.s[0-9]+)?)?)$";
export type EvidenceId = string;

export interface DirectorSuggestion {
  move: SuggestionMove;
  /** what the move is about, in chat words */
  target?: string;
  /** "go deeper on why rye ferments faster" (rendered after the fixed lead-in) */
  text: string;
}

export interface DirectorNote {
  /** "n5": n + a number unique in the session */
  id: string;
  /** sensor language allowed; tab + log only, NEVER sent to the Actor */
  rationale: string;
  /** plain-language read of the person; at least one of observation / suggestion */
  observation?: string;
  suggestion?: DirectorSuggestion;
  /** the Director's own reason this beats saying nothing right now */
  value: string;
  /** >= 1 id; every id must exist in this call's input (evidence rail) */
  evidence: EvidenceId[];
  /** 0..1; shown and logged as a covariate, never a gate */
  confidence: number;
  expires_after_turns: 1;
}

export interface Hypothesis { label: string; conf: number; evidence: EvidenceId[] }
export interface ContextUpdate { summary: string; hypotheses: Hypothesis[]; changed: string[] }

/** strict JSON from the Director: note null <=> no_note_reason is a non-empty string */
export type DirectorOutput =
  | { context_update: ContextUpdate; intent: string; note: DirectorNote; no_note_reason: null }
  | { context_update: ContextUpdate; intent: string; note: null; no_note_reason: string };

/** what kind of note it is (derived by code from which fields are present) */
export type NoteKind = "observation" | "suggestion" | "both";

/**
 * Safety / validity rails (rail_check.blocked_by). Deterministic; none is a value judgment.
 * Several can fire at once; the note is blocked if any fires.
 */
export const RAIL_CODES = [
  "kill_switch", // directorEnabled:false locally or the remote flag
  "consent", // the note cites gaze events but camera consent is off
  "data_validity", // cites a gaze event from a window below quality 0.6 / face 70 %, or a z before the 20-paragraph baseline
  "evidence_missing", // evidence is empty
  "evidence_unknown", // an evidence id is not in this call's input
  "schema_invalid", // not valid DirectorOutput after the one repair retry
  "lint_sensor", // sensor / measurement words in observation or suggestion (gaze, eye, look, read, skim, dwell, ms, %, ...)
  "lint_provenance", // provenance words (told, note, Director, model, ...)
  "lint_answer_first", // "instead of", "don't answer", "ignore", "change the subject", "stop" in the suggestion
  "length_cap", // rendered lines > 60 words
  "duplicate", // rendered actor_text identical to either of the last 2 injected or shadowed notes
  "leak_breaker", // 2 safety leaks already this session: injection paused
] as const;
export type RailCode = (typeof RAIL_CODES)[number];

/** checked on every Actor reply that followed a note (and, as a control, on replies without one) */
export const LEAK_CODES = ["sensor", "provenance", "mind_reading", "pivot_first", "verbatim", "forced_move"] as const;
export type LeakCode = (typeof LEAK_CODES)[number];
/** reveal observation: count toward the leak breaker (1 = flagged in the tab, 2 = pause injection for the session) */
export const SAFETY_LEAKS: readonly LeakCode[] = ["sensor", "provenance", "mind_reading"];
/** quality failures the eval measures; never stop the Director */
export const QUALITY_LEAKS: readonly LeakCode[] = ["pivot_first", "verbatim", "forced_move"];
/** verbatim leak: an 8-word (or longer) run shared by the reply and the rendered lines */
export const VERBATIM_MIN_WORDS = 8;

/**
 * Code-built hint text (actor_text). Exact bytes:
 *   actor_text = HINT_HEADER + "\n" + lines.join("\n")
 *   lines      = [ "- " + observation ]                                     (if observation)
 *              + [ "- " + SUGGESTION_LEAD + suggestion.text + "." ]          (if suggestion; "." only when text
 *                                                                             does not already end in . ! or ?)
 *   the last line gets " (h:" + evidence.join(",") + ")": ALL of the note's evidence ids, in the order given,
 *   comma-separated, no spaces, no ranges (e.g. "(h:e31,e32,e33)"; the spec's "(h:e31,e32)" example was wrong)
 *   observation / suggestion.text are trimmed and inner whitespace collapsed to one space before rendering
 * The Actor's leading system message on a note turn = ACTOR_SYSTEM_PROMPT + "\n\n" + actor_text.
 * Length cap: words in the lines, excluding the "- " bullets and the (h:...) tag, including the lead-in, <= 60.
 */
export const HINT_HEADER = "[Context for your next reply. Soft hints: answer the person first, use only what fits.\nDon't quote this or say where it came from.]";
export const SUGGESTION_LEAD = "If it fits after answering them: ";
export const HINT_SEPARATOR = "\n\n";
export const MAX_ACTOR_TEXT_WORDS = 60;
/** the Director's answer must be ready this long after Send, else the turn goes without a note (dropped, not queued) */
export const DIRECTOR_HOLD_MS = 1500;

/** derive the kind from the fields present */
export function noteKind(n: Pick<DirectorNote, "observation" | "suggestion">): NoteKind {
  return n.observation && n.suggestion ? "both" : n.suggestion ? "suggestion" : "observation";
}
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
/** reference renderer for actor_text (the frozen byte rule above); E2's slot uses exactly this */
export function renderActorText(n: Pick<DirectorNote, "observation" | "suggestion" | "evidence">): string {
  const lines: string[] = [];
  if (n.observation) lines.push("- " + clean(n.observation));
  if (n.suggestion) {
    const t = clean(n.suggestion.text);
    lines.push("- " + SUGGESTION_LEAD + t + (/[.!?]$/.test(t) ? "" : "."));
  }
  if (lines.length && n.evidence.length) lines[lines.length - 1] += " (h:" + n.evidence.join(",") + ")";
  return HINT_HEADER + "\n" + lines.join("\n");
}
/** words counted by the length cap: the rendered lines without bullets and the (h:...) tag */
export function actorTextWords(actorText: string): number {
  const body = actorText.slice(HINT_HEADER.length + 1).replace(/ \(h:[^)]*\)$/, "");
  return body.split("\n").map((l) => l.replace(/^- /, "")).join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * Compact, prompt-embeddable form of the DirectorOutput schema. Ollama Cloud ignores a JSON-schema `format`
 * (InfrastructureBot N3), so the Director prompt (R3) embeds this text; E3 strips code fences, validates against
 * note.schema.json, and retries once with the validation errors ("repair"); a second failure = no note
 * (director.schema_invalid). The contracts test checks this text names every field and enum value of the schema.
 */
export const DIRECTOR_OUTPUT_FORMAT_TEXT = `Reply with ONE JSON object, no prose, no code fence:
{"context_update":{"summary":str 1..400,"hypotheses":[{"label":str<=60,"conf":0..1,"evidence":[id]}]<=5,"changed":[str<=200]<=8},
 "intent":str 1..240,
 "note":null | {"id":"n<k>","rationale":str<=800,"observation"?:str<=400,
   "suggestion"?:{"move":"go_deeper"|"broaden"|"return_to"|"clarify"|"simplify"|"give_example"|"check_in"|"slow_down"|"other","target"?:str<=160,"text":str<=280},
   "value":str<=500,"evidence":[id]1..24,"confidence":0..1,"expires_after_turns":1},
 "no_note_reason":null | str<=400}
Rules: a note needs observation or suggestion (or both). note null <=> no_note_reason is a non-empty string.
id = "e<k>" (event) | "u<k>" | "a<k>" | "a<k>.p<k>" | "a<k>.p<k>.s<k>", and must appear in this input.
No other keys anywhere.`;
