import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand, runWhitelisted } from "../src/lib/whitelist.ts";
import { tmpdir } from "node:os";

const wl = {
  enabled: true,
  commands: {
    echo: { allow_args: null },
    git: { allow_args: ["status", "diff", "log"] },
  },
};

test("whitelisted command passes", () => {
  assert.deepEqual(checkCommand(["echo", "hi"], wl), { ok: true });
});

test("non-whitelisted command rejected", () => {
  const r = checkCommand(["rm", "-rf", "/"], wl);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not in the command whitelist/);
});

test("absolute paths need an exact whitelist entry (no basename bypass)", () => {
  // /tmp/fake/echo must NOT match the "echo" whitelist entry.
  const r = checkCommand(["/usr/bin/echo", "hi"], wl);
  assert.equal(r.ok, false);
  const wl2 = { enabled: true, commands: { "/usr/bin/echo": { allow_args: null } } };
  assert.deepEqual(checkCommand(["/usr/bin/echo", "hi"], wl2), { ok: true });
});

test("relative command paths are rejected", () => {
  assert.equal(checkCommand(["./echo", "hi"], wl).ok, false);
});

test("allow_args constrains argv[1]", () => {
  assert.deepEqual(checkCommand(["git", "status"], wl), { ok: true });
  const bad = checkCommand(["git", "push"], wl);
  assert.equal(bad.ok, false);
  const bare = checkCommand(["git"], wl);
  assert.equal(bare.ok, false);
});

test("empty argv rejected", () => {
  assert.equal(checkCommand([], wl).ok, false);
});

test("disabled whitelist rejects everything", () => {
  assert.equal(checkCommand(["echo", "hi"], { enabled: false, commands: wl.commands }).ok, false);
});

test("shell metachars are inert (no injection)", async () => {
  // `;` and `>` become literal args to echo — no second command runs.
  const r = await runWhitelisted(["echo", "hi; touch /tmp/pwned"], {
    cwd: tmpdir(),
    timeoutMs: 5000,
    maxOutputChars: 1000,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /hi; touch \/tmp\/pwned/);
});
