#!/usr/bin/env node
// Headless check of the in-app bug report on the built web bundle (iOS-like shell with a fake window.Capacitor
// and a fake BHExport share sheet). No live endpoint is called: Playwright answers every api.strangeriver.org
// request locally (chat, models, /v1/feedback).
//   Run 1 (iPhone): the opener, then a very long reply cut off at max_tokens (finish_reason "length"). Checks that
//     the cut-off note clears the composer (scroll nit). Then sidebar -> Report -> note -> Send. /v1/feedback
//     answers 404 (Worker not deployed), so the report goes out through BHExport share. Checks the session log
//     bracket feedback_open -> feedback_sent -> feedback_closed.
//   Run 2 (iPad + hardware keyboard): Cmd+Shift+R -> Cancel (open -> closed {sent:false}), then Cmd+Shift+R -> Send with
//     /v1/feedback answering 201. Saves the exact POST body.
// Deps: PLAYWRIGHT_CORE (dir of playwright-core), CHROME (default /usr/bin/google-chrome). Output: --out
// (default /workspace/feedback-verify).
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dist = new URL("../dist-web/", import.meta.url).pathname;
const OUT = resolve(arg("--out", "/workspace/feedback-verify"));
mkdirSync(OUT, { recursive: true });
const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(join(dist, "index.html"))) throw new Error("build first: npm run build:web");
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${web.address().port}/`;
const API = "https://api.strangeriver.org";

const LONG = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: a sourdough starter is a living culture of wild yeast and lactic acid bacteria, and feeding it on a schedule keeps it lively and predictable for baking day.`).join("\n\n") + "\n\nAnd the last step, the one that matters most, is to let the";

const shell = ({ settings, ios }) => {
  localStorage.setItem("brianharness/settings", JSON.stringify(settings));
  localStorage.setItem("brianharness/credentials/spider", JSON.stringify({ type: "api_key", key: "placeholder-device-token" }));
  localStorage.setItem("brianharness/llm-extract/calls", JSON.stringify({ calls: 50, max: 50 })); // extractor off
  window.__shared = [];
  if (ios) {
    const BHExport = {
      share: async ({ files }) => { window.__shared.push(files); return { completed: true, activityType: "com.apple.DocumentManagerUICore.SaveToFiles" }; },
      saveToDocuments: async () => ({ dir: "/Documents", paths: [] }),
    };
    window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => n === "BHExport", Plugins: { BHExport } };
  }
};

async function run({ name, viewport, ios, feedbackStatus, ua }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: !!ios, hasTouch: !!ios, ...(ua ? { userAgent: ua } : {}), serviceWorkers: "block", acceptDownloads: true });
  const posts = [];
  let chatN = 0;
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === url.slice(0, -1) || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    if (u.origin !== API) { failures.push(`non-local request ${u.origin}`); return route.abort("blockedbyclient"); }
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (status, body, extra = {}) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
    if (u.pathname === "/v1/models") return json(200, { data: [{ id: "gpt-oss:20b-cloud" }] });
    if (u.pathname === "/v1/chat/completions") {
      const n = ++chatN;
      const body = JSON.parse(req.postData() ?? "{}");
      const cut = n === 2;
      const content = cut ? LONG : "Hi! What has been on your mind lately, something you made, played, read or wondered about?";
      if (body.stream) {
        const fr = cut ? "length" : "stop";
        const chunks = content.match(/[\s\S]{1,400}/g).map((c) => ({ id: `c${n}`, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }));
        chunks.push({ id: `c${n}`, choices: [{ index: 0, delta: {}, finish_reason: fr }], usage: { prompt_tokens: 812, completion_tokens: cut ? body.max_tokens ?? 2048 : 24 } });
        return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n" });
      }
      return json(200, { id: `c${n}`, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: cut ? "length" : "stop" }], usage: { prompt_tokens: 812, completion_tokens: cut ? body.max_tokens ?? 2048 : 24 } });
    }
    if (u.pathname === "/v1/feedback") {
      posts.push({ auth: req.headers()["authorization"]?.replace(/Bearer\s+\S+/, "Bearer <device token>"), body: req.postData() });
      if (feedbackStatus === 201) return json(201, { id: JSON.parse(req.postData()).report_id, received_at: new Date().toISOString() });
      return json(404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
    }
    return json(404, { error: { code: "not_found" } });
  });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript(shell, { settings: { provider: "spider-cloud", model: "gpt-oss:20b-cloud", spiderCloudUrl: API }, ios });
  await page.goto(url);
  await page.waitForSelector("textarea", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-msg-role='assistant']").length >= 1 && !document.querySelector("[data-streaming]"), null, { timeout: 30_000 });
  return { ctx, page, posts, errs };
}

