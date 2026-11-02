import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatBody } from "../src/browser.js";

test("parseChatBody: JSON, NDJSON, SSE (one chunk), errors", () => {
  assert.equal(parseChatBody('{"message":{"content":" hi "}}').text, "hi");
  assert.equal(parseChatBody('{"message":{"content":"a"}}\n{"message":{"content":"b"},"done":true}').text, "ab");
  assert.equal(parseChatBody('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\ndata: [DONE]').text, "ab");
  assert.deepEqual(parseChatBody('{"choices":[{"message":{"content":"x"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}').usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(parseChatBody("").text, "");
  assert.throws(() => parseChatBody('{"error":"nope"}'), /nope/);
  assert.throws(() => parseChatBody("<html>gateway</html>"), /unreadable/);
});
