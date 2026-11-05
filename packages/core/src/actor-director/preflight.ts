/**
 * E7: preflight health checks with root-cause codes (spec "Preflight health checks with root-cause errors").
 * Runs on mode start, then every 60 s, and is consulted before each Director call. Every check reports its own
 * root cause (HealthCode) plus plain words for the tab's status line; a fallback always says it is a fallback.
 *
 * Logging: the start run logs every check (ok or not) so the record shows what was checked; later runs log only
 * changes (a new failure, a changed code, or a recovery as ok:true code:null). No secret ever reaches a line:
 * the device token is only tested for presence, and every detail string is scrubbed.
 *
 * Before each Director call the session asks directorBlock(): it answers synchronously from the last results
 * (a background refresh starts if they are older than the interval), so the preflight can never eat the
 * 1.5 s Send hold. Gaze failures never block the Director: the pipeline falls back to on-screen time.
 */
import type { BhAdEventBody, HealthCheck, HealthCode, Role, WorkerErrorCode } from "../ad-contracts/index.js";
import { WORKER_CAP_TO_HEALTH } from "../ad-contracts/index.js";
import { ROLE_HEADER } from "../ad-contracts/index.js";

export type HealthLine = Extract<BhAdEventBody, { type: "health" }>;
export type ProbeResult =
  | { ok: true; detail?: string; /** v1.3: an informational code on an ok line (net.worker_blocked) */ code?: HealthCode }
  | { ok: false; code: HealthCode; detail?: string; http_status?: number; worker_code?: WorkerErrorCode; role?: Role }
  | { skip: true };
export interface Probe { check: HealthCheck; run(): ProbeResult | Promise<ProbeResult> }
/** one network probe may answer several checks (GET /v1/models answers worker.reachable, model.route, budget) */
export interface MultiProbe { checks: readonly HealthCheck[]; run(): Promise<Partial<Record<HealthCheck, ProbeResult>>> }

export const PREFLIGHT_INTERVAL_MS = 60_000;
export const PREFLIGHT_PROBE_TIMEOUT_MS = 4_000;

/** codes that stop the Director call (chat continues without notes); everything else degrades gaze only */
export const DIRECTOR_BLOCKING: ReadonlySet<HealthCode> = new Set<HealthCode>([
  "auth.no_token", "net.worker_unreachable", "model.route_unverified", "budget.director_cap", "budget.daily_cap_device",
  "budget.daily_cap_global", "director.kill_switch", "net.request_escaped",
]);
/** v1.3: codes that FAIL the pilot preflight (PreflightReport.pilotFail): the run is not a valid pilot run */
export const PILOT_FAILING: ReadonlySet<HealthCode> = new Set<HealthCode>(["net.request_escaped"]);

