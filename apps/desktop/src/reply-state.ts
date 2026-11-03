import type { ChatMsg } from "./components/Message";

/** the streamed reply is done: final text, caret off; cutOff = finish_reason "length" (shows "Reply cut off") */
export const completeReply = (m: ChatMsg[], replyId: string, text: string, cutOff?: boolean): ChatMsg[] => {
  const flags = cutOff ? { cutOff: true } : {};
  return m.some((x) => x.id === replyId) ? m.map((x) => (x.id === replyId ? { ...x, text, streaming: false, ...flags } : x)) : [...m, { id: replyId, role: "assistant", text, ...flags }];
};
/** a turn failed: a reply that was still streaming stops (never a frozen caret) and is marked interrupted */
export const failStreaming = (m: ChatMsg[], message: string, id: string): ChatMsg[] => [
  ...m.map((x) => (x.streaming ? { ...x, streaming: false, failed: true } : x)),
  { id, role: "assistant", text: `⚠ ${message}` },
];
