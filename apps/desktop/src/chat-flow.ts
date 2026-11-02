// One Director turn as the UI sees it, independent of React so the ordering is testable:
//   1. showPending()  typing indicator + the user's bubble, committed synchronously (flushSync)
//   2. paint()        wait until that frame is on screen: NOTHING (network, tagger, core) runs first
//   3. call(onToken)  the transport; each delta grows the reply. The first delta replaces the
//                     indicator with the streaming message (onFirstToken)
//   4. resolves with the final result; the caller marks the message complete, and the frame that
//      shows it complete is the reply-latency clock start (completeAt), see App.tsx
// Non-streaming transports/backends deliver one delta with the whole text, same flow.
export interface StreamTurnDeps<R> {
  showPending(): void;
  paint(): Promise<void>;
  call(onToken: (delta: string) => void): Promise<R>;
  /** first delta: hide the indicator, show the message with this text */
  onFirstToken(text: string, at: number): void;
  /** later deltas: the whole text so far */
  onText(text: string): void;
  now?: () => number;
}

export async function runStreamedTurn<R>(d: StreamTurnDeps<R>): Promise<{ result: R; text: string; firstTokenAt?: number }> {
  const now = d.now ?? Date.now;
  d.showPending();
  await d.paint();
  let text = "";
  let firstTokenAt: number | undefined;
  const result = await d.call((delta) => {
    if (!delta) return;
    text += delta;
    if (firstTokenAt === undefined) {
      firstTokenAt = now();
      d.onFirstToken(text, firstTokenAt);
    } else d.onText(text);
  });
  return { result, text, firstTokenAt };
}

/** Resolve after the next frame has painted (rAF + macrotask), with a timeout for hidden pages. */
export function nextPaint(win: { requestAnimationFrame?: (cb: () => void) => unknown } = globalThis as never, maxMs = 50): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    setTimeout(fin, maxMs); // rAF doesn't fire in background tabs
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(() => setTimeout(fin, 0));
    else setTimeout(fin, 0);
  });
}
