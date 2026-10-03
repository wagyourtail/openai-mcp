import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, parseEditBlocks } from "../src/lib/edits.ts";

const BLOCK = (s: string, r: string) =>
  `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

test("parseEditBlocks extracts multiple blocks and skips prose", () => {
  const text = `Here are the edits:\n${BLOCK("a", "A")}\nsome commentary\n${BLOCK("b", "B")}\nDone.`;
  const blocks = parseEditBlocks(text);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { search: "a", replace: "A" });
  assert.deepEqual(blocks[1], { search: "b", replace: "B" });
});

test("parseEditBlocks drops unterminated blocks", () => {
  assert.equal(parseEditBlocks("<<<<<<< SEARCH\norphan\n").length, 0);
  assert.equal(parseEditBlocks("<<<<<<< SEARCH\nx\n=======\ny\n").length, 0);
});

test("applyEdits replaces exact matches in order", () => {
  const r = applyEdits("one\ntwo\nthree\n", [
    { search: "two", replace: "2" },
    { search: "three", replace: "3" },
  ]);
  assert.ok(r.ok);
  assert.equal(r.content, "one\n2\n3\n");
  assert.equal(r.applied, 2);
});

test("applyEdits errors on ambiguous and missing search", () => {
  const amb = applyEdits("x\nx\n", [{ search: "x", replace: "y" }]);
  assert.ok(!amb.ok && amb.block === 1 && /occurs 2 times/.test(amb.reason));
  const miss = applyEdits("abc\n", [{ search: "zzz", replace: "y" }]);
  assert.ok(!miss.ok && /not found/.test(miss.reason));
});

test("applyEdits appends on empty search", () => {
  const r = applyEdits("base\n", [{ search: "", replace: "tail\n" }]);
  assert.ok(r.ok && r.content === "base\ntail\n");
});

test("applyEdits fuzzy-matches trailing-whitespace differences", () => {
  const r = applyEdits("line with space   \nnext\n", [
    { search: "line with space\nnext", replace: "replaced" },
  ]);
  assert.ok(r.ok);
  assert.equal(r.content, "replaced\n");
  assert.deepEqual(r.fuzzy, [1]);
});

test("empty content + append block creates a file", () => {
  const r = applyEdits("", [{ search: "", replace: "created\n" }]);
  assert.ok(r.ok && r.content === "created\n");
});
