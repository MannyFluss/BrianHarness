#!/usr/bin/env node
// Report d2bd6006 P4 verify: on a built web bundle (Mock, plain web, fresh profile), a tap on a PAST sidebar row
// shows that session's transcript read-only (composer gone, "New chat" offered), and a tap on the CURRENT row brings
// the live chat back untouched. iPad landscape 1194x834 + 1194x406 (touch, iPadOS desktop UA) and iPhone portrait.
// Plus: during a study session the past rows are disabled (note shown) and a forced tap opens nothing.
// Usage: DIST=apps/desktop/dist-web OUT=/tmp/out node apps/desktop/scripts/verify-past-chat.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
const pw = createRequire(process.env.PLAYWRIGHT_FROM ?? "/workspace/bh-smoke/package.json")("playwright-core");
const dist = resolve(process.env.DIST ?? "apps/desktop/dist-web") + "/";
const out = resolve(process.env.OUT ?? "/workspace/p0-stream/report-fixes");
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };
const PORT = Number(process.env.PORT ?? 19610);
const srv = createServer((req, res) => { const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, ""); const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end(); res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(f)); }).listen(PORT, "127.0.0.1");
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CASES = [
  { name: "ipad-1194x834", w: 1194, h: 834, ua: IPAD_UA },
  { name: "ipad-1194x406", w: 1194, h: 406, ua: IPAD_UA },
  { name: "iphone-390x844", w: 390, h: 844, ua: IPHONE_UA },
];
const checks = []; const check = (ok, what, detail) => { checks.push({ ok: !!ok, what, ...(detail !== undefined ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); };
const FIRST = "first chat: lecture notes about NLP", SECOND = "second chat: still here afterwards";
const b = await pw.chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  for (const c of CASES) {
    const ctx = await b.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: c.ua });
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const ta = page.locator("textarea"); await ta.waitFor({ timeout: 20000 });
    const idle = () => page.waitForFunction(() => document.querySelector(".eeg-app")?.getAttribute("data-busy") === "false", null, { timeout: 20000 });
    const say = async (t) => { await idle(); await ta.fill(t); await page.getByRole("button", { name: /^send$/i }).tap(); await page.waitForTimeout(300); await idle(); };
    const openSidebar = async () => { const o = page.getByRole("button", { name: "Open sidebar" }); if (await o.isVisible().catch(() => false)) { await o.tap(); await page.waitForTimeout(400); } };
    await say(FIRST);
    await openSidebar();
    await page.locator("aside").getByRole("button", { name: "New chat" }).tap();
    await page.waitForTimeout(600);
    const skip = page.getByRole("button", { name: /^skip$/i });
    if (await skip.count()) await skip.first().tap({ force: true });
    await idle();
    await say(SECOND);
    await openSidebar();
    const past = page.locator("[data-session-row='past']");
    const current = page.locator("[data-session-row='current']");
    check(await past.count() === 1 && await current.count() === 1, `${c.name}: one past + one current row, both <button>`, { past: await past.count(), current: await current.count(), tags: await page.locator("[data-session-row]").evaluateAll((e) => e.map((x) => x.tagName)) });
    const label = await past.getAttribute("aria-label");
    check(/^Open past chat, .* 1 turn$/.test(label ?? "") && !label.includes("NLP"), `${c.name}: past row aria-label (date + turns, no title)`, label);
    await page.screenshot({ path: join(out, `${c.name}-1-sidebar.png`) });
    await past.tap();
    await page.waitForTimeout(500);
    const viewer = page.locator("[data-transcript-viewer]");
    const vText = await viewer.innerText().catch(() => "");
    check(await viewer.isVisible() && vText.includes(FIRST) && !vText.includes(SECOND), `${c.name}: tap on the past row shows its transcript`);
    check(!(await ta.isVisible()), `${c.name}: composer hidden while viewing (read-only)`);
    check(await viewer.getByRole("button", { name: "New chat" }).isVisible(), `${c.name}: "New chat" offered in the viewer`);
    await page.screenshot({ path: join(out, `${c.name}-2-past-chat.png`) });
    await openSidebar();
    await current.tap();
    await page.waitForTimeout(500);
    const live = await page.locator("[data-transcript]").innerText();
    check(!(await viewer.count()) && (await ta.isVisible()) && live.includes(SECOND) && !live.includes(FIRST), `${c.name}: tap on the current row returns to the live chat untouched`);
    await page.screenshot({ path: join(out, `${c.name}-3-back-to-live.png`) });
    check(errors.length === 0, `${c.name}: no page errors`, errors.slice(0, 3));
    await ctx.close();
  }
  // during a study session: past rows are disabled with a note, a (forced) tap opens nothing, nothing is written
  {
    const c = CASES[0], name = `${c.name}-study`;
    const ctx = await b.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: c.ua });
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const ta = page.locator("textarea"); await ta.waitFor({ timeout: 20000 });
    const idle = () => page.waitForFunction(() => document.querySelector(".eeg-app")?.getAttribute("data-busy") === "false", null, { timeout: 20000 });
    const say = async (t) => { await idle(); await ta.fill(t); await page.getByRole("button", { name: /^send$/i }).tap(); await page.waitForTimeout(300); await idle(); };
    await say(FIRST);
    const toggle = page.locator("[data-study-toggle]");
    await toggle.tap(); await page.waitForTimeout(900); await toggle.tap(); await page.waitForTimeout(800);
    await page.locator("aside").getByRole("button", { name: "New chat" }).tap(); await page.waitForTimeout(700);
    const skip = page.getByRole("button", { name: /^skip$/i });
    if (await skip.count()) { await skip.first().tap({ force: true }); await page.waitForTimeout(300); }
    await idle();
    await say("a study turn");
    // the toggle label refreshes on a 5 s poll (release-p4 StudyData): wait for "Study N/10 · stop"
    const inStudy = await page.waitForFunction(() => /Study \d+\/\d+ · stop/.test(document.querySelector("[data-study-toggle]")?.textContent ?? ""), null, { timeout: 8000 }).then(() => true, () => false);
    const past = page.locator("[data-session-row='past']");
    const snap = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    const before = await snap();
    check(inStudy, `${name}: a study session is running`, await toggle.textContent().catch(() => null));
    check(await past.count() >= 1 && (await past.first().isDisabled()), `${name}: past rows disabled`, { past: await past.count() });
    const note = page.locator("[data-sessions-locked]");
    check(await note.isVisible() && /after this study session/i.test(await note.innerText()), `${name}: "Past chats open after this study session." shown`, await note.innerText().catch(() => null));
    await page.screenshot({ path: join(out, `${name}-1-locked.png`) });
    await past.first().tap({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    check(!(await page.locator("[data-transcript-viewer]").count()) && (await ta.isVisible()), `${name}: a forced tap opens nothing; the study chat stays`);
    check(JSON.stringify(await snap()) === JSON.stringify(before), `${name}: nothing written to storage by the tap`);
    check(errors.length === 0, `${name}: no page errors`, errors.slice(0, 3));
    await ctx.close();
  }
} finally { await b.close(); srv.close(); }
writeFileSync(join(out, "past-chat-checks.json"), JSON.stringify(checks, null, 1));
const failed = checks.filter((x) => !x.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
