import { cn } from "../lib";

export type ChatMsg = { id: string; role: "user" | "assistant"; text: string; engagement?: number };

// Same treatment as LearnHarness: assistant = bare prose on the page, user = right-aligned raised bubble.
export function Message({ msg }: { msg: ChatMsg }) {
  const user = msg.role === "user";
  return (
    <div className={cn("eeg-enter group flex w-full max-w-[95%] flex-col gap-1", user ? "ml-auto items-end" : "items-start")}>
      <div className={cn("eeg-prose w-fit min-w-0 max-w-full whitespace-pre-wrap text-foreground", user && "rounded-lg bg-secondary px-4 py-3")}>{msg.text}</div>
      {user && msg.engagement !== undefined && (
        <span className="text-xs text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">engagement {msg.engagement.toFixed(2)}</span>
      )}
    </div>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function Thinking({ tick }: { tick: number }) {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>{FRAMES[tick % FRAMES.length]}</span> thinking</div>;
}
