import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsGuard } from "../src/lib/fs-guard.ts";
import { stageWrite } from "../src/lib/staging.ts";
import { verifyStagedOp } from "../src/lib/verify.ts";
import type { CommandWhitelist } from "../src/lib/whitelist.ts";

const WL: CommandWhitelist = {
  enabled: true,
  commands: {
    cat: { allow_args: null },
    grep: { allow_args: null },
    // a command that rewrites a side file stands in for auto-baselining linters
    sh: { allow_args: ["-c"] },
  },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "verify-"));
  writeFileSync(join(root, "a.py"), "OLD = 1\n");
  const guard = new FsGuard([root], [], 1024 * 1024);
  return { root, guard };
}

test("verify runs the command on the STAGED content, not the disk file", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.py"), content: "NEW = 42\n" }, 60_000);

  const r = await verifyStagedOp(guard, WL, {
    opId: op.id,
    argv: ["cat", "{file}"],
    timeoutMs: 5000,
    maxOutputChars: 8000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.stdout, "NEW = 42\n");
  // disk untouched, temp cleaned up
  assert.equal(readFileSync(join(root, "a.py"), "utf-8"), "OLD = 1\n");
  assert.ok(!existsSync(r.tmpPath));
  assert.equal(readdirSync(root).filter((f) => f.includes("verify-")).length, 0);
});

test("{file} is appended when argv has no placeholder", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.py"), content: "MARKER\n" }, 60_000);
  const r = await verifyStagedOp(guard, WL, {
    opId: op.id,
    argv: ["grep", "MARKER"],
    timeoutMs: 5000,
    maxOutputChars: 8000,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /MARKER/);
});

test("non-whitelisted command is refused before any temp write", async () => {
  const { root, guard } = setup();
  const op = stageWrite(guard, { path: join(root, "a.py"), content: "X = 1\n" }, 60_000);
  const r = await verifyStagedOp(guard, WL, {
    opId: op.id,
    argv: ["rm", "{file}"],
    timeoutMs: 5000,
    maxOutputChars: 8000,
  });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /not in the command whitelist/);
  assert.equal(readdirSync(root).filter((f) => f.includes("verify-")).length, 0);
});

test("restore_paths are snapshotted and restored after the command", async () => {
  const { root, guard } = setup();
  const baseline = join(root, "baseline.json");
  writeFileSync(baseline, "{\"orig\": true}\n");
  const op = stageWrite(guard, { path: join(root, "a.py"), content: "NEW = 1\n" }, 60_000);

  // `sh -c 'echo corrupted > "$1"'` mutates the restore path like an auto-baseline write
  const r = await verifyStagedOp(guard, WL, {
    opId: op.id,
    argv: ["sh", "-c", `echo corrupted > '${baseline}'`],
    restorePaths: [baseline],
    timeoutMs: 5000,
    maxOutputChars: 8000,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.restored, [baseline]);
  assert.equal(readFileSync(baseline, "utf-8"), "{\"orig\": true}\n");
});

test("unknown op id throws", async () => {
  const { guard } = setup();
  await assert.rejects(
    verifyStagedOp(guard, WL, { opId: "nope", argv: ["cat"], timeoutMs: 1000, maxOutputChars: 100 }),
    /no staged op/,
  );
});
