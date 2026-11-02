// In-browser streaming smoke for the built web bundle (dist-web), mock backend (offline, no network):
// on send the typing indicator is on screen at once, the first token replaces it, the Director's
// reply grows token by token ([data-streaming]), then completes. Same deps/skips as csp-smoke.mjs.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const dist = new URL("../dist-web/", import.meta.url).pathname;
let pw;
try {
  pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
} catch {
  console.log("stream-smoke SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) {
  console.log(`stream-smoke SKIPPED: no Chrome at ${chrome} (set CHROME)`);
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
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
let ok = false;
try {
  const page = await browser.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); // offline: mock only
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
  const t = await page.evaluate(async () => {
    const tl = [];
    const t0 = performance.now();
    const snap = () => {
      const ind = !!document.querySelector("[data-typing-indicator]");
      const s = document.querySelector("[data-streaming='true']");
      tl.push({ t: Math.round(performance.now() - t0), ind, streaming: s ? s.textContent.length : -1 });
    };
    const mo = new MutationObserver(snap);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__eegDemo.draft("I restore old watches on weekends");
    await new Promise((r) => setTimeout(r, 50));
    const ta = document.querySelector("textarea");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => r()));
    snap();
    const afterFrame = tl[tl.length - 1];
    while (document.querySelector("[data-busy='true']")) await new Promise((r) => setTimeout(r, 20));
    mo.disconnect();
    return { tl, afterFrame };
  });
  const lens = [...new Set(t.tl.filter((x) => x.streaming >= 0).map((x) => x.streaming))];
  const firstInd = t.tl.findIndex((x) => x.ind);
  const firstTok = t.tl.findIndex((x) => x.streaming >= 0);
  console.log(`stream-smoke: indicator at frame 1: ${t.afterFrame.ind || t.afterFrame.streaming >= 0}; indicator first seen ${t.tl[firstInd]?.t}ms, first token ${t.tl[firstTok]?.t}ms; ${lens.length} distinct streamed lengths`);
  if (firstInd < 0 || firstTok < 0 || firstInd > firstTok) throw new Error("indicator must appear before the first token");
  if (t.tl.slice(firstTok).some((x) => x.ind)) throw new Error("indicator still shown after the first token");
  if (lens.length < 3) throw new Error("reply did not stream incrementally");
  ok = true;
} finally {
  await browser.close();
  server.close();
}
console.log(ok ? "stream-smoke OK" : "stream-smoke FAILED");
process.exit(ok ? 0 : 1);
