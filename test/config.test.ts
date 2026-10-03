import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig } from "../src/config.ts";
import { validateSchema } from "../src/lib/schema-validate.ts";

test("ConfigSchema fills defaults", () => {
  const c = ConfigSchema.parse({});
  assert.equal(c.default_provider, "local");
  assert.deepEqual(c.allowed_roots, []);
  assert.ok(c.deny_globs.includes("**/.env"));
  assert.equal(c.limits.num_ctx, 16384);
});

test("missing config yields default ollama provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  process.env.LOCAL_LLM_CONFIG = join(dir, "nope.json");
  const { config } = loadConfig();
  assert.equal(config.providers.local.type, "ollama");
  assert.equal(config.providers.local.default_model, "llama3.1:8b");
  assert.ok(Object.keys(config.command_whitelist.commands).length > 0);
  delete process.env.LOCAL_LLM_CONFIG;
});

test("env base_url creates a provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  process.env.LOCAL_LLM_CONFIG = join(dir, "nope.json");
  process.env.LOCAL_LLM_BASE_URL = "http://localhost:1234/v1";
  process.env.LOCAL_LLM_MODEL = "test-model";
  const { config } = loadConfig();
  const names = Object.keys(config.providers);
  assert.ok(names.includes("local"));
  assert.equal(config.providers.local.type, "openai");
  assert.equal(config.providers.local.base_url, "http://localhost:1234/v1");
  delete process.env.LOCAL_LLM_CONFIG;
  delete process.env.LOCAL_LLM_BASE_URL;
  delete process.env.LOCAL_LLM_MODEL;
});

test("config file is loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({
    providers: { mine: { type: "openai", base_url: "http://x/v1", default_model: "m1" } },
    allowed_roots: [dir],
  }));
  process.env.LOCAL_LLM_CONFIG = p;
  const { config } = loadConfig();
  assert.equal(config.providers.mine.default_model, "m1");
  assert.deepEqual(config.allowed_roots, [dir]);
  delete process.env.LOCAL_LLM_CONFIG;
});

test("schema-validate catches errors", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: { name: { type: "string" }, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
  };
  assert.equal(validateSchema({ name: "x", age: 3, tags: ["a"] }, schema).length, 0);
  assert.ok(validateSchema({ age: 3 }, schema).length > 0); // missing name
  assert.ok(validateSchema({ name: 1, age: "x" }, schema).length > 0);
  assert.ok(validateSchema({ name: "x", age: 3, tags: [1] }, schema).length > 0);
  assert.ok(validateSchema("notobject", schema).length > 0);
});
