/**
 * Minimal ZIP writer (STORE, no compression, no dependencies) for "Export logs": session JSONL
 * files + the interest map in one download / save-dialog file. Text only; UTF-8 names.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ExportFile {
  name: string;
  content: string;
  mimeType?: string;
}

export function zipFiles(files: ExportFile[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    const local = concat([new Uint8Array(lh.buffer), name, data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(concat([new Uint8Array(ch.buffer), name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cd.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, cd, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- plain file names (BHExport contract) ----
// BHExport.share / saveToDocuments reject (EINVAL) a name that is empty, "." or "..", starts with a
// dot, contains / or \, or repeats within one call. These helpers make any name conform.

/** One plain, safe file name (keeps the extension; path parts become "_"). */
export function plainFileName(name: string, fallback = "file"): string {
  let n = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (!n || n === "." || n === "..") n = fallback;
  if (n.length > 180) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

/** Flatten (basename), sanitize and de-duplicate names: x.jsonl, x-2.jsonl, ... */
export function plainFiles<T extends { name: string }>(files: T[]): T[] {
  const seen = new Set<string>();
  return files.map((f) => {
    const base = plainFileName(String(f.name ?? "").split(/[/\\]/).filter(Boolean).pop() ?? "");
    let n = base;
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    for (let i = 2; seen.has(n.toLowerCase()); i++) n = `${stem}-${i}${ext}`;
    seen.add(n.toLowerCase());
    return { ...f, name: n };
  });
}

/** "2026-11-02T22:06:12.345Z" -> "20261102T220612Z" */
export const compactIso = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "") : "unknown";
};

/**
 * Stable, unique per-session export name: bh-session-<studyIdx>-<startISO-compact>.jsonl in a
 * study session, bh-session-<startISO-compact>.jsonl otherwise. Stable because
 * saveToDocuments overwrites same-name files: re-saving a session replaces its own file only.
 */
export function sessionExportName(start: { t?: string; study?: { index?: number } } | undefined, sessionId: string): string {
  const when = start?.t ? compactIso(start.t) : plainFileName(sessionId, "session");
  const idx = start?.study?.index;
  return plainFileName(`bh-session-${typeof idx === "number" ? `${String(idx).padStart(2, "0")}-` : ""}${when}.jsonl`);
}
