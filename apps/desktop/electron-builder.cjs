// Packaging for Manny's Mac (arm64). Run ON the Mac: npm run dist:mac -w @brianharness/desktop
// Name/appId come from the one brand config (packages/core/src/brand.json).
const brand = require("../../packages/core/src/brand.json");
module.exports = {
  appId: brand.appId,
  productName: brand.name,
  executableName: brand.slug,
  directories: { output: "release" },
  files: ["electron/**", "dist/**", "package.json"],
  extraMetadata: { productName: brand.name },
  asar: true,
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    // unsigned local build by default; set identity + notarize (Apple Developer ID) for distribution
    identity: null,
  },
};
