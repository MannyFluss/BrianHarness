// In-browser CSP smoke test for the built web bundle (dist-web). Headless Chromium via playwright-core.
// All provider hosts are answered by request interception (no real network, no paid calls). CSP is
// enforced before a request leaves the page, so an intercepted response proves connect-src allows it.
//   1. Ollama on a LAN IP (http://192.168.0.114:11434): app detects models and chats through it
//   2. LM Studio on a LAN IP (:1234) and api.openai.com / api.anthropic.com / openrouter.ai are not CSP-blocked
//   3. an origin outside connect-src (http://192.168.0.114:9999) IS blocked (CSP actually enforced)
// Needs playwright-core (devDependency not added; set PLAYWRIGHT_CORE=/path/to/playwright-core) and
// Chrome (CHROME=/path, default /usr/bin/google-chrome). Skips with exit 0 if either is missing.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const dist = new URL("../dist-web/", import.meta.url).pathname;
let pw;
try {
  pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
} catch {
  console.log("csp-smoke SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) {
  console.log(`csp-smoke SKIPPED: no Chrome at ${chrome} (set CHROME)`);
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
const origin = `http://127.0.0.1:${server.address().port}`;

const OLLAMA = "http://192.168.0.114:11434";
const hits = [];
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const failures = [];
try {
  const ctx = await browser.newContext();
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    const url = req.url();
    hits.push(`${req.method()} ${url}`);
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (body) => route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (url === `${OLLAMA}/api/tags`) return json({ models: [{ name: "fake-llama:1b", details: { parameter_size: "1B" } }] });
    if (url === `${OLLAMA}/api/chat`) return json({ message: { content: "FAKE-OLLAMA-REPLY what do you like about that?" } });
    if (/api\.openai\.com|openrouter\.ai|:1234\//.test(url)) return json({ choices: [{ message: { content: "fake" } }] });
    if (url === "https://ollama.com/api/chat") return json({ message: { content: "fake" } });
    if (url.startsWith("https://api.strangeriver.org/")) return json({ choices: [{ message: { content: "fake" } }] });
    if (/api\.anthropic\.com/.test(url)) return json({ content: [{ type: "text", text: "fake" }] });
    return route.abort(); // never touch the real network
  });
  const page = await ctx.newPage();
  const violations = [];
  await page.exposeFunction("__cspViolation", (u) => violations.push(u));
  await page.addInitScript((url) => {
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
    localStorage.setItem("brianharness/settings", JSON.stringify({ provider: "ollama", model: "fake-llama:1b", ollamaUrl: url }));
  }, OLLAMA);
  page.on("pageerror", (e) => failures.push(`pageerror: ${e}`));
  await page.goto(origin + "/");
  await page.waitForSelector("textarea");

  // 1. chat through the LAN Ollama
  await page.click("textarea");
  await page.keyboard.type("i like radios");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("FAKE-OLLAMA-REPLY"), null, { timeout: 15000 }).catch(() => failures.push("no reply from the (intercepted) LAN Ollama"));
  const detected = await page.evaluate(async (u) => (await (await fetch(`${u}/api/tags`)).json()).models?.length, OLLAMA).catch((e) => `error ${e}`);
  if (detected !== 1) failures.push(`Ollama /api/tags fetch: ${detected}`);

  // 2. hosted APIs allowed by connect-src
  for (const u of ["http://192.168.0.114:1234/v1/chat/completions", "https://api.openai.com/v1/chat/completions", "https://api.anthropic.com/v1/messages", "https://openrouter.ai/api/v1/chat/completions", "https://ollama.com/api/chat", "https://api.strangeriver.org/v1/chat/completions", "https://api.strangeriver.org/v1/sessions"]) {
    const r = await page.evaluate(async (u) => { try { return (await fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-test": "1" }, body: "{}" })).status; } catch (e) { return String(e); } }, u);
    if (r !== 200) failures.push(`${u}: ${r}`);
  }
  // 3. an origin outside connect-src is blocked by CSP (proves the policy is live)
  const blocked = await page.evaluate(async () => { try { await fetch("http://192.168.0.114:9999/v1/models"); return "allowed"; } catch { return "blocked"; } });
  await page.waitForTimeout(200);
  const extraAllowed = (process.env.BH_CONNECT_SRC ?? "").includes(":9999");
  if (!extraAllowed && (blocked !== "blocked" || !violations.some((v) => v.includes("192.168.0.114:9999")))) failures.push(`outside origin not CSP-blocked (${blocked})`);
  const unexpected = violations.filter((v) => !v.includes(":9999"));
  if (unexpected.length) failures.push(`unexpected CSP violations: ${unexpected.join(", ")}`);
  if (!hits.some((h) => h === `POST ${OLLAMA}/api/chat`)) failures.push("app never called Ollama /api/chat");

  console.log(`csp-smoke: ${hits.length} intercepted requests; violations: ${violations.join(", ") || "none"}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error("csp-smoke FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("csp-smoke OK: LAN Ollama + LM Studio :1234 + OpenAI/Anthropic/OpenRouter/ollama.com/api.strangeriver.org allowed, other origins blocked");
