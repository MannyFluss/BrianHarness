// Nov 3 2026 (Addendum 4, composer lock): while the Director is busy (request start -> reply complete or error,
// incl. the reasoning/"thinking" phase and an empty-completion retry) the composer textarea is read-only, so no
// typing, paste, IME or drop can land before completeAt; Send is disabled too. Idle: editable.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../src/components/Composer.tsx";

// tsx compiles the component with the classic JSX transform under the root tsconfig (Vite uses the automatic one)
(globalThis as { React?: typeof React }).React = React;

const html = (busy: boolean, value = "hi") => renderToStaticMarkup(React.createElement(Composer, { value, onChange: () => {}, onSend: () => {}, busy }));

test("busy: textarea read-only + aria-busy + data-composer-locked, Send disabled", () => {
  const h = html(true);
  assert.match(h, /<textarea[^>]*readonly/i);
  assert.match(h, /<textarea[^>]*aria-busy="true"/);
  assert.match(h, /<textarea[^>]*data-composer-locked="true"/);
  assert.match(h, /<button[^>]*\sdisabled=""/);
});

test("idle: textarea editable, Send enabled with text", () => {
  const h = html(false);
  assert.doesNotMatch(h, /<textarea[^>]*readonly/i);
  assert.doesNotMatch(h, /data-composer-locked/);
  assert.doesNotMatch(h, /<button[^>]*\sdisabled=""/);
});
