import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFences, withTimeout } from "../src/tools/helpers.ts";

test("stripFences removes a single outer code block", () => {
  assert.equal(stripFences("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(stripFences("```\nhello\n```\n"), "hello\n");
  assert.equal(stripFences("  ```python\nprint(1)\n```  "), "print(1)");
});

test("stripFences leaves non-fenced text alone", () => {
  assert.equal(stripFences("const a = 1;"), "const a = 1;");
  assert.equal(stripFences("some text\n```\ncode\n```\nmore"), "some text\n```\ncode\n```\nmore");
});

test("withTimeout resolves the value when the promise beats the clock", async () => {
  const out = await withTimeout(new Promise((r) => setTimeout(() => r("done"), 5)), 1000);
  assert.equal(out, "done");
});

test("withTimeout returns 'timeout' when the promise is too slow", async () => {
  const out = await withTimeout(new Promise((r) => setTimeout(() => r("done"), 200)), 5);
  assert.equal(out, "timeout");
});
