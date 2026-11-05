/**
 * contract-v1.5: Director input modes (Mac-first; first Mac pilot = Pointer only) and pointer evidence.
 *
 * session_start.input_mode is "pointer" | "gaze" | "none", fixed for the session: changing it mid-session ENDS the
 * session (session_end) and starts a new one. A session_start without input_mode (contract-v1 .. v1.4) is "gaze".
 *
 * Evidence id prefixes alone say where evidence came from (no evidence_source field):
 *   e<k>  gaze attention event (L3)        only in mode "gaze"
 *   p<k>  pointer event (pointer_l1)       only in mode "pointer"
 *   u<k>, a<k>, a<k>.p<k>, a<k>.p<k>.s<k>  chat (user message, Actor message / paragraph / span), every mode
 * Mode "none": the Director still observes the chat and its footprint; digests carry no gaze or pointer, and a note
 * citing any e<k> / p<k> fails the evidence rail (evidence_unknown, as for any id not in the input).
 *
 * Pointer evidence (mode "pointer") is ONLY these four kinds, and ONLY on an AOI marked interactive in that message's
 * aoi_layout (AoiBox.interactive true):
 *   pointer_click   a click on an interactive control
 *   pointer_select  a selection / choice on an interactive control (e.g. a selectable span a7.p2.s1)
 *   pointer_hover   the cursor ENTERED an interactive AOI
 *   pointer_dwell   continuous time on the same interactive AOI >= pointer_config.dwell_ms (default 500 ms); gaps
 *                   <= merge_gap_ms (default 100 ms) are merged into one dwell; dwell_ms is the merged duration
 * Never pointer evidence (a client must not emit them; the guard rejects them): hover / dwell on non-interactive text
 * or paragraphs, anything on the composer (cursor-over-composer is not skimming), and gaze-style reading labels
 * (deep / read / skim / skipped, look-backs, composer pauses) derived from the pointer alone.
 * Citing a p<k> the user never produced (a control never hit) is a provenance-class failure: the evidence rail blocks it
 * (evidence_unknown) and, if it reaches a reply, it counts as a sensor/provenance leak like a made-up gaze event.
 */
export const INPUT_MODES = ["pointer", "gaze", "none"] as const;
export type InputMode = (typeof INPUT_MODES)[number];
/** what a session_start without input_mode (contract-v1 .. v1.4) means */
export const LEGACY_INPUT_MODE: InputMode = "gaze";

export const POINTER_KINDS = ["pointer_click", "pointer_select", "pointer_hover", "pointer_dwell"] as const;
export type PointerKind = (typeof POINTER_KINDS)[number];
/** hover / dwell are only evidence on interactive controls; on text they would be a reading proxy */
export const POINTER_PRESENCE_KINDS: readonly PointerKind[] = ["pointer_hover", "pointer_dwell"];

export const POINTER_DWELL_DEFAULT_MS = 500;
export const POINTER_MERGE_GAP_DEFAULT_MS = 100;
/** AOI ids that are never a pointer target, even if a layout marks them interactive */
export const POINTER_EXCLUDED_AOIS: readonly string[] = ["composer"];
/** a whole Actor paragraph (a7.p2): reply text, never interactive, so never a hover / dwell target */
export const PARAGRAPH_AOI_PATTERN = "^a[0-9]+\\.p[0-9]+$";
/** pointer_l1 rate limit, like gaze_l1: a batch covers <= 5 s and holds <= 20 pointer events */
export const POINTER_L1_MAX_EVENTS = 20;
export const POINTER_L1_MAX_WINDOW_MS = 5000;

/** session_start.pointer_config (mode "pointer" only): the thresholds in force, logged so analysis can re-tune */
export interface PointerConfig {
  /** "pc1-d<dwell_ms>-g<merge_gap_ms>": a readable id of the two numbers (the gaze_config-style hash) */
  id: string;
  dwell_ms: number;
  merge_gap_ms: number;
}
export const pointerConfigId = (dwell_ms: number, merge_gap_ms: number): string => `pc1-d${dwell_ms}-g${merge_gap_ms}`;
export const POINTER_CONFIG_ID_PATTERN = "^pc1-d[0-9]+-g[0-9]+$";
export const DEFAULT_POINTER_CONFIG: PointerConfig = { id: pointerConfigId(POINTER_DWELL_DEFAULT_MS, POINTER_MERGE_GAP_DEFAULT_MS), dwell_ms: POINTER_DWELL_DEFAULT_MS, merge_gap_ms: POINTER_MERGE_GAP_DEFAULT_MS };

