import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTitle, shortTitle } from "../src/index.js";

test("short session titles instead of cut-off first messages", () => {
  assert.equal(shortTitle("Honestly lately it's mostly making little indie games, I've been prototyping a roguelike"), "Lately it's mostly making little");
  assert.equal(shortTitle("hey! so I restore vintage watches"), "Restore vintage watches");
  assert.equal(shortTitle(""), "New chat");
  assert.ok(shortTitle("a".repeat(200)).length <= 34);
  assert.equal(sessionTitle({ firstUserText: "hi", topicLabel: "amateur (ham) radio", turns: 3 }), "Amateur (ham) radio");
  assert.equal(sessionTitle({ firstUserText: "cooking mostly", topicLabel: "food", turns: 1 }), "Cooking mostly");
});