const SECRETISH = /\b(bhd_[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+)/g;
export const scrubDetail = (s: string | undefined) => (s === undefined ? undefined : s.replace(SECRETISH, "[redacted]").slice(0, 200));

/** plain words for the tab's status line, per code (detail refines where the spec gives an example) */
export function healthWords(code: HealthCode, detail?: string, http?: number): string {
  switch (code) {
    case "gaze.camera_denied": return "Camera is off in Settings > BrianHarness; using on-screen time only (fallback)";
    case "gaze.arkit_unsupported": return "Face tracking isn't supported on this device; using on-screen time only (fallback)";
    case "gaze.model_missing": return `Face tracker model didn't load from the app bundle${detail ? ` (${detail})` : ""}; using on-screen time only (fallback)`;
    case "gaze.calibration_stale": return detail ?? "Recalibrate (calibration is out of date)";
    case "gaze.thermal_degraded": return "Device warm: gaze at 15 Hz";
    case "gaze.tracker_interrupted": return `Camera tracking stopped${detail ? ` (${detail})` : ""}; using on-screen time only (fallback)`;
    case "gaze.low_quality": return "Gaze too noisy this window; using on-screen time only (fallback)";
    case "gaze.no_consent": return "Camera consent is off; using on-screen time only (fallback)";
    case "net.worker_unreachable": return `Can't reach the BrianHarness server${http ? ` (HTTP ${http})` : detail ? ` (${detail})` : ""}; Director paused, chat continues without notes`;
    case "auth.no_token": return "This device has no access token; Director paused, chat continues without notes";
    case "model.route_unverified": return `Model route not verified${detail ? ` (${detail})` : ""}; Director paused, chat continues without notes`;
    case "model.empty_completion": return "The model sent an empty reply";
    case "model.length_cutoff": return "The model's reply was cut off at the length limit";
    case "budget.director_cap": return "Director paused: daily Director cap reached; chat continues without notes";
    case "budget.actor_cap": return "Daily chat cap reached for this device";
    case "budget.judge_cap": return "Leak judge cap reached: notes are dropped (fail safe); chat continues";
    case "budget.daily_cap_device": return "Director paused: daily cap reached; chat continues without notes";
    case "budget.daily_cap_global": return "Director paused: the server's daily cap is reached; chat continues without notes";
    case "upload.too_large": return "Session log too large to upload (kept on this device)";
    case "upload.rejected": return `Upload refused by the server${detail ? ` (${detail})` : ""} (kept on this device)`;
    case "upload.cap": return "Upload cap reached for today (kept on this device)";
    case "upload.blinded_guard": return "Upload stopped by the blinding guard (kept on this device)";
    case "director.schema_invalid": return "The Director's answer wasn't valid; that turn went without a note";
    case "director.timeout": return "The Director was late; that turn went without a note";
    case "director.kill_switch": return "Director switched off; chat continues without notes";
    case "director.leak_breaker": return "Notes paused for this session (leak breaker); chat continues without notes";
    case "net.worker_blocked": return `The face tracker tried the network and was blocked${detail ? ` (${detail})` : ""}; nothing left the device`;
    case "net.request_escaped": return `A request got past the tracker's network block${detail ? ` (${detail})` : ""}; pilot preflight FAILED; Director paused, chat continues without notes`;
  }
}

// ---- built-in probes ----------------------------------------------------------------------------------------
export type CameraPermission = "granted" | "denied" | "restricted" | "prompt" | "not-determined" | "unknown";
export const cameraPermissionProbe = (get: () => CameraPermission | Promise<CameraPermission>): Probe => ({
  check: "camera.permission",
  async run() {
    const p = await get();
    return p === "denied" || p === "restricted" ? { ok: false, code: "gaze.camera_denied", detail: p } : { ok: true, detail: p };
  },
});
export const consentProbe = (camera: () => boolean): Probe => ({
  check: "consent.camera", run: () => (camera() ? { ok: true } : { ok: false, code: "gaze.no_consent" }),
});
export const arkitProbe = (supported: () => boolean | null): Probe => ({
  check: "arkit.supported", run: () => { const s = supported(); return s === null ? { skip: true } : s ? { ok: true } : { ok: false, code: "gaze.arkit_unsupported" }; },
});
/** Mac: the MediaPipe Face Landmarker model must load from the app bundle (never fetched) */
export interface ModelLoadState { loaded: boolean; source: "bundle" | "none"; error?: string; sha256Ok?: boolean }
export const mediapipeProbe = (get: () => ModelLoadState | null): Probe => ({
  check: "mediapipe.model_loaded",
  run: () => {
    const s = get();
    if (!s) return { skip: true };
    if (s.loaded && s.source === "bundle" && s.sha256Ok !== false) return { ok: true, detail: "bundled" };
    return { ok: false, code: "gaze.model_missing", detail: s.sha256Ok === false ? "sha256 mismatch" : s.error ?? (s.source !== "bundle" ? "not from the bundle" : "not loaded") };
  },
});
export const calibrationProbe = (get: () => { stale: boolean; words: string } | null): Probe => ({
  check: "calibration.valid", run: () => { const s = get(); return !s ? { skip: true } : s.stale ? { ok: false, code: "gaze.calibration_stale", detail: s.words } : { ok: true, detail: s.words }; },
});
export type ThermalState = "nominal" | "fair" | "serious" | "critical";
export const thermalProbe = (get: () => ThermalState | null): Probe => ({
  check: "thermal", run: () => { const t = get(); return t === null ? { skip: true } : t === "serious" || t === "critical" ? { ok: false, code: "gaze.thermal_degraded", detail: t } : { ok: true, detail: t }; },
});
/** tracker running: a sample within the last staleMs, or an explicit interruption reason */
export const trackerProbe = (get: () => { running: boolean; lastSampleAgoMs: number | null; reason?: string } | null, staleMs = 2000): Probe => ({
  check: "tracker.running",
  run: () => {
    const s = get();
    if (!s) return { skip: true };
    if (!s.running) return { ok: false, code: "gaze.tracker_interrupted", detail: s.reason ?? "stopped" };
    if (s.lastSampleAgoMs === null || s.lastSampleAgoMs > staleMs) return { ok: false, code: "gaze.tracker_interrupted", detail: s.reason ?? `no samples for ${s.lastSampleAgoMs === null ? "ever" : `${Math.round(s.lastSampleAgoMs / 100) / 10} s`}` };
    return { ok: true };
  },
});
export const tokenProbe = (hasToken: () => boolean): Probe => ({
  check: "auth.device_token", run: () => (hasToken() ? { ok: true } : { ok: false, code: "auth.no_token" }),
});
/**
 * v1.3 (E7): the Mac shell's no-network rule as a health check. workerBlocked = URLs the gaze Web Worker's fetch block
 * stopped (informational: ok:true, code net.worker_blocked); requests = requests the shell saw at the session layer,
 * i.e. that got PAST the Worker block. Any request to a non-bundle origin -> net.request_escaped (fail; pilot fails).
 */
export const BUNDLE_ORIGIN = "bh-app://app";
export interface NetworkIsolationState { workerBlocked: readonly string[]; requests: ReadonlyArray<{ url: string }> }
const originOf = (u: string) => { try { const x = new URL(u); return x.protocol === "bh-app:" ? `bh-app://${x.host}` : x.origin; } catch { return u.split("/").slice(0, 3).join("/"); } };
export function networkIsolationResult(s: NetworkIsolationState, bundleOrigin = BUNDLE_ORIGIN): ProbeResult {
  const escaped = s.requests.filter((r) => originOf(r.url) !== bundleOrigin);
  if (escaped.length) return { ok: false, code: "net.request_escaped", detail: `${escaped.length} request(s): ${[...new Set(escaped.map((r) => originOf(r.url)))].slice(0, 3).join(", ")}` };
  if (s.workerBlocked.length) return { ok: true, code: "net.worker_blocked", detail: `${s.workerBlocked.length} blocked: ${[...new Set(s.workerBlocked.map(originOf))].slice(0, 3).join(", ")}` };
  return { ok: true };
}
export const networkIsolationProbe = (get: () => NetworkIsolationState | null | Promise<NetworkIsolationState | null>, bundleOrigin = BUNDLE_ORIGIN): Probe => ({
  check: "network.isolation",
  async run() { const st = await get(); return st ? networkIsolationResult(st, bundleOrigin) : { skip: true }; },
});

/** passive: the last reply shape the session saw (model.empty_completion | model.length_cutoff | director.schema_invalid) */
export const replyShapeProbe = (last: () => HealthCode | null | undefined): Probe => ({
  check: "upstream.reply_shape", run: () => { const c = last(); return c === undefined ? { skip: true } : c ? { ok: false, code: c } : { ok: true }; },
});

/**
 * GET {base}/v1/models with the device token (header only, never logged). Answers:
 *  worker.reachable  network error / timeout / non-2xx (not 429) -> net.worker_unreachable (+ http_status)
 *  model.route       each required model listed and not `verified:false` -> else model.route_unverified ("gemma4:cloud verified:false")
 *  budget            429 with a cap code -> its budget.* code (from the Worker 429 body)
 * The Worker's model list is {data:[{id, verified?}]}; `verified` is optional (absent = listed is enough).
 */
export function workerProbe(cfg: {
  baseUrl: string; token: () => string | null; models: () => string[]; fetchImpl?: typeof fetch; timeoutMs?: number; role?: Role;
}): MultiProbe {
  return {
    checks: ["worker.reachable", "model.route", "budget"],
    async run() {
      const token = cfg.token();
      if (!token) return { "worker.reachable": { skip: true }, "model.route": { skip: true }, budget: { skip: true } };
      const f = cfg.fetchImpl ?? ((i, n) => fetch(i, n));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? PREFLIGHT_PROBE_TIMEOUT_MS);
      let res: Response;
      try {
        res = await f(`${cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/models`, {
          headers: { authorization: `Bearer ${token}`, ...(cfg.role ? { [ROLE_HEADER]: cfg.role } : {}) }, signal: ctl.signal,
        });
      } catch (e) {
        const detail = ctl.signal.aborted ? "timeout" : (e as Error)?.name === "TypeError" ? "network error" : String((e as Error)?.message ?? e);
        return { "worker.reachable": { ok: false, code: "net.worker_unreachable", detail }, "model.route": { skip: true }, budget: { skip: true } };
      } finally { clearTimeout(timer); }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (res.status === 429) {
        const err = (body as { error?: { code?: string; role?: Role } } | null)?.error;
        const code = err?.code && (WORKER_CAP_TO_HEALTH as Record<string, HealthCode>)[err.code];
        return {
          "worker.reachable": { ok: true, detail: "429" },
          "model.route": { skip: true },
          budget: code ? { ok: false, code, http_status: 429, worker_code: err!.code as WorkerErrorCode, ...(err?.role ? { role: err.role } : {}) } : { ok: false, code: "budget.daily_cap_device", http_status: 429, detail: "429 without a cap code" },
        };
      }
      if (!res.ok) return { "worker.reachable": { ok: false, code: "net.worker_unreachable", http_status: res.status, ...(res.status === 401 || res.status === 403 ? { detail: "token rejected" } : {}) }, "model.route": { skip: true }, budget: { skip: true } };
      const list = Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: Array<{ id?: unknown; verified?: unknown }> }).data : null;
      if (!list) return { "worker.reachable": { ok: true }, "model.route": { ok: false, code: "model.route_unverified", detail: "model list unreadable" }, budget: { ok: true } };
      const bad: string[] = [];
      for (const m of cfg.models()) {
        const e = list.find((x) => x && x.id === m);
        if (!e) bad.push(`${m} not listed`);
        else if (e.verified === false) bad.push(`${m} verified:false`);
      }
      return { "worker.reachable": { ok: true }, "model.route": bad.length ? { ok: false, code: "model.route_unverified", detail: bad.join(", ") } : { ok: true }, budget: { ok: true } };
    },
  };
}

