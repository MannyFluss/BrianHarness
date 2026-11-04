import { cn } from "../lib";

export type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  engagement?: number;
  /** assistant reply still arriving (tokens streaming in) */
  streaming?: boolean;
  /** when its first token was rendered (epoch ms) */
  firstTokenAt?: number;
  /** the reply hit the model's token limit (finish_reason "length") */
  cutOff?: boolean;
  /** the reply stream failed part-way: the text above is all that arrived */
  failed?: boolean;
};

/**
 * Actor/Director E5 (opt-in): tag each paragraph so the gaze tracker can find its box. Same split as core
 * digest.ts paragraphs() (blank-line separated); separators are kept so the text and the pre-wrap layout are
 * unchanged. Inline spans: no layout change. Without the prop the DOM is exactly the protocol-4 DOM.
 */
export function paragraphChunks(text: string): Array<{ p: number | null; text: string }> {
  const out: Array<{ p: number | null; text: string }> = [];
  let p = 0;
  for (const chunk of text.split(/(\n\s*\n)/)) {
    if (!chunk) continue;
    if (!chunk.trim()) out.push({ p: null, text: chunk });
    else out.push({ p: p++, text: chunk });
  }
  return out;
}
function Tagged({ msgId, text }: { msgId: string; text: string }) {
  return <>{paragraphChunks(text).map((c, i) => (c.p === null ? c.text : <span key={i} data-msg={msgId} data-p={c.p}>{c.text}</span>))}</>;
}

// Same treatment as LearnHarness: assistant = bare prose on the page, user = right-aligned raised bubble.
export function Message({ msg, aoi }: { msg: ChatMsg; /** E5: tag paragraphs for gaze AOIs (assistant replies) */ aoi?: { msg: string } }) {
  const user = msg.role === "user";
  return (
    <div className={cn("eeg-enter group flex w-full max-w-[95%] flex-col gap-1", user ? "ml-auto items-end" : "items-start")}>
      <div className={cn("eeg-prose w-fit min-w-0 max-w-full whitespace-pre-wrap text-foreground", user && "rounded-lg bg-secondary px-4 py-3")} data-msg-role={msg.role} data-streaming={msg.streaming ? "true" : undefined}>
        {aoi && !user ? <Tagged msgId={aoi.msg} text={msg.text} /> : msg.text}
        {msg.streaming && <span className="eeg-caret ml-0.5 inline-block animate-pulse text-muted-foreground" aria-hidden>▍</span>}
      </div>
      {!user && msg.cutOff && <span className="text-xs italic text-muted-foreground" data-reply-cutoff="true">Reply cut off (length limit)</span>}
      {!user && msg.failed && <span className="text-xs italic text-amber-500" data-reply-failed="true">Reply interrupted: the connection dropped before it finished</span>}
      {user && msg.engagement !== undefined && (
        <span className="text-xs text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">engagement {msg.engagement.toFixed(2)}</span>
      )}
    </div>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function Thinking({ tick }: { tick: number }) {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground" data-typing-indicator="true" role="status" aria-label="Director is typing"><span>{FRAMES[tick % FRAMES.length]}</span> thinking</div>;
}
