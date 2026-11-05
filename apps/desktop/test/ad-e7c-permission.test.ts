// E7c: camera permission decision for the Mac shell (H1 Run A denied getUserMedia: origin "null").
import { test } from "node:test";
import assert from "node:assert/strict";
import { adOriginOf, isAllowedMediaRequest } from "../electron/ad-network.mjs";

const own = { permission: "media", isOwnWebContents: true, wcUrl: "bh-app://app/ad.html?tracker=mediapipe", requestingUrl: "bh-app://app/ad.html", mediaTypes: ["video"] };
test("origin of bh-app urls is bh-app://app (not Node's 'null')", () => {
  assert.equal(adOriginOf("bh-app://app/ad.html?x=1"), "bh-app://app");
  assert.equal(new URL("bh-app://app/x").origin, "null"); // the original bug
});
test("own window + bh-app + video -> grant", () => {
  assert.equal(isAllowedMediaRequest(own), true);
  assert.equal(isAllowedMediaRequest({ ...own, requestingUrl: undefined, origin: "null" }), true); // 'null' origin, wc is ours
  assert.equal(isAllowedMediaRequest({ ...own, requestingUrl: undefined, origin: "bh-app://app" }), true);
});
test("deny: audio, foreign wc, other origins, other permissions", () => {
  assert.equal(isAllowedMediaRequest({ ...own, mediaTypes: ["video", "audio"] }), false);
  assert.equal(isAllowedMediaRequest({ ...own, mediaTypes: ["audio"] }), false);
  assert.equal(isAllowedMediaRequest({ ...own, mediaTypes: [] }), false);
  assert.equal(isAllowedMediaRequest({ ...own, isOwnWebContents: false }), false);
  for (const u of ["https://evil.example/", "http://localhost:5173/", "bh-app://other/x", "file:///x"]) {
    assert.equal(isAllowedMediaRequest({ ...own, requestingUrl: u }), false, u);
    assert.equal(isAllowedMediaRequest({ ...own, wcUrl: u }), false, u);
  }
  assert.equal(isAllowedMediaRequest({ ...own, requestingUrl: undefined, origin: "https://evil.example" }), false);
  assert.equal(isAllowedMediaRequest({ ...own, requestingUrl: undefined, origin: "null", wcUrl: "https://evil.example/" }), false);
  assert.equal(isAllowedMediaRequest({ ...own, permission: "geolocation" }), false);
});
