/**
 * E3: the Director's system message, in three slots (DirectorBot decision 2026-11-04, 3:24 PM PT):
 *   system   = R3 system_prompt_v1.txt, byte-exact       -> director_prompt_id   "dir1-cf98dd5e" (sha256[:8] of the file)
 *   format   = DIRECTOR_OUTPUT_FORMAT_TEXT (contracts)     -> director_format_id   "fmt1-<sha8>"
 *   examples = R3 examples_block_v1.txt, byte-exact        -> director_examples_id "dex1-<sha8>"
 * The assembled system message joins the slots (trailing newlines trimmed) with "\n\n"; its sha256[:8] is logged as
 * assembled_prompt_sha8 (session_start.director_assembled_sha8 and every director_call). Over the 4,000-token input cap
 * the examples slot is dropped first (the spec's order), which changes assembled_prompt_sha8 for that call.
 * Token counts per slot: system = tokens(system), format = tokens("\n\n" + format), examples = tokens("\n\n" + examples)
 * (0 when dropped), digest = tokens(user digest message); input_tokens = their sum.
 */
import { DIRECTOR_OUTPUT_FORMAT_TEXT } from "../ad-contracts/index.js";
import { sha256HexSync } from "../study.js";
import { R3_EXAMPLES_BLOCK_V1, R3_SYSTEM_PROMPT_V1 } from "./director-prompt-text.js";

export const sha8 = (s: string) => sha256HexSync(s).slice(0, 8);
export interface PromptSlot { id: string; text: string }
export const DIRECTOR_SYSTEM_SLOT: PromptSlot = { id: "dir1-cf98dd5e", text: R3_SYSTEM_PROMPT_V1 };
export const DIRECTOR_FORMAT_SLOT: PromptSlot = { id: "fmt1-" + sha8(DIRECTOR_OUTPUT_FORMAT_TEXT), text: DIRECTOR_OUTPUT_FORMAT_TEXT };
export const DIRECTOR_EXAMPLES_SLOT: PromptSlot = { id: "dex1-" + sha8(R3_EXAMPLES_BLOCK_V1), text: R3_EXAMPLES_BLOCK_V1 };
export const DIRECTOR_PROMPT_ID = DIRECTOR_SYSTEM_SLOT.id;
export const DIRECTOR_MODEL = "gpt-oss:120b-cloud";
export const DIRECTOR_MAX_TOKENS = 1024;
export const DIRECTOR_INPUT_CAP = 4000;

const trimNl = (s: string) => s.replace(/\n+$/, "");
export function assembleDirectorSystem(withExamples = true): string {
  const slots = [DIRECTOR_SYSTEM_SLOT, DIRECTOR_FORMAT_SLOT, ...(withExamples ? [DIRECTOR_EXAMPLES_SLOT] : [])];
  return slots.map((s) => trimNl(s.text)).join("\n\n");
}
export const DIRECTOR_ASSEMBLED_SHA8 = sha8(assembleDirectorSystem(true));

export interface SlotTokens { system: number; format: number; examples: number; digest: number }
export function slotTokens(count: (t: string) => number, digest: string, withExamples: boolean): SlotTokens {
  return {
    system: count(trimNl(DIRECTOR_SYSTEM_SLOT.text)),
    format: count("\n\n" + trimNl(DIRECTOR_FORMAT_SLOT.text)),
    examples: withExamples ? count("\n\n" + trimNl(DIRECTOR_EXAMPLES_SLOT.text)) : 0,
    digest: count(digest),
  };
}
export const sumSlots = (s: SlotTokens) => s.system + s.format + s.examples + s.digest;
