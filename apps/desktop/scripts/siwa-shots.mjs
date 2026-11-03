// Headless screenshots of the Sign in with Apple launch screen from the built web bundle, with a FAKE
// BHAppleAuth plugin injected as window.Capacitor and every Worker request answered locally by Playwright
// (403 apple_account_not_allowed): no live endpoint is called. Writes docs/screenshot-siwa-*.png.
// Deps as csp-smoke.mjs (PLAYWRIGHT_CORE, CHROME).
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
  console.log("siwa-shots SKIPPED: playwright-core not found (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
if (!existsSync(chrome)) { console.log(`siwa-shots SKIPPED: no Chrome at ${chrome}`); process.exit(0); }
if (!existsSync(join(dist, "index.html"))) throw new Error("build first: npm run build:web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "");
  const f = join(dist, p || "index.html");
  if (!f.startsWith(dist) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${web.address().port}/`;
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const fake = () => {
  const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const plugin = {
    isAvailable: async () => ({ available: true }),
    makeNonce: async () => ({ nonce: "n".repeat(43) }),
    signIn: async ({ nonce }) => ({ identityToken: `${b64u("{}")}.${b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 }))}.s`, user: "000000.fake.0000", nonce }),
    credentialState: async () => ({ state: "authorized" }),
  };
  window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => n === "BHAppleAuth", Plugins: { BHAppleAuth: plugin } };
};
let failures = 0;
for (const [name, viewport] of [["iphone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => { failures++; console.log(`pageerror: ${e.message}`); });
  await page.route("https://api.strangeriver.org/**", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "x", type: "x", code: "apple_account_not_allowed" } }) }));
  await page.addInitScript(fake);
  await page.goto(url);
  await page.waitForSelector("[data-siwa-screen]", { timeout: 15000 });
  await page.screenshot({ path: join(docs, `screenshot-siwa-launch-${name}.png`) });
  await page.click("[data-siwa-button]");
  await page.waitForSelector("[data-siwa-message='not-allowed']", { timeout: 10000 });
  await page.screenshot({ path: join(docs, `screenshot-siwa-not-enabled-${name}.png`) });
  await page.click("[data-siwa-skip]");
  await page.waitForSelector("[data-siwa-screen]", { state: "detached", timeout: 5000 });
  console.log(`${name}: launch screen shown, 403 -> not enabled, Skip dismissed`);
  await page.close();
}
await browser.close();
web.close();
if (failures) process.exit(1);