const sessionLog = (page) => page.evaluate(async () => {
  // the in-process storage (IndexedDB / localStorage KV): find the session JSONL lines with feedback_* records
  const out = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); const v = localStorage.getItem(k) ?? ""; if (v.includes("feedback_open")) out.push(v); }
  if (out.length) return out.join("\n");
  const dbs = (await indexedDB.databases?.()) ?? [];
  for (const d of dbs) {
    const db = await new Promise((r, j) => { const q = indexedDB.open(d.name); q.onsuccess = () => r(q.result); q.onerror = j; });
    for (const s of db.objectStoreNames) {
      const all = await new Promise((r) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
      for (const v of all) { const t = typeof v === "string" ? v : JSON.stringify(v); if (t.includes("feedback_open")) out.push(t); }
    }
  }
  return out.join("\n");
});
const fbLines = (raw) => raw.split(/\\n|\n/).map((l) => l.replace(/\\"/g, '"')).filter((l) => /"type":"feedback_/.test(l)).map((l) => JSON.parse(l.slice(l.indexOf("{"), l.lastIndexOf("}") + 1)));

const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const summary = {};
try {
  // ---------------- run 1: iPhone, cut-off reply, sidebar Report, 404 -> BHExport share
  {
    const { ctx, page, errs } = await run({ name: "iphone", viewport: { width: 393, height: 852 }, ios: true, feedbackStatus: 404, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" });
    await page.fill("textarea", "Teach me sourdough, in as much detail as you can.");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-reply-cutoff]", { timeout: 30_000 });
    await page.waitForTimeout(900);
    const geo = await page.evaluate(() => {
      const note = document.querySelector("[data-reply-cutoff]").getBoundingClientRect();
      const ta = document.querySelector("textarea").getBoundingClientRect();
      const dock = document.querySelector(".eeg-composer-dock");
      const firstVisible = [...dock.querySelectorAll("*")].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).reduce((m, r) => Math.min(m, r.top), Infinity);
      const sc = document.querySelector("[data-transcript]").parentElement;
      return { noteBottom: note.bottom, composerTop: Math.min(ta.top, firstVisible), atBottom: sc.scrollHeight - sc.clientHeight - sc.scrollTop };
    });
    check(geo.noteBottom <= geo.composerTop && geo.atBottom < 4, `scroll nit: the cut-off note clears the composer (note bottom ${geo.noteBottom.toFixed(0)} <= composer top ${geo.composerTop.toFixed(0)}; ${geo.atBottom.toFixed(0)}px from the bottom)`);
    await page.screenshot({ path: join(OUT, "01-cutoff-reply-iphone.png") });
    // sidebar -> Report
    await page.click("button[aria-label='Open sidebar']");
    await page.waitForSelector("[data-feedback-row]", { state: "visible", timeout: 5000 });
    await page.screenshot({ path: join(OUT, "02-sidebar-report-row-iphone.png") });
    await page.click("[data-feedback-row]");
    await page.waitForSelector("[role='dialog'][aria-label='Report a problem']", { timeout: 5000 });
    await page.fill("[data-feedback-sheet] textarea", "The long reply stopped mid-sentence and the cut-off note was hidden behind the composer.");
    await page.screenshot({ path: join(OUT, "03-report-sheet-iphone.png") });
    await page.click("[data-feedback-send]");
    await page.waitForSelector("[data-feedback-status][data-state='exported']", { timeout: 15_000 });
    await page.screenshot({ path: join(OUT, "04-export-fallback-iphone.png") });
    const shared = await page.evaluate(() => window.__shared);
    check(shared.length === 1 && shared[0].length === 1 && /^bh-feedback-\d{8}-\d{4}-[0-9a-f]{8}\.json$/.test(shared[0][0].name), `404 -> one .json through BHExport share (${shared[0]?.[0]?.name})`);
    const report = JSON.parse(shared[0][0].data ?? shared[0][0].content);
    writeFileSync(join(OUT, "report-404-export.json"), JSON.stringify(report, null, 2) + "\n");
    const chat = report.payload.events.filter((e) => e.type === "chat");
    check(chat.some((e) => e.data.finish_reason === "length" && e.data.truncated === true && e.data.max_tokens > 0), "report: chat event with finish_reason length, truncated, max_tokens");
    check(report.filters.truncated_turns >= 1 && report.filters.platform === "ios" && report.kind === "bug", `envelope filters ${JSON.stringify(report.filters)}`);
    check(report.payload.chat_turns.some((t) => t.cutOff), "report: the cut-off chat turn is flagged");
    check(report.payload.events.some((e) => e.type === "tap" && /report/i.test(e.data.name ?? "")), "report: the Report tap was recorded");
    check(!/placeholder-device-token/.test(JSON.stringify(report)), "report: no device token");
    check(report.payload.header.counts.bytes <= 100 * 1024, `report size ${report.payload.header.counts.bytes} B <= 100 KB`);
    await page.click("[data-feedback-done]");
    await page.waitForTimeout(300);
    const fb = fbLines(await sessionLog(page));
    check(fb.map((e) => e.type).join(">") === "feedback_open>feedback_sent>feedback_closed" && fb[1]?.report_id === report.report_id && fb[2]?.sent === true, `session log: ${fb.map((e) => e.type + (e.sent !== undefined ? `{sent:${e.sent}}` : "")).join(" -> ")}`);
    summary.iphone = { report_id: report.report_id, bytes: report.payload.header.counts.bytes, events: report.payload.events.length, log: fb };
    // session rating (New chat -> "Overall, how absorbed were you?"): rate 4, then report again -> no rating value
    await page.click("button[aria-label='Open sidebar']");
    await page.getByRole("button", { name: /new chat/i }).first().click();
    await page.waitForSelector("[data-rating-probe='session'] [data-rating-option]", { timeout: 5000 });
    await page.locator("[data-rating-probe='session'] [data-rating-option]").nth(3).click();
    await page.fill("[data-rating-probe='session'] textarea", "tide pools hooked me");
    await page.waitForTimeout(700); // let the screen recorder snapshot the checked card
    await page.screenshot({ path: join(OUT, "08-session-rating-iphone.png") });
    await page.evaluate(() => window.__bhReport({ source: "hook" })); // the sheet over the rating card
    await page.waitForSelector("[role='dialog'][aria-label='Report a problem']", { timeout: 5000 });
    await page.click("[data-feedback-send]");
    await page.waitForSelector("[data-feedback-status][data-state='exported']", { timeout: 15_000 });
    const shared2 = await page.evaluate(() => window.__shared);
    const r2 = JSON.parse(shared2[1][0].data ?? shared2[1][0].content);
    writeFileSync(join(OUT, "report-with-session-rating.json"), JSON.stringify(r2, null, 2) + "\n");
    const b2 = JSON.stringify(r2.payload.events);
    const ratingScreens = r2.payload.events.filter((e) => e.type === "screen" && e.data.overlays?.includes("session-rating"));
    const ratingCtl = ratingScreens.flatMap((e) => e.data.controls).filter((c) => /^(?:rating option|rating control|rating text field|blinding-check option)$/.test(c.label));
    const ratingTaps = r2.payload.events.filter((e) => e.type === "tap" && e.data.screen === "session-rating");
    check(ratingScreens.length >= 1 && ratingCtl.filter((c) => c.label === "rating option").length === 5 && ratingCtl.every((c) => Object.keys(c).sort().join() === "control,label")
      && ratingTaps.length >= 1 && ratingTaps.every((e) => /^(?:rating option|rating control|rating text field)$/.test(e.data.name) && Object.keys(e.data).sort().join() === "control,name,screen")
      && !/"checked"|"selected"|"(?:name|label)":"\s*[1-5]\s*"|tide pools hooked|Absorption|not at all|completely|absorbed/.test(b2),
      `rating: the session-rating card is in the report only as generic controls (${ratingScreens.length} screen, ${ratingCtl.length} generic controls, taps ${ratingTaps.map((e) => e.data.name).join(", ")}; no value / checked / label / hooked text)`);
    await page.click("[data-feedback-done]");
    check(!errs.length, `no page errors (${errs.join("; ")})`);
    await ctx.close();
  }
  // ---------------- run 2: iPad with a hardware keyboard, Cmd+Shift+R -> Cancel, then Cmd+Shift+R -> Send with 201
  {
    const { ctx, page, posts, errs } = await run({ name: "ipad-keyboard", viewport: { width: 1180, height: 820 }, ios: true, feedbackStatus: 201, ua: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" });
    await page.fill("textarea", "Teach me sourdough, in as much detail as you can.");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-reply-cutoff]", { timeout: 30_000 }).catch(async (e) => { await page.screenshot({ path: "/tmp/fbv-desktop-fail.png" }); console.log(await page.evaluate(() => document.body.innerText.slice(-1500))); throw e; });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, "05-cutoff-reply-ipad.png") });
    await page.focus("textarea");
    await page.keyboard.press("Meta+Shift+R");
    await page.waitForSelector("[role='dialog'][aria-label='Report a problem']", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog'][aria-label='Report a problem']", { state: "detached", timeout: 5000 });
    await page.keyboard.press("Control+Shift+R");
    await page.waitForSelector("[role='dialog'][aria-label='Report a problem']", { timeout: 5000 });
    await page.fill("[data-feedback-sheet] textarea", "Reply cut off again (iPad, hardware keyboard).");
    await page.screenshot({ path: join(OUT, "06-report-sheet-ipad.png") });
    await page.click("[data-feedback-send]");
    await page.waitForSelector("[data-feedback-status][data-state='sent']", { timeout: 15_000 });
    await page.screenshot({ path: join(OUT, "07-report-sent-ipad.png") });
    check(posts.length === 1 && posts[0].auth === "Bearer <device token>", `one POST /v1/feedback with the device token (${posts.length})`);
    const body = posts[0]?.body ?? "{}";
    writeFileSync(join(OUT, "report-201-posted-body.json"), body);
    const r = JSON.parse(body);
    check(r.schema === "brianharness-feedback/1" && r.payload.header.trigger === "shortcut" && r.filters.platform === "ios", `201 body: schema ${r.schema}, trigger ${r.payload.header.trigger}, platform ${r.filters.platform}`);
    await page.click("[data-feedback-done]");
    await page.waitForTimeout(300);
    const fb = fbLines(await sessionLog(page));
    check(fb.map((e) => e.type).join(">") === "feedback_open>feedback_closed>feedback_open>feedback_sent>feedback_closed" && fb[1]?.sent === false && fb[4]?.sent === true, `session log: ${fb.map((e) => e.type + (e.sent !== undefined ? `{sent:${e.sent}}` : "")).join(" -> ")}`);
    summary.ipad = { report_id: r.report_id, bytes: Buffer.byteLength(body), log: fb };
    check(!errs.length, `no page errors (${errs.join("; ")})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  web.close();
}
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ failures, ...summary }, null, 2) + "\n");
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
