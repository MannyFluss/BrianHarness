import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { viewportVars } from "../src/layout.ts";

test("keyboard up: app follows the visual viewport (top = offsetTop, height = visual height), header can't scroll off", () => {
  assert.deepEqual(viewportVars({ height: 516.4, offsetTop: 120.2 }), { "--app-h": "516px", "--app-top": "120px" });
  assert.deepEqual(viewportVars({ height: 852, offsetTop: -3 }), { "--app-h": "852px", "--app-top": "0px" }, "rubber-band overscroll clamps to 0");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.eeg-app \{ position: fixed;[^}]*top: var\(--app-top, 0px\);[^}]*height: var\(--app-h, 100dvh\)/);
  assert.match(css, /html, body \{ height: 100%; overflow: hidden; \}/);
  assert.match(css, /\.eeg-safe-top \{[^}]*padding-top: env\(safe-area-inset-top\)/);
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /viewport-fit=cover/);
});
