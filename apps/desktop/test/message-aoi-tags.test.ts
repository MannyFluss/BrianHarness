// Actor/Director E5: Message.tsx paragraph tags for gaze AOIs are opt-in. Without the `aoi` prop the DOM is the
// protocol-4 DOM byte-for-byte; with it, each paragraph (digest.ts split) is an inline [data-msg][data-p] span and
// the text content is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Message, paragraphChunks, type ChatMsg } from "../src/components/Message.tsx";
import { paragraphs } from "../../../packages/core/src/actor-director/digest.ts";

(globalThis as { React?: typeof React }).React = React;
const html = (msg: ChatMsg, aoi?: { msg: string }) => renderToStaticMarkup(React.createElement(Message, aoi ? { msg, aoi } : { msg }));
const TEXT = "First para.\n\nSecond one\nwith a line.\n \n\nThird & <last>.";

test("no aoi prop: protocol-4 DOM unchanged (no data-p, text node as before)", () => {
  const h = html({ id: "a1", role: "assistant", text: TEXT });
  assert.ok(!h.includes("data-p"));
  assert.ok(h.includes("First para.\n\nSecond one\nwith a line.\n \n\nThird &amp; &lt;last&gt;."));
});
test("aoi prop: one inline span per paragraph, same split as digest.ts, same text", () => {
  const h = html({ id: "a1", role: "assistant", text: TEXT }, { msg: "m3" });
  const spans = [...h.matchAll(/<span data-msg="m3" data-p="(\d+)">([^<]*)<\/span>/g)];
  assert.deepEqual(spans.map((m) => Number(m[1])), [0, 1, 2]);
  assert.equal(spans.length, paragraphs(TEXT).length);
  assert.equal(h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), TEXT);
  assert.equal(paragraphChunks(TEXT).map((c) => c.text).join(""), TEXT);
});
test("user messages are never tagged", () => {
  assert.ok(!html({ id: "u1", role: "user", text: "a\n\nb" }, { msg: "m1" }).includes("data-p"));
});
