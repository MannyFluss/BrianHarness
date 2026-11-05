// contract-v1.3 (E7, ruling C): the Director Mac shell's network.isolation verdict, shared by ad-main.mjs (H1 report)
// and the tests. Same rule as core preflight networkIsolationResult:
//   requests     = requests the shell's session guard saw, i.e. that got PAST the gaze Worker's fetch block (the guard
//                  cancels them; only non-bundle schemes reach this log)  -> any to a non-bundle origin: net.request_escaped
//                  (ok:false; the pilot preflight FAILS)
//   workerBlocked = URLs the Worker refused itself                          -> net.worker_blocked (ok:true, informational)
export const BUNDLE_ORIGIN = "bh-app://app";
const originOf = (u) => { try { const x = new URL(u); return x.protocol === "bh-app:" ? `bh-app://${x.host}` : x.origin; } catch { return String(u).split("/").slice(0, 3).join("/"); } };
export function networkVerdict({ requests = [], workerBlocked = [] }, bundleOrigin = BUNDLE_ORIGIN) {
  const escaped = requests.filter((r) => originOf(r.url) !== bundleOrigin);
  if (escaped.length) return { check: "network.isolation", ok: false, code: "net.request_escaped", pilotFail: "net.request_escaped", escaped: escaped.length, origins: [...new Set(escaped.map((r) => originOf(r.url)))].slice(0, 5) };
  if (workerBlocked.length) return { check: "network.isolation", ok: true, code: "net.worker_blocked", pilotFail: null, escaped: 0, origins: [...new Set(workerBlocked.map(originOf))].slice(0, 5) };
  return { check: "network.isolation", ok: true, code: null, pilotFail: null, escaped: 0, origins: [] };
}

// E7c: camera permission decision (pure, unit-tested). Node's WHATWG URL reports origin "null" for custom schemes
// (bh-app is "standard" only inside Chromium), which denied getUserMedia in H1 Run A. Parse scheme://host ourselves.
export const AD_ORIGIN = "bh-app://app";
export function adOriginOf(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(String(url ?? ""));
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : "null";
}
// grant media only to our own window's webContents, on bh-app://app, video only (any audio -> deny)
export function isAllowedMediaRequest({ permission, isOwnWebContents, wcUrl, requestingUrl, origin, mediaTypes }) {
  if (permission !== "media" || !isOwnWebContents) return false;
  if (adOriginOf(wcUrl) !== AD_ORIGIN) return false;
  const reqOrigin = requestingUrl ? adOriginOf(requestingUrl) : origin && origin !== "null" ? adOriginOf(origin + "/") : AD_ORIGIN;
  if (reqOrigin !== AD_ORIGIN) return false;
  const types = mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === "video");
}
