// Report assembly for the in-app bug report: header (build, commit, device, OS, orientation, app state, note,
// session id, coarse study state) + the flight recorder's events + the last 6 chat turns, via core
// buildFeedbackReport (redaction, study safety, size cap). Reading only: nothing here writes app or study state.
import { buildFeedbackReport, FEEDBACK_CHAT_TURNS, type FeedbackChatTurn, type FeedbackReport, type FlightRecorder } from "@brianharness/core/browser";
import type { ChatMsg } from "../components/Message";
import type { EegBridge, Info } from "../transport/types";
import { overlaysOf } from "./snapshot";

declare const __BH_COMMIT__: string | undefined;
export const BUILD_COMMIT: string | null = typeof __BH_COMMIT__ === "string" && __BH_COMMIT__ ? __BH_COMMIT__ : null;

/** Cmd+Shift+R (Mac / iPad keyboard) or Ctrl+Shift+R: open the Report sheet (preventDefault: not a reload) */
export function isReportShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "r";
}

/** the last 6 chat bubbles as the user saw them */
export function chatTurnsOf(messages: ChatMsg[], n = FEEDBACK_CHAT_TURNS): FeedbackChatTurn[] {
  return messages.slice(-n).map((m) => ({
    role: m.role, text: m.text,
    ...(m.cutOff ? { cutOff: true } : {}), ...(m.failed ? { failed: true } : {}), ...(m.streaming ? { streaming: true } : {}),
    ...(m.role === "assistant" && m.text.startsWith("⚠") ? { error: true } : {}),
  }));
}

export function deviceInfo(win: Window): { device: string; os: string; orientation: string } {
  const ua = win.navigator?.userAgent ?? "";
  const touch = (win.navigator?.maxTouchPoints ?? 0) > 1;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux PC" : "unknown";
  const ios = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  const mac = ua.match(/Mac OS X (\d+)[_.](\d+)/);
  const os = ios ? `iOS ${ios[1]}.${ios[2]}${ios[3] ? `.${ios[3]}` : ""}` : device === "iPad" && mac ? `iPadOS (desktop UA ${mac[1]}.${mac[2]})` : mac ? `macOS ${mac[1]}.${mac[2]}` : /Windows NT ([\d.]+)/.test(ua) ? `Windows NT ${RegExp.$1}` : /Android ([\d.]+)/.test(ua) ? `Android ${RegExp.$1}` : /Linux/.test(ua) ? "Linux" : "unknown";
  const t = (win.screen as Screen & { orientation?: { type?: string } })?.orientation?.type;
  const orientation = t ? t.replace(/-primary|-secondary/, "") : win.matchMedia?.("(orientation: portrait)").matches ? "portrait" : "landscape";
  return { device, os, orientation: `${orientation} ${win.innerWidth}x${win.innerHeight}` };
}

export async function assembleReport(o: {
  note: string; trigger: string; messages: ChatMsg[]; recorder: FlightRecorder; bridge: EegBridge; info: Info | null;
  ui: { layout: string; sidebarOpen: boolean; hudOpen: boolean; busy: boolean }; win?: Window; reportId?: string;
}): Promise<FeedbackReport> {
  const win = o.win ?? window;
  const ctx = (await o.bridge.feedback?.context().catch(() => null)) ?? { sessionId: null, study: { inStudy: false, index: null } };
  const appInfo = (win as { __BH_APP_INFO__?: { appVersion?: string | number; build?: string | number; bundleId?: string } }).__BH_APP_INFO__;
  const uploads = await o.bridge.uploads?.status().catch(() => null);
  return buildFeedbackReport({
    events: o.recorder.events(),
    chatTurns: chatTurnsOf(o.messages),
    header: {
      build: appInfo?.build ?? null, commit: BUILD_COMMIT, appVersion: appInfo?.appVersion != null ? String(appInfo.appVersion) : null, bundleId: appInfo?.bundleId ?? null,
      ...deviceInfo(win), platform: o.bridge.platform,
      appState: {
        visibility: win.document.visibilityState, online: win.navigator?.onLine ?? null, layout: o.ui.layout, busy: o.ui.busy,
        sidebarOpen: o.ui.sidebarOpen, hudOpen: o.ui.hudOpen, overlays: overlaysOf(win.document).filter((x) => x !== "report"),
        backend: o.info?.backend ?? null, provider: o.info?.provider ?? null, model: o.info?.model ?? null,
        uploads: uploads ? { pending: uploads.pending, needsExport: uploads.needsExport, blocked: uploads.blocked ?? null } : null,
      },
      note: o.note, sessionId: ctx.sessionId, study: ctx.study, trigger: o.trigger,
    },
  }, { reportId: o.reportId });
}
