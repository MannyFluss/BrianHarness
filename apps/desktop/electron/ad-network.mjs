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
