#!/usr/bin/env node
// Report d2bd6006 P3 verify: the newest message stays in view when the iPad keyboard shrinks the viewport.
// Headless Chrome can't raise a soft keyboard, so the visual viewport is shrunk the same way the keyboard shrinks it
// on Manny's iPad (1194x834 -> 1194x406, the report's size). Two scenarios on a built bundle (Mock, plain web):
//   A. composing: at the bottom of a long chat, focus the composer, shrink -> the last reply must still be visible
//   B. streaming: send, shrink while the reply is coming in -> the finished reply must be visible
//   C. scrolled up on purpose: shrink -> the view is NOT yanked to the bottom
// Usage: DIST=apps/desktop/dist-web OUT=/tmp/out TAG=after node apps/desktop/scripts/verify-keyboard-pin.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
const pw = createRequire(process.env.PLAYWRIGHT_FROM ?? "/workspace/bh-smoke/package.json")("playwright-core");
const dist = resolve(process.env.DIST ?? "apps/desktop/dist-web") + "/";
const out = resolve(process.env.OUT ?? "/workspace/p0-stream/report-fixes");
const tag = process.env.TAG ?? "after";
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };
const PORT = Number(process.env.PORT ?? 19620);
const srv = createServer((req, res) => { const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, ""); const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end(); res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(f)); }).listen(PORT, "127.0.0.1");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const checks = []; const check = (ok, what, detail) => { checks.push({ ok: !!ok, what, ...(detail !== undefined ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} [${tag}] ${what}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); };
const b = await pw.chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const FULL = { width: 1194, height: 834 }, KB = { width: 1194, height: 406 };
try {
  const ctx = await b.newContext({ viewport: FULL, hasTouch: true, isMobile: true, deviceScaleFactor: 1, userAgent: UA });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const ta = page.locator("textarea"); await ta.waitFor({ timeout: 20000 });
  const idle = () => page.waitForFunction(() => document.querySelector(".eeg-app")?.getAttribute("data-busy") === "false", null, { timeout: 30000 });
  // where the newest message sits relative to the visible part of the transcript (above the composer dock)
  const lastVisible = () => page.evaluate(() => {
    const msgs = [...document.querySelectorAll("[data-transcript] [data-msg-role]")];
    const last = msgs.at(-1); if (!last) return { ok: false, reason: "no messages" };
    const r = last.getBoundingClientRect();
    const sc = document.querySelector("[data-transcript]").parentElement.getBoundingClientRect();
    const dock = document.querySelector(".eeg-composer-dock")?.getBoundingClientRect();
    const bottom = Math.min(sc.bottom, dock ? dock.top + 40 : sc.bottom); // the dock's top 40px is a fade
    return { ok: r.top < bottom - 8 && r.bottom > sc.top, lastTop: Math.round(r.top), visibleBottom: Math.round(bottom), role: last.getAttribute("data-msg-role"), text: last.textContent.slice(0, 40), count: msgs.length };
  });
  for (let i = 0; i < 6; i++) { await idle(); await ta.fill(`message ${i + 1}: tell me something longer about lectures, NLP and how transformers work in practice`); await page.getByRole("button", { name: /^send$/i }).tap(); await page.waitForTimeout(200); }
  await idle(); await page.waitForTimeout(800);
  // A. composing
  await ta.tap(); await ta.fill("Repeat this phrase I am ai");
  await page.screenshot({ path: join(out, `keyboard-${tag}-A0-full.png`) });
  await page.setViewportSize(KB); await page.waitForTimeout(700);
  const a = await lastVisible();
  await page.screenshot({ path: join(out, `keyboard-${tag}-A1-keyboard-up.png`) });
  check(a.ok && a.role === "assistant", "A. composing with the keyboard up: the newest reply is still visible", a);
  // B. streaming
  await page.setViewportSize(FULL); await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^send$/i }).tap();
  await page.waitForTimeout(60);
  await page.setViewportSize(KB);
  await idle(); await page.waitForTimeout(900);
  const bb = await lastVisible();
  await page.screenshot({ path: join(out, `keyboard-${tag}-B-streamed-with-keyboard.png`) });
  check(bb.ok && bb.role === "assistant", "B. reply streamed in while the keyboard was up: it is visible", bb);
  // C. scrolled up on purpose
  await page.setViewportSize(FULL); await page.waitForTimeout(500);
  await page.evaluate(() => { const sc = document.querySelector("[data-transcript]").parentElement; sc.scrollTo({ top: 0, behavior: "auto" }); });
  await page.waitForTimeout(400);
  await page.setViewportSize(KB); await page.waitForTimeout(700);
  const top = await page.evaluate(() => document.querySelector("[data-transcript]").parentElement.scrollTop);
  check(top < 40, "C. scrolled up to read: a resize does not yank the view to the bottom", { scrollTop: top });
  await page.screenshot({ path: join(out, `keyboard-${tag}-C-scrolled-up.png`) });
  await ctx.close();
} finally { await b.close(); srv.close(); }
writeFileSync(join(out, `keyboard-${tag}-checks.json`), JSON.stringify(checks, null, 1));
const failed = checks.filter((x) => !x.ok).length;
console.log(`[${tag}] ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
