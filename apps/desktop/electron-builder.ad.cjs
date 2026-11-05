// E7: packaging the Actor/Director Mac shell ("BrianHarness Director", arm64) for H1. Separate from the protocol-4
// app config (electron-builder.cjs, unchanged): own appId / product name / userData, entry electron/ad-main.mjs.
//   1. node scripts/ad-gaze-assets.mjs --model <face_landmarker.task>   (stage + verify resources/gaze)
//   2. AD_DEMO_BUNDLE=1 npx vite build --config vite.ad.config.ts      (dist-ad, demo replies bundled)
//   3. npx electron-builder --config electron-builder.ad.cjs --mac zip --arm64
// Unsigned (identity null); on the Mac: ad-hoc sign + clear quarantine (docs/AD_H1_MAC_CHECKLIST.md).
const brand = require("../../packages/core/src/brand.json");
const name = `${brand.name} Director`;
const electronVersion = require("electron/package.json").version; // the workspace electron (45.2.1)
module.exports = {
  appId: `${brand.appId}.director`,
  electronVersion,
  productName: name,
  directories: { output: "release-ad" },
  // the shell has no runtime node dependency: the renderer bundle (dist-ad) carries everything
  files: ["electron/ad-main.mjs", "electron/ad-network.mjs", "electron/ad-preload.cjs", "dist-ad/**", "package.json", "!node_modules/**"],
  extraMetadata: { main: "electron/ad-main.mjs", productName: name, name: `${brand.slug}-director` },
  extraResources: [{ from: "resources/gaze", to: "gaze", filter: ["face_landmarker.task", "vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm", "manifest.json"] }],
  asar: true,
  npmRebuild: false,
  mac: {
    target: [{ target: "zip", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    identity: null,
    hardenedRuntime: false,
    extendInfo: {
      NSCameraUsageDescription: "BrianHarness Director uses the camera to estimate where you are reading on screen. Frames stay on this Mac and are never saved or sent.",
      LSMinimumSystemVersion: "12.0",
    },
  },
};
