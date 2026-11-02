// POST /v1/sessions against a local Worker (wrangler dev --local, throwaway --var secrets) through the app's
// own UploadQueue: study session + study_start upload, byte-identical read-back, 409 = done, client retry rule
// (4xx -> needs-export, 401 pauses), no unknown fields. Called by spider-local.mjs --sessions, or by the mock test.
//   runSessions({ W, admin, check, core, adminSecret })
//     W: Worker origin; admin(...args): scripts/admin.mjs runner (issue/revoke); check(ok, msg); core: core dist module;
//     adminSecret: the throwaway BH_ADMIN_SECRET (for GET /v1/sessions read-back).
export async function runSessions({ W, admin, check, core, adminSecret, fetchImpl = fetch, log = console.log }) {
  const issued = admin("issue", "sessions-local");
  const token = issued.match(/bhd_[A-Za-z0-9_-]+/)?.[0];
  const devId = issued.match(/\bid[:= ]+\s*"?([0-9a-f]{8,})/i)?.[1] ?? issued.match(/\b([0-9a-f]{16})\b/)?.[1];
  check(!!token, "sessions: admin CLI issued a device token");
  const url = `${core.normalizeSpiderUrl(W)}/v1/sessions`;
  const target = { v: { url, token } };
  const mem = () => new core.MemoryKV();
  const meta = { appVersion: "0.1.0", platform: "spider-local", build: "local" };
  const q = new core.UploadQueue(mem(), { meta, fetchImpl, autoSchedule: false, target: async () => target.v });

  // a real study session through the harness (mock backend: no model calls)
  const storage = new core.MemoryHarnessStorage();
  const study = new core.StudyController(mem(), mem(), { randomSeed: () => 4242 });
  const sch = await study.enable();
  const host = new core.HarnessHost({ userId: "u", storage, backend: async () => new core.MockBackend(1), study, seed: () => 7 });
  const r = await host.newSession();
  for (const t of ["my sourdough starter", "the baseline of my week is calm", "adaptive cruise control is neat", "rye flour again"]) await host.reply({ text: t });
  await host.rate({ scope: "session", value: 4, shownAt: 1, answeredAt: 2, blindGuess: "adaptive" });
  await host.end();
  const file = host.sessionFile(r.sessionId);

  await q.enqueueSession(file);
  await q.enqueueStudyStart({ scheduleHash: sch.scheduleHash, nSessions: 10, createdAt: sch.createdAt, protocol: sch.protocol });
  let s = await q.flush();
  check(s.done === 2 && s.pending === 0 && s.needsExport === 0, `sessions: study session + study_start uploaded via UploadQueue (done ${s.done}, pending ${s.pending}, needs-export ${s.needsExport})`);

  const auth = { authorization: `Bearer ${adminSecret}` };
  const got = await fetchImpl(`${url}/${encodeURIComponent(r.sessionId)}`, { headers: auth });
  const bytes = Buffer.from(await got.arrayBuffer());
  check(got.status === 200 && bytes.equals(Buffer.from(file.content, "utf8")), `sessions: GET /v1/sessions/:id is byte-identical to the export file (${bytes.length} B)`);
  const ss = await (await fetchImpl(`${url}/phaseD-${sch.scheduleHash.slice(0, 16)}`, { headers: auth })).json().catch(() => ({}));
  check(ss.kind === "study_start" && ss.protocol === sch.protocol && ss.nSessions === 10, `sessions: study_start stored with protocol ${ss.protocol}`);
  const list = await (await fetchImpl(`${url}?limit=10`, { headers: auth })).json().catch(() => ({ data: [] }));
  const row = (list.data ?? []).find((x) => x.id === r.sessionId);
  check(row?.study_index === 1 && row?.schedule_hash === sch.scheduleHash && !JSON.stringify(list).includes(token), "sessions: list row has study_index/schedule_hash, never the device token");

  // re-upload the same session -> 409 session_exists -> done
  const q2 = new core.UploadQueue(mem(), { meta, fetchImpl, autoSchedule: false, target: async () => target.v });
  await q2.enqueueSession(file);
  s = await q2.flush();
  check(s.done === 1 && s.items.length === 0, `sessions: re-upload -> 409 session_exists counts as done (${JSON.stringify(s)})`);

  // a study session leaking its arm (structured key) -> 422 upload_rejected -> needs-export, never retried
  const leaky = { ...file, content: file.content.replace(/\{"type":"session_start","t":"[^"]+","sessionId":"[^"]+"/, (m) => m.replace(/"sessionId":"([^"]+)"/, '"sessionId":"$1-leak"')) };
  const leakLines = leaky.content.split("\n").map((l) => { if (!l.includes('"type":"session_start"')) return l; const o = JSON.parse(l); o.adaptation = "baseline"; return JSON.stringify(o); });
  const q3 = new core.UploadQueue(mem(), { meta, fetchImpl, autoSchedule: false, target: async () => target.v });
  await q3.enqueueSession({ ...leaky, content: leakLines.join("\n") });
  s = await q3.flush();
  check(s.needsExport === 1 && /422/.test(s.items[0]?.lastError ?? ""), `sessions: arm leak -> needs-export (${s.items[0]?.lastError})`);

  // body shape: an unknown field is refused (the app never sends one)
  const bad = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...core.sessionUploadBody(file.content, meta), protocol: 2 }) });
  check(bad.status === 400, `sessions: unknown field in a session body -> ${bad.status}`);
  check(Object.keys(core.sessionUploadBody(file.content, meta)).every((k) => core.SESSION_UPLOAD_KEYS.includes(k)), "sessions: app body uses allowlisted keys only");

  // manual reissue reason: informational (needs the Worker exemption for session_start.reissueReason)
  {
    const lines = file.content.split("\n").map((l) => { if (!l.includes('"type":"session_start"')) return l; const o = JSON.parse(l); o.sessionId += "-rr"; Object.assign(o, { reissueOf: "manual", manualReissue: true, reissueReason: "baseline" }); return JSON.stringify(o); });
    const body = core.sessionUploadBody(lines.join("\n"), meta);
    const res = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    log(`INFO  sessions: reissueReason "baseline" -> ${res.status} ${j.error?.code ?? j.error ?? ""} ${j.error?.reason ?? ""} (needs Worker exemption if 422 blinding:arm_value)`);
  }

  // 401 after revoke: the queue keeps the item and pauses until the token changes
  if (devId) admin("revoke", devId);
  const host2 = new core.HarnessHost({ userId: "u", storage, backend: async () => new core.MockBackend(1), study, seed: () => 8 });
  const r2 = await host2.newSession();
  await host2.reply({ text: "one more turn" });
  await host2.end();
  const q4 = new core.UploadQueue(mem(), { meta, fetchImpl, autoSchedule: false, target: async () => target.v });
  await q4.enqueueSession(host2.sessionFile(r2.sessionId));
  s = await q4.flush();
  check(!devId || (s.pending === 1 && s.blocked === "auth"), `sessions: revoked token -> 401 keeps the log queued (blocked ${s.blocked})`);
}
