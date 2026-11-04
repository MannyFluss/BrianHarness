/**
 * E4: context share. Per Actor request (spec "Context share"): S = fixed system prompt, H = prior visible
 * transcript, U = the latest user message (the opener cue on the opener), D = the hint block "\n\n" + actor_text
 * (0 without a note), E = the part of H written by the Actor under a note (echo).
 *   share s_t = D / (S + H + U + D)      dynamic d_t = D / (H + U + D)
 *   session share = ΣD / Σtotal          session dynamic = ΣD / Σ(H + U + D)      echo share = ΣE / ΣH
 *   injection rate = requests with D > 0 / requests; mean / max turn share over injected requests (null if none).
 * Each part is counted on its own text (message content only, no chat-template overhead), with o200k_base.
 */
import type { BhAdEventBody } from "../ad-contracts/index.js";
import type { TokenCounter } from "./tokenizer.js";

export interface HistoryMessage { role: "user" | "assistant"; text: string; /** assistant only: the note that was injected into the request that wrote it */ noteId?: string | null }
export interface ActorRequestParts {
  system: string;
  history: HistoryMessage[];
  user: string;
  /** "\n\n" + actor_text exactly as appended to the system message, or null */
  hint: string | null;
}
export type ContextShareEvent = Extract<BhAdEventBody, { type: "context_share" }>;
export type SessionShareEvent = Extract<BhAdEventBody, { type: "session_share" }>;

export class ContextShareTracker {
  readonly rows: ContextShareEvent[] = [];
  private memo = new Map<string, number>();
  constructor(readonly counter: TokenCounter) {}
  tokens(text: string): number {
    let n = this.memo.get(text);
    if (n === undefined) { n = this.counter.count(text); if (this.memo.size < 4096) this.memo.set(text, n); }
    return n;
  }
  /** one context_share row for one Actor request */
  measure(turn: number, noteId: string | null, opener: boolean, p: ActorRequestParts, providerPromptTokens: number | null = null): ContextShareEvent {
    const system = this.tokens(p.system);
    let history = 0, echo = 0;
    for (const m of p.history) {
      const n = this.tokens(m.text);
      history += n;
      if (m.role === "assistant" && m.noteId) echo += n;
    }
    const user = this.tokens(p.user);
    const director = p.hint ? this.tokens(p.hint) : 0;
    const total = system + history + user + director;
    const dyn = history + user + director;
    const row: ContextShareEvent = {
      type: "context_share", turn, note_id: director > 0 ? noteId : null, opener, system, history, history_echo: echo, user, director, total,
      share: total ? director / total : 0, dynamic_share: dyn ? director / dyn : 0, provider_prompt_tokens: providerPromptTokens,
    };
    this.rows.push(row);
    return row;
  }
  /** running session numbers (the Director's footprint reads these) */
  get sessionShare(): number { const t = sum(this.rows, (r) => r.total); return t ? sum(this.rows, (r) => r.director) / t : 0; }
  get sessionDynamicShare(): number { const t = sum(this.rows, (r) => r.total - r.system); return t ? sum(this.rows, (r) => r.director) / t : 0; }
  summary(counts: { shadow_notes: number; blocked_notes: number }): SessionShareEvent {
    const inj = this.rows.filter((r) => r.director > 0);
    const H = sum(this.rows, (r) => r.history);
    return {
      type: "session_share", turns: this.rows.length, notes: inj.length, shadow_notes: counts.shadow_notes, blocked_notes: counts.blocked_notes,
      injection_rate: this.rows.length ? inj.length / this.rows.length : 0,
      session_share: this.sessionShare, session_dynamic_share: this.sessionDynamicShare,
      mean_turn_share: inj.length ? sum(inj, (r) => r.share) / inj.length : null,
      max_turn_share: inj.length ? Math.max(...inj.map((r) => r.share)) : null,
      echo_share: H ? sum(this.rows, (r) => r.history_echo) / H : 0,
    };
  }
}
const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);
