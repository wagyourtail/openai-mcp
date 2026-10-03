import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFences } from "../src/tools/helpers.ts";

test("stripFences removes a single outer code block", () => {
  assert.equal(stripFences("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(stripFences("```\nhello\n```\n"), "hello\n");
  assert.equal(stripFences("  ```python\nprint(1)\n```  "), "print(1)");
});

test("stripFences leaves non-fenced text alone", () => {
  assert.equal(stripFences("const a = 1;"), "const a = 1;");
  assert.equal(stripFences("some text\n```\ncode\n```\nmore"), "some text\n```\ncode\n```\nmore");
});
