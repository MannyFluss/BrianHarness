// The renderer's one transport interface. Implementations:
//   - Electron: window.eeg from electron/preload.cjs (IPC to the core in the main process)
//   - in-process: transport/in-process.ts runs @brianharness/core/browser in the page (web target,
//     and the iOS Capacitor/WKWebView shell)
// Shapes mirror @brianharness/core loosely so the Electron renderer bundle never imports core.
import type { AppleAuthView } from "./apple-auth";
export type { AppleAuthView, AppleAuthPhase } from "./apple-auth";
export type InputSource = "hardware-key" | "soft-keyboard" | "autocorrect" | "predictive" | "composition" | "dictation" | "paste" | "drop" | "programmatic" | "unknown";
export type TypingEvent = { t: number; kind: "insert" | "delete" | "paste" | "nav" | "submit" | "focus" | "blur"; len: number; source?: InputSource; chars?: number };
export type Plan = { turn: number; mode: "explore" | "exploit" | "relax"; topic: string; altTopic?: string; style: string; reason: string };
export type DirectorTurn = { text: string; plan: Plan; stateNote: string; genMs: number; firstTokenMs?: number; /** finish_reason "length" */ truncated?: boolean };
/** Incremental Director text (a delta to append). Non-streaming backends send the whole text once. */
export type TokenHandler = (delta: string) => void;
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
  /** blinded study session: interest map / plan / hypothesis are withheld */
  study?: { index: number; total: number };
  /** study sessions: "Interest AI unavailable this session (cap reached)" etc. (mode-free) */
  extractorWarning?: string;
};
/** One absorption prompt as the UI saw it (evaluation only; see core RatingRecord). */
export type RatingInput = {
  scope: "turn" | "session";
  turn: number;
  value: number | null;
  shownAt: number;
  answeredAt: number | null;
  dismissed: boolean;
  reason?: string;
  hooked?: string;
  blindGuess?: "adaptive" | "baseline" | "no-idea" | null;
};
export type ExportFile = { name: string; content: string; mimeType?: string };
/**
 * IOS Dev's BHExport Capacitor plugin (contract from IOS Dev, Nov 2):
 *   share({files})            share sheet (AirDrop, Files, ...) -> {completed, activityType?}
 *   saveToDocuments({files})  writes into the app's Documents folder (visible in Files)
 */
export interface BHExportPlugin {
  share(o: { files: ExportFile[] }): Promise<{ completed: boolean; activityType?: string }>;
  saveToDocuments(o: { files: Array<{ name: string; content: string }> }): Promise<{ dir: string; paths: string[] }>;
}
/** ok:false + dismissed:true is a user cancel (no error toast); `error` is a friendly message. */
export type ExportResult = { ok: boolean; files: number; via: "share-sheet" | "save-dialog" | "download" | "none"; detail?: string; dismissed?: boolean; error?: string; code?: string };
/** Phase D study status as the UI may show it: never the mode or the schedule. */
export type StudyStatusView = { enabled: boolean; next: number; total: number; scheduled: boolean; error?: string; pendingReissue?: number;
  /** schedule present, progress gone and not rebuildable: blocking "Study progress lost; contact the Researcher" */
  progressLost?: boolean;
  /** progress was rebuilt from the session records on this device */
  progressRecovered?: boolean };
/** auto-upload queue (POST /v1/sessions): "N logs waiting to upload", plus finals that need "Export logs" */
export type UploadStatusView = {
  pending: number; needsExport: number; done: number;
  blocked?: "no-token" | "auth" | "rate-limited" | "offline";
  items: Array<{ id: string; kind: "session" | "study_start" | "feedback"; name?: string; state: "pending" | "needs-export" | "done"; lastStatus?: number; lastError?: string }>;
};
/**
 * In-app bug report delivery result. sent = 201/409 report_exists; exported = the upload failed or can't happen
 * yet (404 endpoint not deployed, 4xx, no token, offline) and the .json went out via the share sheet / download;
 * queued = still in the upload queue for a retry (also true together with "exported" when the retry is pending).
 */
