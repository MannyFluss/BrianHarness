import { test } from "node:test";
import assert from "node:assert/strict";
import { isFillerOnly, sessionTitle, shortTitle } from "../src/index.js";

test("short session titles instead of cut-off first messages", () => {
  assert.equal(shortTitle("Honestly lately it's mostly making little indie games, I've been prototyping a roguelike"), "Making little indie games");
  assert.equal(shortTitle("hey! so I restore vintage watches"), "Restore vintage watches");
  assert.equal(shortTitle(""), "New chat");
  assert.ok(shortTitle("a".repeat(200)).length <= 34);
  assert.equal(sessionTitle({ firstUserText: "hi", topicLabel: "amateur (ham) radio", turns: 3 }), "Amateur (ham) radio");
  assert.equal(sessionTitle({ firstUserText: "cooking mostly", topicLabel: "food", turns: 1 }), "Cooking mostly");
});

test("greetings and filler are skipped; lead-ins stripped to a noun phrase", () => {
  // the reported bug: was "There"
  assert.equal(shortTitle("Hi there, I like restoring old mechanical watches"), "Restoring old mechanical watches");
  assert.equal(shortTitle("Hi there! I like ham radio."), "Ham radio");
  assert.equal(shortTitle("hello everyone. i'm really into sourdough baking"), "Sourdough baking");
  assert.equal(shortTitle("Good morning! How are you? I love birdwatching"), "Birdwatching");
  assert.equal(shortTitle("hey hey — my favorite thing is urban sketching"), "Urban sketching");
  assert.equal(shortTitle("I’ve been into slime molds lately"), "Slime molds lately");
  assert.equal(shortTitle("hi"), "New chat");
  assert.equal(shortTitle("Hi there"), "New chat");
  assert.equal(shortTitle("hey, how are you doing?"), "New chat");
  assert.equal(shortTitle("ok"), "New chat");
  for (const t of ["Hi there, I like stuff", "hello there", "yo what's up"]) assert.notEqual(shortTitle(t), "There");
  assert.ok(isFillerOnly("hi there!") && !isFillerOnly("hi, I fly kites"));
});

test("topic label wins once confident; greeting-only first message falls back", () => {
  assert.equal(sessionTitle({ firstUserText: "Hi there, I like stuff about radios", topicLabel: "ham radio", turns: 2 }), "Ham radio");
  assert.equal(sessionTitle({ firstUserText: "Hi there", topicLabel: null, turns: 1 }), "New chat");
  assert.equal(sessionTitle({ firstUserText: null }), "New chat");
});

test("HarnessHost: a greeting-only first message doesn't become the title", async () => {
  const { HarnessHost, createBrowserBackend } = await import("../src/index.js");
  let t = 1_000_000;
  const host = new HarnessHost({ userId: "u", backend: async () => createBrowserBackend({ provider: "mock", seed: 3 }), clock: () => t, seed: () => 7 });
  await host.newSession();
  t += 5000;
  const a = await host.reply({ text: "Hi there!", events: [], sentAt: t });
  assert.equal(a.title, "New chat");
  t += 5000;
  const b = await host.reply({ text: "I like restoring vintage watches", events: [], sentAt: t });
  assert.equal(b.title, "Restoring vintage watches");
});
