import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackSearch, globRe, parseGitignore } from "../src/lib/filesearch.ts";

test("globRe matches typical glob shapes", () => {
  assert.ok(globRe("*.ts").test("foo.ts"));
  assert.ok(!globRe("*.ts").test("foo.js"));
  assert.ok(globRe("**/*.ts").test("src/deep/foo.ts"));
  assert.ok(globRe("**/*.ts").test("foo.ts"));
  assert.ok(globRe("src/**").test("src/a/b/c.ts"));
  assert.ok(globRe("a?c").test("abc"));
  assert.ok(!globRe("a?c").test("ac"));
});

test("parseGitignore handles bare names, anchored, negation, dir-only", () => {
  const rules = parseGitignore("# comment\nnode_modules/\n/dist\n*.log\n!important.log\n", "");
  assert.equal(rules.length, 4);
  assert.equal(rules[0].dirOnly, true);
  assert.equal(rules[3].negated, true);
});

function withTree(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsearch-"));
    try {
      mkdirSync(join(dir, "src", "deep"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(dir, ".hidden"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "hello world\nfoo bar\n");
      writeFileSync(join(dir, "src", "deep", "b.ts"), "nothing here\nhello again\n");
      writeFileSync(join(dir, "src", "bin.dat"), "hello\0binary\n");
      writeFileSync(join(dir, "node_modules", "pkg", "c.ts"), "hello ignored\n");
      writeFileSync(join(dir, ".hidden", "h.ts"), "hello hidden\n");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("fallbackSearch finds matches, skips gitignored+hidden+binary", withTree(async (dir) => {
  const out = await fallbackSearch({ pattern: "hello", target: dir });
  const lines = out.split("\n");
  assert.ok(lines.some((l) => l.includes("a.ts:1:hello world")), out);
  assert.ok(lines.some((l) => l.includes("b.ts:2:hello again")), out);
  assert.ok(!lines.some((l) => l.includes("pkg/c.ts")), "gitignored dir");
  assert.ok(!lines.some((l) => l.includes(".hidden")), "hidden dir");
  assert.ok(!lines.some((l) => l.includes("bin.dat")), "binary skipped");
}));

test("fallbackSearch honors glob filter", withTree(async (dir) => {
  writeFileSync(join(dir, "note.txt"), "hello text\n");
  const only = await fallbackSearch({ pattern: "hello", target: dir, glob: "*.txt" });
  assert.ok(only.includes("note.txt"), only);
  assert.ok(!only.includes("a.ts"), only);
  const none = await fallbackSearch({ pattern: "hello", target: dir, glob: "*.py" });
  assert.equal(none, "(no matches)");
}));

test("fallbackSearch reports bad regex and missing path", async () => {
  assert.match(await fallbackSearch({ pattern: "([", target: "/" }), /invalid regex/);
  assert.match(await fallbackSearch({ pattern: "x", target: "/nonexistent-zzz" }), /path not found/);
});
