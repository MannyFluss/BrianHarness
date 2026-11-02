// Types for window.eeg (exposed by electron/preload.cjs). Mirrors @eeg/core shapes loosely
// so the renderer bundle never imports Node code.
export type TypingEvent = { t: number; kind: "insert" | "delete" | "paste" | "nav" | "submit" | "focus" | "blur"; len: number };
export type Plan = { turn: number; mode: "explore" | "exploit" | "relax"; topic: string; altTopic?: string; style: string; reason: string };
export type DirectorTurn = { text: string; plan: Plan; stateNote: string; genMs: number };
export type Hud = {
  sessionId: string;
  userId: string;
  backend: string;
  turn: number;
  frame: null | { turn: number; engagement: number; baseline: number; lift: number; features: Record<string, number>; mentionedTopics: string[] };
  plan: Plan | null;
  hypothesis: string | null;
  topTopics: Array<[string, number, number]>;
  topStyles: Array<[string, number, number]>;
};
export type SessionItem = { id: string; title: string; turns: number; startedAt: string | null; active: boolean };
export type Info = { backend: string; paid: boolean; dataDir: string; userId: string; platform: string };

export interface EegBridge {
  newSession(): Promise<{ sessionId: string; director: DirectorTurn; hud: Hud }>;
  reply(p: { text: string; events: TypingEvent[]; sentAt: number; shownAt: number }): Promise<{ director: DirectorTurn; hud: Hud; engagement: number }>;
  hud(): Promise<Hud | null>;
  sessions(): Promise<SessionItem[]>;
  info(): Promise<Info>;
  platform: string;
}

declare global {
  interface Window {
    eeg?: EegBridge;
    __eegDemo?: { type(text: string): Promise<void>; draft(text: string): void };
  }
}

export const bridge = (): EegBridge => {
  if (!window.eeg) throw new Error("EEG bridge missing: run inside Electron (npm run desktop)");
  return window.eeg;
};
