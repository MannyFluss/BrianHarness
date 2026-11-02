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
console.log(`web bundle OK: ${files.length} files, ${kb.toFixed(0)} KB in ${dir}`);