// ---- runner ---------------------------------------------------------------------------------------------------
export interface PreflightReport {
  reason: "start" | "interval" | "director" | "manual";
  at: number;
  results: Array<{ check: HealthCheck } & ProbeResult>;
  failures: HealthLine[];
  /** first failure in display order, for the tab's status line ("" when all ok) */
  statusLine: string;
  /** the blocking code that pauses the Director, or null */
  directorBlock: HealthCode | null;
  /** v1.3: the first PILOT_FAILING code (the pilot preflight FAILS), or null */
  pilotFail: HealthCode | null;
}

export class Preflight {
  private last = new Map<HealthCheck, string>(); // check -> "ok" | code
  private report: PreflightReport | null = null;
  private running: Promise<PreflightReport> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private o: {
    probes: Array<Probe | MultiProbe>;
    emit: (h: HealthLine) => void;
    now: () => number;
    intervalMs?: number;
    /** extra blocking state outside the probes (e.g. the session's kill switch / caps) */
    external?: () => HealthCode | null;
  }) {}

  get lastReport() { return this.report; }

  run(reason: PreflightReport["reason"]): Promise<PreflightReport> {
    if (this.running) return this.running;
    const p = this.exec(reason).finally(() => { this.running = null; });
    this.running = p;
    return p;
  }

  private async exec(reason: PreflightReport["reason"]): Promise<PreflightReport> {
    const results: PreflightReport["results"] = [];
    const settle = async <T>(fn: () => T | Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch { return fallback; } };
    const outs = await Promise.all(this.o.probes.map(async (p) => {
      if ("check" in p) return [[p.check, await settle<ProbeResult>(() => p.run(), { ok: false, code: probeCrashCode(p.check), detail: "check crashed" })]] as Array<[HealthCheck, ProbeResult]>;
      const r = await settle(() => p.run(), Object.fromEntries(p.checks.map((c) => [c, { ok: false, code: probeCrashCode(c), detail: "check crashed" }])) as Partial<Record<HealthCheck, ProbeResult>>);
      return p.checks.map((c) => [c, r[c] ?? { skip: true }]) as Array<[HealthCheck, ProbeResult]>;
    }));
    const failures: HealthLine[] = [];
    for (const [check, r] of outs.flat()) {
      results.push({ check, ...r });
      if ("skip" in r) continue;
      const line: HealthLine = r.ok
        ? { type: "health", check, ok: true, code: r.code ?? null, ...(r.detail ? { detail: scrubDetail(r.detail)! } : {}) }
        : { type: "health", check, ok: false, code: r.code, ...(r.detail ? { detail: scrubDetail(r.detail)! } : {}), ...(r.http_status ? { http_status: r.http_status } : {}), ...(r.worker_code ? { worker_code: r.worker_code } : {}), ...(r.role ? { role: r.role } : {}) };
      if (!r.ok) failures.push(line);
      const key = r.ok ? (r.code ? `ok:${r.code}` : "ok") : r.code;
      const prev = this.last.get(check);
      if (reason === "start" || (prev !== undefined && prev !== key) || (prev === undefined && (!r.ok || !!r.code))) this.o.emit(line);
      this.last.set(check, key);
    }
    const ext = this.o.external?.() ?? null;
    const block = failures.find((f) => f.code && DIRECTOR_BLOCKING.has(f.code))?.code ?? (ext && DIRECTOR_BLOCKING.has(ext) ? ext : null);
    const first = failures.find((f) => f.code && DIRECTOR_BLOCKING.has(f.code)) ?? failures[0];
    const statusLine = first?.code ? `${first.code}: ${healthWords(first.code, first.detail, first.http_status)}` : "";
    const pilotFail = failures.find((f) => f.code && PILOT_FAILING.has(f.code))?.code ?? null;
    this.report = { reason, at: this.o.now(), results, failures, statusLine, directorBlock: block ?? null, pilotFail };
    return this.report;
  }

  /** synchronous answer before a Director call; refreshes in the background when the last run is stale */
  directorBlock(): HealthCode | null {
    const iv = this.o.intervalMs ?? PREFLIGHT_INTERVAL_MS;
    if (!this.report || this.o.now() - this.report.at >= iv) void this.run("director");
    return this.report?.directorBlock ?? null;
  }

  /** on mode start: one full run, then every intervalMs (unref'd so it never keeps a process alive) */
  async start(): Promise<PreflightReport> {
    const r = await this.run("start");
    if (!this.timer) {
      this.timer = setInterval(() => void this.run("interval"), this.o.intervalMs ?? PREFLIGHT_INTERVAL_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return r;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

function probeCrashCode(check: HealthCheck): HealthCode {
  switch (check) {
    case "camera.permission": return "gaze.camera_denied";
    case "arkit.supported": return "gaze.arkit_unsupported";
    case "mediapipe.model_loaded": return "gaze.model_missing";
    case "calibration.valid": return "gaze.calibration_stale";
    case "thermal": return "gaze.thermal_degraded";
    case "tracker.running": case "gaze.window_quality": return "gaze.tracker_interrupted";
    case "consent.camera": return "gaze.no_consent";
    case "auth.device_token": return "auth.no_token";
    case "model.route": return "model.route_unverified";
    case "budget": return "budget.daily_cap_device";
    case "upload": return "upload.rejected";
    case "director.deadline": return "director.timeout";
    case "director.enabled": return "director.kill_switch";
    case "director.leak_breaker": return "director.leak_breaker";
    case "upstream.reply_shape": return "model.empty_completion";
    case "network.isolation": return "net.request_escaped"; // fail closed: an unproven no-network rule fails the pilot
    default: return "net.worker_unreachable";
  }
}
