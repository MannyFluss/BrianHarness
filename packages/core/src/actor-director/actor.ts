/**
 * E2: the Actor. The spec's ACTOR_SYSTEM_PROMPT (fixed bytes) plus one Engineer line carried over from protocol 4
 * (the opener cue explanation; the Actor opener sends OPENER_CUE, and without the line the model may answer the
 * cue as if the person typed it). The id is "ap1-" + the first 8 hex of sha256(prompt) (a test pins it).
 * Request shape: ONE leading system message (prompt, then "\n\n" + actor_text as its LAST block on a turn with an
 * injected note), then the visible transcript only, then the latest user message (or the opener cue). TTL 1: a note
 * is used for exactly one request.
 */
import { HINT_SEPARATOR } from "../ad-contracts/index.js";
import { OPENER_CUE } from "../backends.js";
import { sha256HexSync } from "../study.js";
import type { ChatMessage } from "../types.js";
import type { ActorRequestParts, HistoryMessage } from "./share.js";

export const ACTOR_SYSTEM_PROMPT = `You are a warm, friendly chat partner in a chat app.
Always respond to the person's latest message first. If they ask a question, answer it.
If they give an instruction, do exactly that, fully and right away.
Match the length to the request. Stay with what they bring up.
Never claim to know what the person looked at, read, felt or skipped.
The very first user message may be "(session start)": that is not from the person, so just greet them briefly
and invite them to say what's on their mind.`;
export const ACTOR_PROMPT_ID = "ap1-4488ad31";
export const actorPromptId = (text = ACTOR_SYSTEM_PROMPT) => "ap1-" + sha256HexSync(text).slice(0, 8);

export interface ActorRequest { messages: ChatMessage[]; parts: ActorRequestParts; sha256: string }

/**
 * history: the visible transcript before this turn (user + assistant messages, opener reply included, cue excluded).
 * user: the latest user message, or null on the opener (then OPENER_CUE is sent).
 */
export function buildActorRequest(history: HistoryMessage[], user: string | null, actorText: string | null): ActorRequest {
  const hint = actorText ? HINT_SEPARATOR + actorText : null;
  const system = ACTOR_SYSTEM_PROMPT + (hint ?? "");
  const u = user ?? OPENER_CUE;
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.text })), { role: "user", content: u }];
  return { messages, parts: { system: ACTOR_SYSTEM_PROMPT, history, user: u, hint }, sha256: sha256HexSync(JSON.stringify(messages)) };
}
