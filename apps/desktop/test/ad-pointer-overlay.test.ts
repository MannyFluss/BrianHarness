// Step 3: pointer overlay hidden when blinded; visible tab_visible+pointer can toggle it on.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
(globalThis as { React?: typeof React }).React = React;
import { simActor, simDirector } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import { DEFAULT_POINTER_CONFIG, type ScreenInfo } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { AdApp } from "../src/ad/AdApp.tsx";
import { PointerOverlay } from "../src/ad/PointerOverlay.tsx";
import { LiveAdController, staticController, blindedView, calibrationSummary, type PointerDebug } from "../src/ad/controller.ts";

const counter = loadO200k();
const MAC: ScreenInfo = {
  deviceModel: "MacBookAir10,1", platform: "mac", orientation: "landscape_right",
  widthPt: 1440, heightPt: 900, scale: 2, webview: { x: 0, y: 0, width: 1440, height: 900 }, widthMm: 301,
};
const FAKE = [{ name: "fake", file: { screen: MAC, samples: [] }, turn: { aois: [{ id: "a.p1", order: 1, text: "Hello." }] } }] as never;

test("overlay: PointerOverlay renders nothing when show=false or debug=null", () => {
  assert.equal(renderToStaticMarkup(React.createElement(PointerOverlay, { show: false, debug: { interactive: [], recent: [] } })), "");
  assert.equal(renderToStaticMarkup(React.createElement(PointerOverlay, { show: true, debug: null })), "");
});

test("overlay: shows AOIs + recent p* when on", () => {
  const debug: PointerDebug = {
    interactive: [{ msg: "a0", aoi: "a0.c1", x: 10, y: 20, w: 100, h: 30, words: 3, excerpt: "Show the math" }],
    recent: [{ id: "p1", kind: "pointer_click", aoi: "a0.c1", t0: 1, t1: 1 }],
  };
  const html = renderToStaticMarkup(React.createElement(PointerOverlay, { show: true, debug, jsonlHint: "/tmp/h1-pointer/s.jsonl" }));
  assert.match(html, /data-ad-pointer-overlay="on"/);
  assert.match(html, /data-ad-pointer-aoi="a0.c1"/);
  assert.match(html, /data-ad-pointer-ev="p1"/);
  assert.match(html, /data-ad-pointer-jsonl-path/);
});

test("overlay: blinded AdApp has no overlay toggle and no overlay DOM", async () => {
  const c = await LiveAdController.open({
    sessionType: "blinded", arm: "on", sessionId: "ov-b", userId: "u",
    actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(),
    tracker: null, screen: MAC, calibration: null, consent: { camera: false, rawGaze: false },
    inputMode: "pointer", pointerConfig: DEFAULT_POINTER_CONFIG,
  });
  try {
    assert.equal(c.pointerDebug(), null, "pointerDebug null when blinded");
    const html = renderToStaticMarkup(React.createElement(AdApp, { store: c, layout: "tablet", pointerJsonlPath: "/tmp/x.jsonl" }));
    assert.doesNotMatch(html, /data-ad-pointer-overlay/);
    assert.doesNotMatch(html, /data-ad-pointer-overlay-toggle/);
  } finally { c.dispose(); }
});

test("overlay: tab_visible pointer AdApp exposes overlay toggle (default off)", async () => {
  const c = await LiveAdController.open({
    sessionType: "tab_visible", arm: "on", sessionId: "ov-v", userId: "u",
    actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(),
    tracker: null, screen: MAC, calibration: null, consent: { camera: false, rawGaze: false },
    inputMode: "pointer", pointerConfig: DEFAULT_POINTER_CONFIG,
  });
  try {
    const html = renderToStaticMarkup(React.createElement(AdApp, { store: c, layout: "tablet" }));
    assert.match(html, /data-ad-pointer-overlay-toggle="off"/);
    assert.doesNotMatch(html, /data-ad-pointer-overlay="on"/, "default off: no overlay layer");
    // static blinded path also clean
    const bhtml = renderToStaticMarkup(React.createElement(AdApp, {
      store: staticController(blindedView([{ id: "a0", role: "assistant", text: "x" }], calibrationSummary(null))),
      layout: "phone",
    }));
    assert.doesNotMatch(bhtml, /data-ad-pointer-overlay/);
    assert.doesNotMatch(bhtml, /data-ad-pointer-overlay-toggle/);
  } finally { c.dispose(); }
});
