// Types for window.eeg (exposed by electron/preload.cjs). Mirrors @brianharness/core shapes loosely
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
export type Info = { backend: string; paid: boolean; provider: string; model: string | null; dataDir: string; userId: string; platform: string; appName: string };
export type ProviderId = "mock" | "ollama" | "openai" | "claude-code" | "anthropic";
export type ProviderStatus = {
  id: ProviderId;
  label: string;
  available: boolean;
  signedIn: boolean;
  auth: Array<"none" | "oauth" | "api_key" | "cli">;
  authSource?: string;
  models: Array<{ id: string; label: string; paid: boolean }>;
  detail?: string;
  warning?: string;
};
export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };
export type AuthPrompt = { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
export interface ProvidersBridge {
  status(): Promise<{ providers: ProviderStatus[]; current: Info }>;
  select(provider: ProviderId, model?: string | null): Promise<Info>;
  setApiKey(provider: "openai" | "anthropic", key: string): Promise<{ ok: boolean }>;
  logout(provider: "openai" | "anthropic"): Promise<{ ok: boolean }>;
  login(provider: "openai" | "anthropic"): Promise<{ ok: boolean; error?: string }>;
  cancelLogin(): Promise<boolean>;
  answer(id: string, value: string): Promise<boolean>;
  onAuthEvent(cb: (e: AuthEvent) => void): () => void;
  onAuthPrompt(cb: (p: AuthPrompt) => void): () => void;
  onAuthPromptDone(cb: (p: { id: string }) => void): () => void;
}

export interface EegBridge {
  newSession(): Promise<{ sessionId: string; director: DirectorTurn; hud: Hud; title: string }>;
  reply(p: { text: string; events: TypingEvent[]; sentAt: number; shownAt: number }): Promise<{ director: DirectorTurn; hud: Hud; engagement: number; title: string }>;
  hud(): Promise<Hud | null>;
  sessions(): Promise<SessionItem[]>;
  info(): Promise<Info>;
  providers: ProvidersBridge;
  platform: string;
}

declare global {
  interface Window {
    eeg?: EegBridge;
    __eegDemo?: { type(text: string): Promise<void>; draft(text: string): void; openPicker(): void };
  }
}

export const bridge = (): EegBridge => {
  if (!window.eeg) throw new Error("EEG bridge missing: run inside Electron (npm run desktop)");
  return window.eeg;
};