/** one pointer event in a pointer_l1 batch; id "p<k>" is its evidence id (unique in the session) */
export interface PointerEvent {
  id: string;
  kind: PointerKind;
  /** the interactive AOI (a7.p2.s1, or a control id from aoi_layout) */
  aoi: string;
  /** the Actor message whose layout holds the AOI ("a7") */
  msg: string;
  /** mono ms; click / select / hover: t1 = t0 */
  t0: number; t1: number;
  /** pointer_dwell only (required there, absent otherwise): merged continuous ms on the AOI, >= pointer_config.dwell_ms */
  dwell_ms?: number;
}
/** one line of attention_digest.digest.pointer: what the Director sees (no coordinates) */
export interface PointerDigestItem { id: string; kind: PointerKind; aoi: string; excerpt: string; dwell_ms?: number }

export const POINTER_ID_PATTERN = "^p[0-9]+$";
const GAZE_ID = /^e[0-9]+$/, POINTER_ID = /^p[0-9]+$/;
export type EvidenceSource = "gaze" | "pointer" | "chat";
/** where an evidence id came from, by prefix alone */
export function evidenceSource(id: string): EvidenceSource {
  return GAZE_ID.test(id) ? "gaze" : POINTER_ID.test(id) ? "pointer" : "chat";
}
/** the evidence sources a mode may cite */
export const MODE_EVIDENCE_SOURCES: Record<InputMode, readonly EvidenceSource[]> = { pointer: ["pointer", "chat"], gaze: ["gaze", "chat"], none: ["chat"] };
/** evidence ids a mode may not cite (the rail blocks them as evidence_unknown) */
export function evidenceOutsideMode(mode: InputMode, ids: readonly string[]): string[] {
  return ids.filter((id) => !MODE_EVIDENCE_SOURCES[mode].includes(evidenceSource(id)));
}

/** why a pointer event may not be evidence (null = fine). interactive = AOI ids marked interactive in msg's aoi_layout */
export type PointerViolation = "pointer_not_interactive" | "pointer_text_presence" | "pointer_dwell_short" | "pointer_shape";
export function pointerEventViolation(e: PointerEvent, interactive: ReadonlySet<string>, cfg: Pick<PointerConfig, "dwell_ms"> = DEFAULT_POINTER_CONFIG): PointerViolation | null {
  if (!(POINTER_KINDS as readonly string[]).includes(e.kind) || !POINTER_ID.test(e.id)) return "pointer_shape";
  if ((e.kind === "pointer_dwell") !== (typeof e.dwell_ms === "number")) return "pointer_shape";
  if (POINTER_EXCLUDED_AOIS.includes(e.aoi)) return "pointer_text_presence";
  if (POINTER_PRESENCE_KINDS.includes(e.kind) && new RegExp(PARAGRAPH_AOI_PATTERN).test(e.aoi)) return "pointer_text_presence";
  if (!interactive.has(e.aoi)) return "pointer_not_interactive";
  if (e.kind === "pointer_dwell" && (e.dwell_ms as number) < cfg.dwell_ms) return "pointer_dwell_short";
  return null;
}

/** the event types each mode may write (anything else in a log of that mode is input_mode_mismatch) */
export const MODE_FORBIDDEN_TYPES: Record<InputMode, readonly string[]> = {
  pointer: ["gaze_l1", "gaze_raw", "aoi_dwell"],
  gaze: ["pointer_l1"],
  none: ["gaze_l1", "gaze_raw", "aoi_dwell", "pointer_l1"],
};
/** attention_digest rules per mode (null = fine): pointer has no gaze reading labels or e-events; gaze no pointer; none neither */
export function digestModeViolation(mode: InputMode, d: { digest: { paras: unknown[]; lookBacks: unknown[]; offscreenMs: number; composerPauses: number; events: unknown[]; pointer?: unknown[]; input_mode?: InputMode }; events: unknown[] }): string | null {
  const g = d.digest;
  if (g.input_mode !== undefined && g.input_mode !== mode) return "digest input_mode differs from session_start";
  const gazeish = g.paras.length > 0 || g.lookBacks.length > 0 || g.offscreenMs > 0 || g.composerPauses > 0 || g.events.length > 0 || d.events.length > 0;
  const pointerish = (g.pointer?.length ?? 0) > 0;
  if (mode !== "gaze" && gazeish) return `gaze reading data in a ${mode} digest`;
  if (mode !== "pointer" && pointerish) return `pointer data in a ${mode} digest`;
  return null;
}
