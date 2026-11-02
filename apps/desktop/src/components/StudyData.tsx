import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, FlaskConicalIcon } from "lucide-react";
import { bridge, type StudyStatusView } from "../bridge";
import { cn } from "../lib";

// Settings > data: "Export logs" (session JSONL + interest map) and the Phase D study switch.
// Shows only the study's progress, never its schedule or a session's condition.
export function StudyData() {
  const b = bridge();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [study, setStudy] = useState<StudyStatusView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const refresh = useCallback(async () => { if (b.study) setStudy(await b.study.status().catch(() => null)); }, [b]);
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
  const row = "eeg-tap-row flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";
  return (
    <div className="mb-2 flex flex-col gap-0.5" data-study-data>
      {b.exportLogs && <button className={row} onClick={() => void exportLogs()} disabled={busy} data-export-logs><DownloadIcon className="size-3" /> {busy ? "Exporting…" : "Export logs"}</button>}
      {b.study && study && (
        <button className={row} onClick={() => void toggleStudy()} data-study-toggle>
          <FlaskConicalIcon className="size-3" />
          {study.enabled ? `Study ${Math.min(study.next, study.total)}/${study.total} · stop` : confirm ? "Tap again to start the 10-session study" : study.next > study.total ? "Study complete" : "Start study"}
        </button>
      )}
      {msg && <div role="status" className={cn("px-2 text-xs", msg.error ? "text-red-400" : "text-muted-foreground")}>{msg.text}</div>}
    </div>
  );
}
