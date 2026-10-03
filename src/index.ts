#!/usr/bin/env node
// Entry point: dep preflight, then the real server. This file must only import
// node builtins — a missing node_modules would crash static imports before any
// of our code runs, and MCP clients would see a bare ERR_MODULE_NOT_FOUND.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
if (!existsSync(join(projectRoot, "node_modules", "@modelcontextprotocol"))) {
  console.error(
    `local_llm: dependencies not installed — run \`npm install\` in ${projectRoot} (or \`npm run configure\`, which does it for you), then restart this MCP server.`,
  );
  process.exit(1);
}

await import("./server.ts");
