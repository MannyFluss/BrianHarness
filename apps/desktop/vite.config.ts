import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// window <title> comes from the one brand config
const brand = JSON.parse(readFileSync(new URL("../../packages/core/src/brand.json", import.meta.url), "utf8")) as { name: string };
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// in-app bug report header: the commit the bundle was built from (BH_COMMIT overrides; null outside a git checkout)
const commit = (() => {
  if (process.env.BH_COMMIT) return process.env.BH_COMMIT;
  try { return execSync("git rev-parse --short HEAD", { cwd: here("."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; }
})();

// Web/PWA CSP connect-src. The Electron renderer keeps its tight index.html CSP (default-src 'self',
// no network: it talks to the core over IPC only).
export const WEB_CONNECT_SRC = ["'self'", "http://*:11434", "https://*:11434", "http://*:1234", "https://api.anthropic.com", "https://api.openai.com", "https://openrouter.ai", "https://ollama.com", "https://api.strangeriver.org"];
/**
 * Extra origins for a custom OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...), e.g.
 *   BH_CONNECT_SRC="http://192.168.0.114:8080 https://llm.example.com" npm run build:web
 * Space- or comma-separated scheme://host[:port] entries (host may be * or *.domain).
 */
export function webConnectSrc(extra = process.env.BH_CONNECT_SRC ?? "", dev = false): string {
  const add = extra.split(/[\s,]+/).filter(Boolean);
  for (const o of add) if (!/^(https?|wss?):\/\/(\*|(\*\.)?[a-z0-9.-]+|\[[0-9a-f:]+\])(:(\d{1,5}|\*))?\/?$/i.test(o)) throw new Error(`BH_CONNECT_SRC: not an origin: ${o}`);
  // dev server HMR websocket (same host); not in production builds
  return [...new Set([...WEB_CONNECT_SRC, ...add.map((o) => o.replace(/\/$/, "")), ...(dev ? ["ws:", "wss:"] : [])])].join(" ");
}

// `vite build` (default)    -> dist/      Electron renderer (src/main.tsx, IPC transport)
// `vite build --mode web`   -> dist-web/  static browser / PWA / Capacitor webDir bundle
//                                         (web/index.html -> src/main.web.tsx, in-process core)
// Both use base "./" (relative asset paths): file:// in Electron, capacitor://localhost on iOS,
// any http(s) path for the LAN PWA test. No SSR, no server routes, no Node at runtime.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    base: "./",
    define: { __BH_COMMIT__: JSON.stringify(commit) },
    root: web ? here("./web") : here("."),
    publicDir: here("./public"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "brand-csp",
        transformIndexHtml: (html: string, ctx: { server?: unknown }) => html.replaceAll("%BRAND_NAME%", brand.name).replaceAll("%CONNECT_SRC%", webConnectSrc(undefined, !!ctx.server)),
      },
    ],
    build: web
      ? { outDir: here("./dist-web"), emptyOutDir: true, target: ["safari15", "es2022"] }
      : { outDir: here("./dist"), emptyOutDir: true },
    server: web ? { port: 5174, strictPort: true, host: true, fs: { allow: [here("../..")] } } : { port: 5173, strictPort: true },
    preview: web ? { port: 4174, host: true } : undefined,
  };
});
