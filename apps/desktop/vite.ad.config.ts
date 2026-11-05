/**
 * Actor/Director E6 web entry: `vite --config vite.ad.config.ts` / `vite build --config vite.ad.config.ts`.
 * Wraps the protocol-4 web config (vite.config.ts, unchanged) with:
 *  - ad.html (apps/desktop root) as the only input -> dist-ad/
 *  - the vendored o200k_base rank file served/emitted as ad/o200k_base.tiktoken.gz (lazy-loaded by
 *    loadO200kBrowser; Capacitor ships it inside the app bundle, no runtime network fetch)
 *  - dev only: /ad-demo/* serves the sim snapshots from $AD_DEMO_DIR (default /workspace/ad-scratch/demo)
 */
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from "vite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
import base from "./vite.config.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const RANKS = here("../../packages/core/vendor/o200k_base.tiktoken.gz");
const ASSET = "ad/o200k_base.tiktoken.gz";
const DEMO = process.env.AD_DEMO_DIR ?? "/workspace/ad-scratch/demo";

function adAssets(): Plugin {
  return {
    name: "ad-assets",
    transformIndexHtml: (html: string, ctx: { server?: unknown }) => html.replaceAll("%DEV_WS%", ctx.server ? " ws: wss:" : ""),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0]!;
        if (url.endsWith(`/${ASSET}`)) { res.setHeader("content-type", "application/gzip"); res.end(readFileSync(RANKS)); return; }
        if (url.startsWith("/ad-demo/")) {
          const f = normalize(join(DEMO, url.slice("/ad-demo/".length)));
          if (f.startsWith(DEMO) && existsSync(f)) { res.setHeader("content-type", "application/json"); res.end(readFileSync(f)); return; }
          res.statusCode = 404; res.end(); return;
        }
        next();
      });
    },
    generateBundle() { this.emitFile({ type: "asset", fileName: ASSET, source: readFileSync(RANKS) }); },
  };
}

export default defineConfig((env) => {
  const b = (typeof base === "function" ? base({ ...env, mode: "web" }) : base) as UserConfig;
  return mergeConfig(b, {
    plugins: [adAssets()],
    root: here("."),
    build: { outDir: here("./dist-ad"), rollupOptions: { input: { ad: here("./ad.html") } } },
    server: { port: 5175 },
  } satisfies UserConfig);
});
