import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, FlaskConicalIcon, RotateCcwIcon, UploadCloudIcon } from "lucide-react";
import { bridge, type StudyStatusView, type UploadStatusView } from "../bridge";
import { cn } from "../lib";

export const STUDY_LOST_TEXT = "Study progress lost; contact the Researcher";
/**
 * Blocking notice above the chat while the study progress is lost (schedule kept, progress not rebuildable):
 * study sessions do not run until the participant uses "Set next study session" (Settings) as the Researcher says.
 */
export function StudyLostBanner() {
  const b = bridge();
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (!b.study) return;
    let live = true;
    const poll = () => void b.study!.status().then((s) => { if (live) setLost(!!s.progressLost); }, () => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => { live = false; clearInterval(t); };
  }, [b]);
  if (!lost) return null;
  return (
    <div role="alert" className="mx-3 mt-2 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm text-red-300" data-study-lost>
      <strong>{STUDY_LOST_TEXT}.</strong> Study sessions are paused until the next session number is set in Settings (Set next study session).
    </div>
  );
}

// Settings > data: "Export logs" (session JSONL + interest map) and the Phase D study switch.
// Shows only the study's progress, never its schedule or a session's condition.
export function StudyData() {
  const b = bridge();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [study, setStudy] = useState<StudyStatusView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [uploads, setUploads] = useState<UploadStatusView | null>(null);
  const [redo, setRedo] = useState<{ n: string; reason: string; phrase: string } | null>(null);
  const [setNext, setSetNext] = useState<{ n: string; phrase: string } | null>(null);
  const refresh = useCallback(async () => {
    if (b.study) setStudy(await b.study.status().catch(() => null));
    if (b.uploads) setUploads(await b.uploads.status().catch(() => null));
  }, [b]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!b.exportLogs && !b.study) return null;

  const exportLogs = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await b.exportLogs!();
      if (r.error) setMsg({ text: r.error, error: true });
      else if (r.dismissed || r.detail === "canceled") setMsg(null); // a cancel is not an error
      else setMsg({ text: r.ok ? `Exported ${r.files} file${r.files === 1 ? "" : "s"}.` : (r.detail ?? "Nothing exported.") });
    } catch (err) {
      setMsg({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const toggleStudy = async () => {
    if (!b.study || !study) return;
    if (!study.enabled && !confirm) return setConfirm(true);
    setConfirm(false);
    const r = study.enabled ? await b.study.disable() : await b.study.enable();
    if (!r.ok) setMsg({ text: `Study not started: ${"error" in r && r.error ? r.error : "secure store unavailable"}`, error: true });
    await refresh();
  };
  const assigned = study ? Math.min(study.next - 1, study.total) : 0;
  const submitRedo = async () => {
    if (!b.study?.reissue || !redo) return;
    const r = await b.study.reissue(Number(redo.n), redo.phrase, redo.reason || undefined);
    if (!r.ok) return setMsg({ text: r.error ?? "not accepted", error: true });
    setRedo(null);
    setMsg({ text: `The next study session redoes session ${redo.n}.` });
    await refresh();
  };
  const submitSetNext = async () => {
    if (!b.study?.setNext || !setNext) return;
    const r = await b.study.setNext(Number(setNext.n), setNext.phrase);
    if (!r.ok) return setMsg({ text: r.error ?? "not accepted", error: true });
    setSetNext(null);
    setMsg({ text: `The next study session is session ${setNext.n}.` });
    await refresh();
  };
  const uploadNow = async () => {
    if (!b.uploads) return;
    setUploads(await b.uploads.flush().catch(() => uploads));
  };
  const waiting = uploads ? uploads.pending : 0;
  const blockedText: Record<string, string> = { "no-token": "needs the Spider Cloud device token", auth: "device token rejected: paste a new one", "rate-limited": "upload limit reached, retrying later", offline: "offline, retrying" };
  const input = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground";
  const row = "eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";
  return (
    <div className="mb-2 flex flex-col gap-0.5" data-study-data>
      {b.exportLogs && <button className={row} onClick={() => void exportLogs()} disabled={busy} data-export-logs><DownloadIcon className="size-3" /> {busy ? "Exporting…" : "Export logs"}</button>}
      {b.study && study?.progressLost && (
        <div className="flex flex-col gap-1 px-2 py-1" data-study-lost-settings>
          <div role="alert" className="text-xs text-red-400">{STUDY_LOST_TEXT}.</div>
          {b.study.setNext && (setNext ? (
            <div className="flex flex-col gap-1" data-study-setnext-form>
              <label className="text-xs text-muted-foreground">Next study session
                <select className={cn(input, "mt-0.5")} value={setNext.n} onChange={(e) => setSetNext({ n: e.target.value, phrase: "" })} data-study-setnext-n>
                  {Array.from({ length: study.total }, (_, i) => String(i + 1)).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <input className={input} autoCapitalize="characters" autoCorrect="off" placeholder={`Type SET NEXT ${setNext.n} to confirm`} value={setNext.phrase} onChange={(e) => setSetNext({ ...setNext, phrase: e.target.value })} data-study-setnext-phrase />
              <div className="flex gap-1">
                <button className={row} disabled={setNext.phrase.trim() !== `SET NEXT ${setNext.n}`} onClick={() => void submitSetNext()} data-study-setnext-submit>Set next to {setNext.n}</button>
                <button className={row} onClick={() => setSetNext(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className={row} onClick={() => setSetNext({ n: "1", phrase: "" })} data-study-setnext>
              <RotateCcwIcon className="size-3" /> Set next study session…
            </button>
          ))}
        </div>
      )}
      {b.study && study && !study.progressLost && (
        <button className={row} onClick={() => void toggleStudy()} data-study-toggle>
          <FlaskConicalIcon className="size-3" />
          {study.enabled ? `Study ${Math.min(study.next, study.total)}/${study.total} · stop` : confirm ? "Tap again to start the 10-session study" : study.next > study.total ? "Study complete" : "Start study"}
        </button>
      )}
      {b.study?.reissue && study?.scheduled && !study.progressLost && assigned > 0 && (
        study.pendingReissue ? (
          <button className={row} onClick={() => void b.study!.cancelReissue?.().then(refresh)} data-study-reissue-pending>
            <RotateCcwIcon className="size-3" /> Next study session redoes {study.pendingReissue} · cancel
          </button>
        ) : redo ? (
          <div className="flex flex-col gap-1 px-2 py-1" data-study-reissue-form>
            <label className="text-xs text-muted-foreground">Redo study session
              <select className={cn(input, "mt-0.5")} value={redo.n} onChange={(e) => setRedo({ ...redo, n: e.target.value, phrase: "" })} data-study-reissue-n>
                {Array.from({ length: assigned }, (_, i) => String(i + 1)).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <input className={input} maxLength={120} placeholder="Reason (optional)" value={redo.reason} onChange={(e) => setRedo({ ...redo, reason: e.target.value })} data-study-reissue-reason />
            <input className={input} autoCapitalize="characters" autoCorrect="off" placeholder={`Type REISSUE ${redo.n} to confirm`} value={redo.phrase} onChange={(e) => setRedo({ ...redo, phrase: e.target.value })} data-study-reissue-phrase />
            <div className="flex gap-1">
              <button className={row} disabled={redo.phrase.trim() !== `REISSUE ${redo.n}`} onClick={() => void submitRedo()} data-study-reissue-submit>Redo session {redo.n}</button>
              <button className={row} onClick={() => setRedo(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className={row} onClick={() => setRedo({ n: String(assigned), reason: "", phrase: "" })} data-study-reissue>
            <RotateCcwIcon className="size-3" /> Redo a study session…
          </button>
        )
      )}
      {b.uploads && uploads && (waiting > 0 || uploads.needsExport > 0) && (
        <button className={row} onClick={() => void uploadNow()} data-uploads>
          <UploadCloudIcon className="size-3" />
          <span className="normal-case">
            {waiting > 0 && `${waiting} log${waiting === 1 ? "" : "s"} waiting to upload${uploads.blocked ? ` (${blockedText[uploads.blocked] ?? uploads.blocked})` : ""}`}
            {waiting > 0 && uploads.needsExport > 0 && " · "}
            {uploads.needsExport > 0 && `${uploads.needsExport} need Export logs`}
          </span>
        </button>
      )}
      {msg && <div role="status" className={cn("px-2 text-xs", msg.error ? "text-red-400" : "text-muted-foreground")}>{msg.text}</div>}
    </div>
  );
}
