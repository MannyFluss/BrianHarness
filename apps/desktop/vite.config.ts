import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// window <title> comes from the one brand config
const brand = JSON.parse(readFileSync(new URL("../../packages/core/src/brand.json", import.meta.url), "utf8")) as { name: string };

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), { name: "brand", transformIndexHtml: (html) => html.replaceAll("%BRAND_NAME%", brand.name) }],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
