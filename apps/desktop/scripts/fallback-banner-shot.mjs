// Headless screenshot of the study-session extractor fallback banner ("Interest AI unavailable this session
// (calls failed)") from the built web bundle. Fully offline: a FAKE Ollama server on 127.0.0.1:11434 answers the
// Director (model "gpt-oss:20b-cloud") and returns 503 for every extractor call (gemma4:cloud), so after the
// 6th user turn the extractor has failed and the banner appears. No model is ever called.
// Writes docs/screenshot-fallback-banner-iphone.png and docs/screenshot-fallback-banner-desktop.png.
// Deps as csp-smoke.mjs (PLAYWRIGHT_CORE, CHROME). Set FAKE_OLLAMA_PORT if 11434 is taken (must stay in the CSP).
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
  console.log("fallback-banner-shot SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) { console.log(`fallback-banner-shot SKIPPED: no Chrome at ${chrome}`); process.exit(0); }
if (!existsSync(join(dist, "index.html"))) throw new Error("build first: npm run build:web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
const DIRECTOR = "gpt-oss:20b-cloud";
const REPLIES = ["Nice. What got you into that?", "Ha, fair. What's the fiddliest part?", "Which one are you working on now?", "How long does one take you?", "Do you have a favourite?", "What would you change next time?", "And what's next on the bench?", "Sounds absorbing. What else?"];
let n = 0, extractorCalls = 0;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
const ollama = createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/tags") return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ models: [{ name: DIRECTOR, model: DIRECTOR }] }));
    if (path === "/api/version") return res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"version":"0.12.0"}');
    if (path === "/api/chat") {
      const j = JSON.parse(body || "{}");
      if (j.model !== DIRECTOR) { extractorCalls++; return res.writeHead(503, { ...cors, "content-type": "application/json" }).end('{"error":"service unavailable (fake)"}'); }
      const text = REPLIES[n++ % REPLIES.length];
      const msg = { model: DIRECTOR, created_at: new Date().toISOString(), message: { role: "assistant", content: text }, done: true };
      if (j.stream) return res.writeHead(200, { ...cors, "content-type": "application/x-ndjson" }).end(JSON.stringify({ ...msg, done: false }) + "\n" + JSON.stringify({ ...msg, message: { role: "assistant", content: "" }, done: true }) + "\n");
      return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(msg));
    }
    res.writeHead(404, cors).end();
  });
});
const OPORT = Number(process.env.FAKE_OLLAMA_PORT ?? 11434);
await new Promise((r) => web.listen(0, "127.0.0.1", r));
await new Promise((r, j) => ollama.once("error", j).listen(OPORT, "127.0.0.1", r));
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const shots = [];
try {
  for (const [name, ctx] of [["iphone", { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }], ["desktop", { viewport: { width: 1440, height: 900 } }]]) {
    const context = await browser.newContext(ctx);
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await page.addInitScript(([port, model]) => {
      if (!localStorage.getItem("brianharness/settings")) localStorage.setItem("brianharness/settings", JSON.stringify({ provider: "ollama", model, ollamaUrl: `http://127.0.0.1:${port}` }));
    }, [OPORT, DIRECTOR]);
    await page.goto(`http://127.0.0.1:${web.address().port}/`);
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    // start the study (two taps: confirm), opening the sidebar drawer on phones
    // (the phone drawer is off-screen until opened: click through the DOM, it's the same button)
    for (let i = 0; i < 2; i++) { await page.evaluate(() => document.querySelector("[data-study-toggle]").click()); await page.waitForTimeout(150); }
    await page.waitForFunction(() => /Study 1\/10/.test(document.querySelector("[data-study-toggle]")?.textContent ?? ""), null, { timeout: 5000 });
    await page.evaluate(() => window.__eegDemo.endSession?.()); // new session = study session 1
    await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
    for (const t of ["I restore old mechanical watches on weekends", "Mostly 1960s Seikos", "The movements are fascinating", "Balance springs are the hardest bit", "Lately a Grand Seiko 44GS", "It had a sticky balance wheel", "I cleaned it in naphtha"]) {
      await page.evaluate((x) => window.__eegDemo.type(x), t);
      await page.waitForSelector("[data-busy='false']", { timeout: 15000 });
      if (await page.locator("[data-rating-probe]").count()) await page.locator("textarea").pressSequentially(" ", { delay: 5 }).then(() => page.evaluate(() => window.__eegDemo.draft("")));
    }
    await page.waitForSelector("[data-testid='extractor-warning']", { timeout: 15000 });
    await page.waitForTimeout(300);
    const p = join(docs, `screenshot-fallback-banner-${name}.png`);
    await page.screenshot({ path: p });
    shots.push(`${p}: "${(await page.textContent("[data-testid='extractor-warning']")).trim()}"`);
    await context.close();
  }
  console.log(`fallback-banner-shot OK (fake extractor 503s: ${extractorCalls}):\n  ${shots.join("\n  ")}`);
} finally {
  await browser.close();
  web.close();
  ollama.close();
}
