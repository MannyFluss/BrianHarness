// iPhone keyboard-up layout check from the built web bundle (mock backend, offline). Headless Chrome has no iOS
// keyboard or notch, so this emulates both: window.visualViewport is replaced by a stub (393x852 screen, 336px
// keyboard, 47px status bar = iPhone 15 safe-area-inset-top, applied by overriding .eeg-safe-top's padding), and
// semi-transparent overlays mark the status bar and keyboard. Two modes:
//   scrolled - iOS default/"none" resize: layout viewport unchanged, iOS scrolls it (visualViewport.offsetTop 120)
//   native   - Capacitor Keyboard resize "native": the webview itself shrinks (offsetTop 0)
// Asserts: header top >= status bar, header fully visible, composer bottom <= keyboard top, document not scrolled.
// Writes docs/screenshot-iphone-keyboard.png and docs/screenshot-iphone-keyboard-native.png. Deps as csp-smoke.mjs.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const dist = new URL("../dist-web/", import.meta.url).pathname;
const docs = new URL("../../../docs/", import.meta.url).pathname;
let pw;
try {
  pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
} catch {
  console.log("keyboard-shots SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) {
  console.log(`keyboard-shots SKIPPED: no Chrome at ${chrome}`);
  process.exit(0);
}
if (!existsSync(join(dist, "index.html"))) throw new Error("build first: npm run build:web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const W = 393, H = 852, KB = 336, SB = 47;
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const out = [];
let fail = 0;
try {
  for (const [mode, file, top, pageH] of [["scrolled", "screenshot-iphone-keyboard.png", 120, H], ["native", "screenshot-iphone-keyboard-native.png", 0, H - KB]]) {
    const context = await browser.newContext({ viewport: { width: W, height: pageH }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await page.addInitScript(() => {
      const vv = new EventTarget();
      Object.assign(vv, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
      window.__setVV = (h, t) => { vv.height = h; vv.offsetTop = t; vv.pageTop = t; vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll")); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    await page.addStyleTag({ content: `.eeg-safe-top{padding-top:${SB}px!important}` });
    for (const t of ["I restore old mechanical watches on weekends", "Mostly 1960s Seikos, the movements are fascinating", "Lately a Grand Seiko 44GS with a sticky balance"]) await page.evaluate((x) => window.__eegDemo.type(x), t);
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    await page.locator("textarea").focus();
    await page.locator("textarea").pressSequentially("the hairspring was", { delay: 10 });
    // keyboard up: visible area = H - KB tall, starting at `top` of the layout viewport
    await page.evaluate(([h, t]) => window.__setVV(h, t), [H - KB, top]);
    await page.waitForTimeout(250);
    const m = await page.evaluate(([t, sb]) => {
      const hd = document.querySelector("header").getBoundingClientRect();
      const ta = document.querySelector(".eeg-composer-dock")?.getBoundingClientRect() ?? document.querySelector("textarea").getBoundingClientRect();
      const tx = document.querySelector("textarea").getBoundingClientRect();
      // overlays, in layout-viewport coordinates of the visible window
      return { headerTop: hd.top - t, headerBottom: hd.bottom - t, contentTop: hd.top - t + sb, textareaBottom: tx.bottom - t, dockBottom: ta.bottom - t, scrollY: window.scrollY, appTop: getComputedStyle(document.querySelector(".eeg-app")).top };
    }, [top, SB]);
    const visH = H - KB;
    const ok = m.headerTop >= -0.5 && m.headerTop <= 0.5 && m.headerBottom > SB + 20 && m.textareaBottom <= visH + 0.5 && m.scrollY === 0;
    if (!ok) fail++;
    out.push(`${mode}: ${ok ? "OK" : "FAIL"} ${JSON.stringify(m)}`);
    // overlays: status bar at the visible top, keyboard below the visible area (scrolled mode: painted over the
    // layout viewport region that iOS would cover)
    await page.evaluate(([t, sb, visH, kb, pageH]) => {
      const add = (css, text) => { const d = document.createElement("div"); d.style.cssText = `position:fixed;left:0;right:0;z-index:99999;font:600 15px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;pointer-events:none;${css}`; d.textContent = text; document.body.appendChild(d); };
      add(`top:${t}px;height:${sb}px;background:rgba(255,0,128,.28);color:#fff`, "status bar (safe-area-inset-top 47px)");
      if (pageH > visH) add(`top:${t + visH}px;height:${kb}px;background:rgba(160,160,170,.92);color:#111`, "iOS keyboard (336px)");
    }, [top, SB, visH, KB, pageH]);
    const path = join(docs, file);
    await page.screenshot({ path, clip: { x: 0, y: top, width: W, height: Math.min(pageH - top, mode === "scrolled" ? H - top : pageH) } });
    out.push(`  ${path}`);
    await context.close();
  }
  console.log(`keyboard-shots ${fail ? "FAIL" : "OK"}:\n  ${out.join("\n  ")}`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
