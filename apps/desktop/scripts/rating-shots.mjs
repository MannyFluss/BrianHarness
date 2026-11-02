// Screenshots of the absorption-rating UI from the built web bundle (mock backend, offline):
// docs/screenshot-rating-{probe,session}-{desktop,iphone}.png. Also checks the flow: the turn
// probe auto-dismisses on typing, the session card appears on New chat and closes on Done.
// Same deps/skips as csp-smoke.mjs (PLAYWRIGHT_CORE, CHROME).
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
  console.log("rating-shots SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) {
  console.log(`rating-shots SKIPPED: no Chrome at ${chrome}`);
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
const shots = [];
try {
  for (const [name, ctx] of [
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["iphone", { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
  ]) {
    const context = await browser.newContext(ctx);
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    await page.evaluate(() => window.__eegDemo.type("I restore old mechanical watches on weekends"));
    await page.evaluate(() => window.__eegDemo.type("Mostly 1960s Seikos, the movements are fascinating"));
    await page.evaluate(() => window.__eegDemo.probe());
    await page.waitForSelector("[data-rating-probe='turn']");
    await page.waitForTimeout(400);
    const probe = join(docs, `screenshot-rating-probe-${name}.png`);
    await page.screenshot({ path: probe });
    shots.push(probe);
    // typing dismisses the probe
    await page.locator("textarea").pressSequentially("ok", { delay: 30 });
    await page.waitForSelector("[data-rating-probe='turn']", { state: "detached", timeout: 3000 });
    await page.evaluate(() => window.__eegDemo.draft(""));
    await page.evaluate(() => window.__eegDemo.endSession());
    await page.waitForSelector("[data-rating-probe='session']");
    await page.click("[data-rating-probe='session'] [data-rating='4']");
    await page.fill("[data-rating-probe='session'] textarea", "The bit about balance springs");
    await page.waitForTimeout(400);
    const card = join(docs, `screenshot-rating-session-${name}.png`);
    await page.screenshot({ path: card });
    shots.push(card);
    await page.click("[data-rating-done]");
    await page.waitForSelector("[data-rating-probe='session']", { state: "detached", timeout: 3000 });
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    await context.close();
  }
  console.log(`rating-shots OK:\n  ${shots.join("\n  ")}`);
} finally {
  await browser.close();
  server.close();
}
