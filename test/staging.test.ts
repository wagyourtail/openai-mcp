import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsGuard } from "../src/lib/fs-guard.ts";
import { stageWrite, getOp, listOps, commitOp, discardOp, listCommits, revertCommit } from "../src/lib/staging.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "staging-"));
  writeFileSync(join(root, "a.txt"), "line1\nline2\n");
  const guard = new FsGuard([root], [], 1024 * 1024);
  return { root, guard };
}

test("stage → diff → commit lifecycle", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "line1\nCHANGED\n" }, 60_000);
  assert.ok(op.id);
  assert.ok(op.existedBefore);
  assert.match(op.diff, /-line2/);
  assert.match(op.diff, /\+CHANGED/);
  // Not on disk yet
  assert.equal(readFileSync(join(root, "a.txt"), "utf-8"), "line1\nline2\n");

  const fetched = getOp(op.id)!;
  assert.equal(fetched.path, op.path);
  assert.ok(listOps().some((o) => o.id === op.id));

  const r = await commitOp(guard, op.id);
  assert.equal(readFileSync(r.path, "utf-8"), "line1\nCHANGED\n");
  assert.equal(getOp(op.id), undefined);
});

test("new file stage + commit", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "new", "file.txt"), content: "fresh\n" }, 60_000);
  assert.equal(op.existedBefore, false);
  await commitOp(guard, op.id);
  assert.equal(readFileSync(join(root, "new", "file.txt"), "utf-8"), "fresh\n");
});

test("discard drops the op without writing", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "nope\n" }, 60_000);
  assert.equal(discardOp(op.id), true);
  await assert.rejects(() => commitOp(guard, op.id), /no staged op/);
  assert.equal(readFileSync(join(root, "a.txt"), "utf-8"), "line1\nline2\n");
});

test("staging outside roots is rejected", () => {
  const { guard } = setup();
  assert.throws(() => stageWrite(guard, { path: "/tmp/evil.txt", content: "x" }, 60_000), /outside allowed_roots/);
});

test("no tmp files left behind after commit", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "v2\n" }, 60_000);
  await commitOp(guard, op.id);
  assert.equal(existsSync(`${op.path}.openai-mcp-${op.id}.tmp`), false);
});

test("commit refuses when file drifted since staging, force overrides", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "v2\n" }, 60_000);
  writeFileSync(join(root, "a.txt"), "someone else\n");
  await assert.rejects(() => commitOp(guard, op.id), /changed since staging/);
  const r = await commitOp(guard, op.id, true);
  assert.equal(r.drifted, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf-8"), "v2\n");
});

test("commit stores an optional summary on the commit record", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "v2\n" }, 60_000);
  const { commitId } = await commitOp(guard, op.id, false, "rewrite a.txt");
  const rec = listCommits().find((c) => c.id === commitId);
  assert.equal(rec?.summary, "rewrite a.txt");
});

test("staged content gets a POSIX trailing newline", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "no newline at end" }, 60_000);
  assert.equal(op.newContent, "no newline at end\n");
  await commitOp(guard, op.id);
  assert.equal(readFileSync(join(root, "a.txt"), "utf-8"), "no newline at end\n");
});

test("empty staged content stays empty (not newline-only)", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "" }, 60_000);
  assert.equal(op.newContent, "");
});

test("revert restores byte-exact content without newline normalization", async () => {
  const { root, guard } = setup();
  writeFileSync(join(root, "nonl.txt"), "original-no-newline");
  const op = stageWrite(guard, { path: join(root, "nonl.txt"), content: "changed\n" }, 60_000);
  const { commitId } = await commitOp(guard, op.id);
  const revert = revertCommit(guard, commitId, 60_000);
  assert.equal(revert.newContent, "original-no-newline");
  await commitOp(guard, revert.id);
  assert.equal(readFileSync(join(root, "nonl.txt"), "utf-8"), "original-no-newline");
});

test("revert stages an op restoring pre-commit content", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.txt"), content: "v2\n" }, 60_000);
  const { commitId } = await commitOp(guard, op.id);
  assert.ok(listCommits().some((c) => c.id === commitId));

  const revert = revertCommit(guard, commitId, 60_000);
  assert.equal(revert.newContent, "line1\nline2\n");
  await commitOp(guard, revert.id);
  assert.equal(readFileSync(join(root, "a.txt"), "utf-8"), "line1\nline2\n");
});
