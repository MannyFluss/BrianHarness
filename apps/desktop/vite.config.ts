import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// window <title> comes from the one brand config
const brand = JSON.parse(readFileSync(new URL("../../packages/core/src/brand.json", import.meta.url), "utf8")) as { name: string };
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `vite build` (default)    -> dist/      Electron renderer (src/main.tsx, IPC transport)
// `vite build --mode web`   -> dist-web/  static browser / PWA / Capacitor webDir bundle
//                                         (web/index.html -> src/main.web.tsx, in-process core)
// Both use base "./" (relative asset paths): file:// in Electron, capacitor://localhost on iOS,
// any http(s) path for the LAN PWA test. No SSR, no server routes, no Node at runtime.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    base: "./",
    root: web ? here("./web") : here("."),
    publicDir: here("./public"),
    plugins: [react(), tailwindcss(), { name: "brand", transformIndexHtml: (html: string) => html.replaceAll("%BRAND_NAME%", brand.name) }],
    build: web
      ? { outDir: here("./dist-web"), emptyOutDir: true, target: ["safari15", "es2022"] }
      : { outDir: here("./dist"), emptyOutDir: true },
    server: web ? { port: 5174, strictPort: true, host: true, fs: { allow: [here("../..")] } } : { port: 5173, strictPort: true },
    preview: web ? { port: 4174, host: true } : undefined,
  };
});