export type FeedbackSendResult = { state: "sent" | "exported" | "queued" | "failed"; queued: boolean; status?: number; reason?: string; export?: ExportResult };
/** session-log bracket around the Report sheet (Director-approved): open -> sent | closed */
export type FeedbackLogEvent = { type: "feedback_open" | "feedback_sent" | "feedback_closed"; ts: number; sent?: boolean; report_id?: string };
export type SessionItem = { id: string; title: string; turns: number; startedAt: string | null; active: boolean };
export type Info = {
  backend: string; paid: boolean; provider: string; model: string | null; dataDir: string; userId: string; platform: string; appName: string;
  /** extractor prompt setting ("v2" default; "v1" = rollback) */
  extractorPromptVersion?: "v1" | "v2";
  /** topic tagger the NEXT session uses, e.g. "llm-extract gemma4:cloud via Ollama Cloud (prompt v2)" */
  tagger?: string;
};
export type ProviderId = "mock" | "ollama" | "ollama-cloud" | "openai-compatible" | "openai" | "claude-code" | "anthropic" | "spider-cloud";
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
  /** editable server URL (Ollama on the LAN, OpenAI-compatible server) when the transport supports it */
  endpoint?: string;
};
export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };
export type AuthPrompt = { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
export type KeyProvider = "openai" | "anthropic" | "openai-compatible" | "ollama-cloud" | "spider";
export interface ProvidersBridge {
  status(): Promise<{ providers: ProviderStatus[]; current: Info }>;
  select(provider: ProviderId, model?: string | null): Promise<Info>;
  setApiKey(provider: KeyProvider, key: string): Promise<{ ok: boolean }>;
  /** optional: set a provider's server URL (in-process transport; Electron stores ollamaUrl) */
  setEndpoint?(provider: "ollama" | "openai-compatible" | "spider-cloud", url: string): Promise<{ ok: boolean }>;
  /** settings rollback flag for the llm-extract prompt ("v2" default, "v1" rollback); next session on */
  setExtractorPrompt?(version: "v1" | "v2"): Promise<Info>;
  logout(provider: KeyProvider): Promise<{ ok: boolean }>;
  login(provider: "openai" | "anthropic"): Promise<{ ok: boolean; error?: string }>;
  cancelLogin(): Promise<boolean>;
  answer(id: string, value: string): Promise<boolean>;
  onAuthEvent(cb: (e: AuthEvent) => void): () => void;
  onAuthPrompt(cb: (p: AuthPrompt) => void): () => void;
  onAuthPromptDone(cb: (p: { id: string }) => void): () => void;
}

export interface EegBridge {
  newSession(onToken?: TokenHandler): Promise<{ sessionId: string; director: DirectorTurn; hud: Hud; title: string }>;
  /**
   * shownAt = previous Director message FULLY displayed (completeAt; starts the reply-latency
   * clock); firstTokenAt = its first token displayed (logged only). onToken streams the reply.
   */
  reply(
    p: { text: string; events: TypingEvent[]; sentAt: number; shownAt: number; firstTokenAt?: number },
    onToken?: TokenHandler,
  ): Promise<{ director: DirectorTurn; hud: Hud; engagement: number; title: string }>;
  hud(): Promise<Hud | null>;
  sessions(): Promise<SessionItem[]>;
  info(): Promise<Info>;
  providers: ProvidersBridge;
  platform: string;
  /** "electron" (IPC) or "in-process" (web / iOS WebView) */
  kind?: "electron" | "in-process";
  /** where API keys are kept, shown in the key dialog */
  credentialNote?: string;
  /** persist pending writes (in-process transport; call on pagehide/visibilitychange) */
  flush?(): Promise<void>;
  /** log an absorption rating to the current session (evaluation only) */
  rate?(r: RatingInput): Promise<{ ok: boolean }>;
  /** "Export logs": session JSONL files + interest map via share sheet / save dialog / download */
  exportLogs?(): Promise<ExportResult>;
  /** Phase D blinded study (status/enable only; hash/unseal are dev-only debug hooks) */
  study?: {
    status(): Promise<StudyStatusView>;
    enable(): Promise<{ ok: boolean; error?: string }>;
    disable(): Promise<{ ok: boolean }>;
    /** dev/debug only: sha256 of the sealed schedule (never the order) */
    hash?(): Promise<string | null>;
    /** dev/debug only: reveals the schedule; needs the confirmation phrase "UNSEAL phaseD" */
    unseal?(confirm: string): Promise<unknown>;
    exportSchedule?(confirm: string): Promise<ExportResult>;
    /** manual redo: the next study session reuses index n (1..10, already assigned); confirm must be "REISSUE n" */
    reissue?(n: number, confirm: string, reason?: string): Promise<{ ok: boolean; error?: string }>;
    cancelReissue?(): Promise<{ ok: boolean }>;
    /** unblock after "progress lost": the next study session gets index n; confirm must be "SET NEXT n" */
    setNext?(n: number, confirm: string): Promise<{ ok: boolean; error?: string }>;
  };
  /**
   * Sign in with Apple (iOS, BHAppleAuth present): the Worker session token goes into the Spider Cloud slot
   * (credentials/spider). launch() runs the launch checks once (refresh < 14 days, credentialState).
   */
  appleAuth?: {
    launch(): Promise<AppleAuthView>;
    signIn(): Promise<AppleAuthView>;
    skip(): void;
    status(): Promise<AppleAuthView>;
    onChange(cb: (v: AppleAuthView) => void): () => void;
  };
  /**
   * In-app bug report (FEEDBACK_REPORT_SCHEMA.md): send = POST /v1/feedback via the upload queue, export fallback;
   * export = share / download the report .json only. Never touches study, schedule or session records.
   */
  feedback?: {
    send(report: unknown): Promise<FeedbackSendResult>;
    export(report: unknown): Promise<ExportResult>;
    /** current session id + coarse study state for the report header ({inStudy, index} only) */
    context(): Promise<{ sessionId: string | null; study: { inStudy: boolean; index: number | null } }>;
  };
  /** study-log auto-upload to the Spider Cloud Worker (needs the device token) */
  uploads?: {
    status(): Promise<UploadStatusView>;
    flush(): Promise<UploadStatusView>;
  };
}

