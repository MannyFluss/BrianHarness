/**
 * Helpers shared by backends that take "system prompt + one prompt" instead of a chat array
 * (pi-ai subscriptions, Claude Code CLI). The Director transcript is collapsed into a single
 * user message so we never have to fabricate provider-specific assistant-message metadata.
 */
import type { ChatMessage } from "../types.js";

export function collapseTranscript(messages: ChatMessage[]): { system: string; prompt: string } {
  const systems = messages.filter((m) => m.role === "system");
  const system = systems[0]?.content ?? "";
  const lines: string[] = [];
  for (const m of messages.slice(1)) {
    if (m.role === "user") lines.push(`User: ${m.content}`);
    else if (m.role === "assistant") lines.push(`Director (you): ${m.content}`);
  }
  const stateNotes = systems.slice(1).map((m) => m.content);
  const prompt = [
    lines.length ? `Conversation so far:\n${lines.join("\n")}` : "The conversation is just starting; write the opening message.",
    ...stateNotes,
    "Write ONLY the Director's next message (no labels, no quotes).",
  ].join("\n\n");
  return { system, prompt };
}

/** true for loopback / private-LAN URLs, i.e. a model server on this machine or network */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local");
  } catch {
    return false;
  }
}
