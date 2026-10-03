import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsGuard, globToRegExp, matchesAny } from "../src/lib/fs-guard.ts";

function fixture(): { root: string; guard: FsGuard } {
  const root = mkdtempSync(join(tmpdir(), "fsguard-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "notes.md"), "# notes\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  return { root, guard: new FsGuard([root], ["**/.env", "**/*.key"], 1024) };
}

test("globToRegExp basics", () => {
  assert.ok(globToRegExp("**/*.ts").test("/x/y/z.ts"));
  assert.ok(!globToRegExp("**/*.ts").test("/x/y/z.md"));
  assert.ok(globToRegExp("*.ts").test("a.ts"));
  assert.ok(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts"));
  assert.ok(globToRegExp("**/.env").test("/repo/sub/.env"));
});

test("resolve accepts paths inside roots", () => {
  const { root, guard } = fixture();
  assert.equal(guard.resolve(join(root, "src", "a.ts")), join(root, "src", "a.ts"));
});

test("resolve rejects paths outside roots", () => {
  const { root, guard } = fixture();
  assert.throws(() => guard.resolve(join(root, "..", "etc-passwd")), /outside allowed_roots/);
  assert.throws(() => guard.resolve("/etc/passwd"), /outside allowed_roots/);
});

test("deny_globs win inside roots", () => {
  const { root, guard } = fixture();
  assert.throws(() => guard.resolve(join(root, ".env")), /deny_globs/);
});

test("symlink escape is rejected", () => {
  const { root, guard } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  assert.throws(() => guard.resolve(join(root, "link.txt")), /outside allowed_roots/);
});

test("glob expands over roots and respects deny_globs", async () => {
  const { root, guard } = fixture();
  const hits = await guard.glob(join(root, "**", "*.ts"), 100);
  assert.equal(hits.length, 2);
  const envs = await guard.glob(join(root, "**", "*"), 100);
  assert.ok(!envs.some((p) => p.endsWith(".env")));
});

test("empty roots disables fs access with clear error", () => {
  const guard = new FsGuard([], [], 1024);
  assert.throws(() => guard.resolve("/tmp/x"), /no roots available/);
});

test("readFile truncates at maxReadBytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fsguard-"));
  writeFileSync(join(root, "big.txt"), "x".repeat(5000));
  const guard = new FsGuard([root], [], 1024);
  const r = await guard.readFile(join(root, "big.txt"));
  assert.equal(r.truncated, true);
  assert.equal(r.content.length, 1024);
});

test("readFile refuses binary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "fsguard-"));
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const guard = new FsGuard([root], [], 1024);
  await assert.rejects(() => guard.readFile(join(root, "bin.dat")), /binary/);
});

test("matchesAny", () => {
  assert.ok(matchesAny("/a/b/.env", [globToRegExp("**/.env")]));
  assert.ok(!matchesAny("/a/b/env.txt", [globToRegExp("**/.env")]));
});
