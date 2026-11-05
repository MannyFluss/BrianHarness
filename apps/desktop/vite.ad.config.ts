/**
 * Actor/Director E6 web entry: `vite --config vite.ad.config.ts` / `vite build --config vite.ad.config.ts`.
 * Wraps the protocol-4 web config (vite.config.ts, unchanged) with:
 *  - ad.html (apps/desktop root) as the only input -> dist-ad/
 *  - the vendored o200k_base rank file served/emitted as ad/o200k_base.tiktoken.gz (lazy-loaded by
 *    loadO200kBrowser; Capacitor ships it inside the app bundle, no runtime network fetch)
 *  - dev: <any base>/ad-demo/* serves the sim snapshots from $AD_DEMO_DIR (default /workspace/ad-scratch/demo)
 *  - build with AD_DEMO_BUNDLE=1: copies $AD_DEMO_DIR/*.json into dist-ad/ad-demo/ so a bundle served from any
 *    folder (the iOS bundle at ad-ios/) loads the demo from "./ad-demo/" with no dev server (IOS Dev I4)
 */
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from "vite";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
        const at = url.indexOf("/ad-demo/");
        if (at >= 0) {
          const f = normalize(join(DEMO, url.slice(at + "/ad-demo/".length)));
          if (f.startsWith(DEMO) && existsSync(f)) { res.setHeader("content-type", "application/json"); res.end(readFileSync(f)); return; }
          res.statusCode = 404; res.end(); return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ASSET, source: readFileSync(RANKS) });
      if (process.env.AD_DEMO_BUNDLE === "1" && existsSync(DEMO)) {
        for (const f of readdirSync(DEMO).filter((n) => n.endsWith(".json"))) this.emitFile({ type: "asset", fileName: `ad-demo/${f}`, source: readFileSync(join(DEMO, f)) });
      }
    },
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
