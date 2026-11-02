// BHExport (IOS Dev's Capacitor plugin), contract verified in the simulator Nov 2:
//   share({files:[{name, content, mimeType?}]})   -> {completed, activityType?}; dismissing the
//                                                    sheet resolves completed:false (NOT an error)
//   saveToDocuments({files:[{name, content}]})    -> {dir, paths[]}; overwrites same-name files
// Names must be plain file names (non-empty, not "."/"..", no leading dot, no / or \, unique within
// one call) or the call rejects with EINVAL; content is one UTF-8 string per file.
// Rejection codes: EINVAL, EWRITE, EPRESENT, ESHARE.
import { plainFiles, type ExportFile } from "@brianharness/core/browser";
import type { BHExportPlugin, ExportResult } from "./types";

export const BH_EXPORT_MESSAGES: Record<string, string> = {
  EINVAL: "Export failed: the app passed an invalid file name or file (a bug; please report it).",
  EWRITE: "Couldn't write the log files (storage full or not writable).",
  EPRESENT: "Couldn't open the share sheet right now. Close any open sheet and try again.",
  ESHARE: "Sharing failed. Try again, or pick a different destination.",
};
export function bhExportErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && BH_EXPORT_MESSAGES[code]) return BH_EXPORT_MESSAGES[code]!;
  return `Export failed: ${String((err as Error)?.message ?? err)}`;
}

/** Older placeholder shape ({name, mime, text}) -> contract shape ({name, content, mimeType}). */
export function toExportFile(f: { name: string; content?: string; text?: string; mimeType?: string; mime?: string }): ExportFile {
  const content = typeof f.content === "string" ? f.content : typeof f.text === "string" ? f.text : "";
  const mimeType = f.mimeType ?? f.mime;
  return { name: f.name, content, ...(mimeType ? { mimeType } : {}) };
}

/** "Export logs" via the share sheet. Never throws: errors come back as a friendly `error`. */
export async function shareViaBHExport(plugin: BHExportPlugin, files: ExportFile[]): Promise<ExportResult> {
  const plain = plainFiles(files.map(toExportFile));
  try {
    const r = await plugin.share({ files: plain });
    if (!r?.completed) return { ok: false, files: plain.length, via: "share-sheet", dismissed: true };
    return { ok: true, files: plain.length, via: "share-sheet", ...(r.activityType ? { detail: r.activityType } : {}) };
  } catch (err) {
    return { ok: false, files: plain.length, via: "share-sheet", error: bhExportErrorMessage(err), code: String((err as { code?: unknown })?.code ?? "") || undefined };
  }
}

/** Session-end autosave into Documents (visible in the Files app). Never throws. */
export async function saveViaBHExport(plugin: BHExportPlugin, files: ExportFile[]): Promise<{ ok: boolean; paths?: string[]; error?: string }> {
  const plain = plainFiles(files.map(toExportFile)).map(({ name, content }) => ({ name, content }));
  try {
    const r = (await plugin.saveToDocuments({ files: plain })) as { dir?: string; paths?: string[] } | undefined;
    return { ok: true, paths: r?.paths ?? [] };
  } catch (err) {
    const error = bhExportErrorMessage(err);
    console.warn(`[brianharness] saveToDocuments: ${error}`);
    return { ok: false, error };
  }
}
