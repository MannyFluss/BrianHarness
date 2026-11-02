// Post-build guard for the static web/Capacitor bundle: relative paths, no Node, no secure-context-only APIs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../dist-web/", import.meta.url).pathname;
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(dir);
const problems = [];
const html = readFileSync(join(dir, "index.html"), "utf8");
if (/(src|href)="\/(?!\/)/.test(html)) problems.push("index.html has root-absolute asset paths (need base './')");
// CSP: the in-process core fetches providers directly, so connect-src must exist and list them
const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
const directive = (name) => csp.split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name)?.slice(1);
const connect = directive("connect-src");
if (!csp) problems.push("index.html has no Content-Security-Policy meta");
else if (!connect) problems.push("CSP has no connect-src (default-src 'self' would block every provider fetch)");
else {
  for (const need of ["'self'", "http://*:11434", "https://*:11434", "https://api.anthropic.com", "https://api.openai.com", "https://openrouter.ai"]) if (!connect.includes(need)) problems.push(`CSP connect-src missing ${need}`);
  for (const extra of (process.env.BH_CONNECT_SRC ?? "").split(/[\s,]+/).filter(Boolean)) if (!connect.includes(extra.replace(/\/$/, ""))) problems.push(`CSP connect-src missing BH_CONNECT_SRC origin ${extra}`);
  if (connect.some((c) => c === "ws:" || c === "wss:")) problems.push("CSP connect-src has dev-only ws:/wss:");
}
if (csp.includes("%CONNECT_SRC%")) problems.push("CSP placeholder %CONNECT_SRC% not replaced");
for (const f of files.filter((f) => /\.(js|css)$/.test(f))) {
  const code = readFileSync(f, "utf8");
  const checks = [
    [/\bfrom\s*["']node:|import\(["']node:|require\(["']node:/, "imports a node: built-in"],
    [/\brequire\(["'](fs|path|os|child_process|http|https|crypto|net)["']\)/, "requires a Node built-in"],
    [/crypto\.subtle|randomUUID\(/, "uses a secure-context-only API (the LAN PWA is plain http)"],
    [/child_process|safeStorage|ipcRenderer/, "references Node/Electron-only APIs"],
    [/url\(\/(?!\/)/, "CSS url() with a root-absolute path"],
  ];
  for (const [re, msg] of checks) if (re.test(code)) problems.push(`${f.slice(dir.length)}: ${msg}`);
}
for (const need of ["manifest.webmanifest", "apple-touch-icon.png"]) if (!files.some((f) => f.endsWith(need))) problems.push(`missing ${need}`);
if (problems.length) {
  console.error("web bundle check FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
const kb = files.reduce((a, f) => a + statSync(f).size, 0) / 1024;
console.log(`web bundle OK: ${files.length} files, ${kb.toFixed(0)} KB in ${dir}\n  connect-src ${connect.join(" ")}`);
