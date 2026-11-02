// tools/spider-local/sessions-local.mjs against an in-memory fake of the Worker's /v1/sessions (no wrangler,
// no network). The real run: node tools/spider-local/spider-local.mjs --sessions (wrangler dev --local).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as core from "@brianharness/core";
// @ts-expect-error untyped tool module
import { runSessions } from "../../../tools/spider-local/sessions-local.mjs";

const SESSION_KEYS = new Set(["kind", "sessionId", "studyIndex", "scheduleHash", "appVersion", "platform", "build", "jsonl"]);
const STUDY_KEYS = new Set(["kind", "id", "scheduleHash", "nSessions", "appVersion", "build", "platform", "createdAt", "protocol"]);

function fakeWorker() {
  const ADMIN = "fake-admin";
  const devices = new Map<string, { token: string; revoked: boolean }>();
  const items = new Map<string, { kind: string; bytes: Buffer; json?: unknown; row: Record<string, unknown> }>();
  let seq = 0;
  // Worker http.ts err(): OpenAI-style {error:{message,type,code,...extra}}
  const e = (code: string, extra: Record<string, unknown> = {}) => ({ error: { message: code, type: "invalid_request_error", code, ...extra } });
  const res = (status: number, body: unknown, ct = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": ct } });
  const leaks = (o: Record<string, unknown>) => "adaptation" in o || (o.study && typeof o.study === "object" && "mode" in (o.study as object));
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /, "");
    if (init.method === "POST") {
      const dev = [...devices.entries()].find(([, d]) => d.token === auth);
      if (!dev || dev[1].revoked) return res(401, e("unauthorized"));
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      const keys = b.kind === "study_start" ? STUDY_KEYS : SESSION_KEYS;
      if (Object.keys(b).some((k) => !keys.has(k))) return res(400, e("invalid_upload", { permanent: true }));
      const id = String(b.kind === "study_start" ? b.id : b.sessionId);
      if (items.has(id)) return res(409, e("session_exists", { permanent: true }));
      if (b.kind !== "study_start") for (const l of String(b.jsonl).split("\n").filter(Boolean)) if (leaks(JSON.parse(l))) return res(422, e("upload_rejected", { reason: "blinding:arm_key", permanent: true }));
      const bytes = Buffer.from(b.kind === "study_start" ? JSON.stringify(b) : String(b.jsonl), "utf8");
      let studyIndex: unknown = b.studyIndex ?? null;
      items.set(id, { kind: String(b.kind ?? "session"), bytes, json: b.kind === "study_start" ? b : undefined, row: { seq: ++seq, id, kind: b.kind ?? "session", study_index: studyIndex, schedule_hash: b.scheduleHash ?? null, protocol: b.protocol ?? null, sha256: createHash("sha256").update(bytes).digest("hex") } });
      return res(201, { id });
    }
    if (auth !== ADMIN) return res(401, e("unauthorized"));
    const m = url.pathname.match(/^\/v1\/sessions\/(.+)$/);
    if (m) { const it = items.get(decodeURIComponent(m[1]!)); if (!it) return res(404, e("session_not_found")); return it.json ? res(200, it.json) : new Response(new Uint8Array(it.bytes), { status: 200 }); }
    return res(200, { object: "list", data: [...items.values()].map((i) => i.row) });
  }) as unknown as typeof fetch;
  const admin = (cmd: string, arg: string) => {
    if (cmd === "issue") { const id = createHash("sha256").update(arg + devices.size).digest("hex").slice(0, 16); const token = `bhd_${"x".repeat(8)}${id}`; devices.set(id, { token, revoked: false }); return `device id:   ${id}\nname:        ${arg}\ntoken:       ${token}\n`; }
    if (cmd === "revoke") { devices.get(arg)!.revoked = true; return "revoked"; }
    throw new Error(cmd);
  };
  return { f, admin, ADMIN, items };
}

test("sessions-local.mjs passes against a fake Worker (mock): upload, byte-identical read-back, 409, 422, 400, 401", async () => {
  const w = fakeWorker();
  const results: Array<[boolean, string]> = [];
  const logs: string[] = [];
  await runSessions({ W: "http://fake-worker.test", admin: w.admin, check: (ok: boolean, msg: string) => results.push([ok, msg]), core, adminSecret: w.ADMIN, fetchImpl: w.f, log: (s: string) => logs.push(s) });
  const failed = results.filter(([ok]) => !ok);
  assert.deepEqual(failed, [], failed.map(([, m]) => m).join("\n"));
  assert.ok(results.length >= 10, `${results.length} checks`);
  assert.ok(logs.some((l) => /reissueReason/.test(l)));
});
