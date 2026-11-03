// In-app bug report delivery (docs/FEEDBACK_REPORT_SCHEMA.md): POST /v1/feedback through the upload queue
// (kind "feedback", the same Spider Cloud device token), else export/share the report as one .json file.
//   201 {id} / 409 report_exists      -> "sent"
//   404 (endpoint not deployed yet), 400 / 413 / 422, secret pre-check, > 256 KB
//                                     -> needs-export (final: never retried) -> "exported" via BHExport / download
//   no token, offline, 5xx, 429       -> stays queued (the queue retries; report_id makes a resend idempotent)
//                                        AND exported now, so the report is never stuck on the device
// Nothing here touches the study, the schedule, ratings or session records.
import type { FeedbackReport, FlightRecorder, UploadQueue } from "@brianharness/core/browser";
import type { BHExportPlugin, ExportFile, ExportResult, FeedbackSendResult } from "./types";
import { shareViaBHExport } from "./bh-export";

export const feedbackFileName = (r: Pick<FeedbackReport, "report_id" | "created_at">) =>
  `bh-feedback-${r.created_at.slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}-${r.report_id.slice(0, 8)}.json`;

export function feedbackFile(r: FeedbackReport): ExportFile {
  return { name: feedbackFileName(r), content: `${JSON.stringify(r, null, 2)}\n`, mimeType: "application/json" };
}

/** plain-browser fallback: download the one .json file */
export function downloadFile(f: ExportFile, doc: Document | undefined = typeof document !== "undefined" ? document : undefined): boolean {
  if (!doc || typeof Blob === "undefined" || typeof URL?.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([f.content], { type: f.mimeType ?? "application/json" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = f.name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export function createFeedbackApi(o: {
  queue: Promise<UploadQueue>;
  bhExport?: BHExportPlugin;
  /** tests: replaces the web download */
  download?: (files: ExportFile[], name: string) => boolean;
  recorder?: FlightRecorder;
}) {
  const exportReport = async (r: FeedbackReport): Promise<ExportResult> => {
    const f = feedbackFile(r);
    if (o.bhExport) return shareViaBHExport(o.bhExport, [f]);
    const ok = o.download ? o.download([f], f.name) : downloadFile(f);
    return { ok, files: 1, via: ok ? "download" : "none" };
  };
  return {
    export: exportReport,
    async send(r: FeedbackReport): Promise<FeedbackSendResult> {
      let state: "sent" | "queued" | "needs-export" = "queued";
      let status: number | undefined;
      let reason: string | undefined;
      try {
        const q = await o.queue;
        const added = await q.enqueueFeedback(r, feedbackFileName(r));
        const before = added ?? (await q.item(r.report_id));
        if (before?.state === "pending") await q.flush(); // not forced: an existing 429/401 pause still holds
        const it = await q.item(r.report_id);
        status = it?.lastStatus;
        reason = it?.lastError ?? (await q.summary()).feedback?.blocked;
        state = it?.state === "done" ? "sent" : it?.state === "needs-export" ? "needs-export" : "queued";
      } catch (err) {
        state = "needs-export";
        reason = (err as Error).message;
      }
      o.recorder?.record("state", { event: "feedback_delivery", state, ...(status !== undefined ? { status } : {}), ...(reason ? { reason } : {}) });
      if (state === "sent") return { state: "sent", queued: false, ...(status !== undefined ? { status } : {}) };
      const exp = await exportReport(r);
      return { state: exp.ok ? "exported" : state === "queued" ? "queued" : "failed", queued: state === "queued", ...(status !== undefined ? { status } : {}), ...(reason ? { reason } : {}), export: exp };
    },
  };
}
