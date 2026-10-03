/**
 * Interactive config builder for openai-mcp.
 *   node scripts/configure.ts            — wizard
 *   node scripts/configure.ts --yes      — accept all defaults, non-interactive
 *   node scripts/configure.ts --out PATH — write config elsewhere
 *   node scripts/configure.ts --print-devin — only print the Devin MCP registration JSON
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, cwd } from "node:process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "index.ts");
const args = argv.slice(2);
const YES = args.includes("--yes");
const PRINT_ONLY = args.includes("--print-devin");
const outIdx = args.indexOf("--out");
const outPath =
  outIdx >= 0
    ? args[outIdx + 1]
    : process.env.LOCAL_LLM_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openai-mcp", "config.json");

interface ProviderDraft {
  type: "ollama" | "openai";
  base_url: string;
  default_model?: string;
  api_key_env?: string;
  num_ctx?: number;
  keep_alive?: string;
}

async function probeOllama(url: string): Promise<string[]> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function devinSnippet(env: Record<string, string>): object {
  return {
    mcpServers: {
      local_llm: {
        command: "node",
        args: [serverPath],
        env,
      },
    },
  };
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def: string): Promise<string> => {
    if (YES) return def;
    const a = (await rl.question(`${q} [${def}]: `)).trim();
    return a || def;
  };
  const askBool = async (q: string, def: boolean): Promise<boolean> => {
    const a = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
  };

  console.log("openai-mcp config builder\n");
  const env: Record<string, string> = { LOCAL_LLM_CONFIG: outPath };

  // --- providers ---
  const providers: Record<string, ProviderDraft> = {};
  const seen = await probeOllama("http://localhost:11434");
  if (seen.length) {
    console.log(`Detected ollama at localhost:11434 with models: ${seen.join(", ")}`);
  } else {
    console.log("No ollama detected at localhost:11434 (you can still configure one or an OpenAI-compatible endpoint).");
  }

  let addMore = true;
  while (addMore) {
    const name = await ask("Provider name", Object.keys(providers).length ? `provider${Object.keys(providers).length + 1}` : "local");
    const type = (await ask("Type (ollama/openai)", "ollama")) as "ollama" | "openai";
    const base = await ask("Base URL", type === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1");
    const models = type === "ollama" ? await probeOllama(base) : [];
    const defModel =
      models.find((m) => m.includes("llama3.1:8b")) ?? models.sort((a, b) => a.length - b.length)[0];
    const model = await ask(`Default model${models.length ? ` (installed: ${models.join(", ")})` : ""}`, defModel ?? "llama3.1:8b");
    const p: ProviderDraft = { type, base_url: base, default_model: model };
    if (type === "ollama") {
      p.num_ctx = Number(await ask("num_ctx (context window; smaller = less VRAM)", "16384"));
      p.keep_alive = "5m";
    } else {
      const keyEnv = await ask("API key env var name (blank = none)", "");
      if (keyEnv) p.api_key_env = keyEnv;
    }
    providers[name] = p;
    addMore = await askBool("Add another provider?", false);
  }

  // --- roots ---
  const rootsRaw = await ask(
    "allowed_roots (comma-separated extra dirs beyond the auto-detected project dir; blank = none)",
    "",
  );
  const roots = rootsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const trustCwd = await askBool("Auto-trust the directory Devin launches from (project dir)?", true);

  // --- feature flags ---
  const runCmd = await askBool("Enable whitelisted run_command for the local agent?", true);
  const dynTools = await askBool("Enable runtime tool registration (dynamic tools)?", true);
  if (runCmd) env.LOCAL_LLM_RUN_COMMAND = "1";
  if (dynTools) env.LOCAL_LLM_DYNAMIC_TOOLS = "1";

  rl.close();

  const config = {
    default_provider: Object.keys(providers)[0],
    providers,
    trust_cwd: trustCwd,
    allowed_roots: roots,
    limits: { num_ctx: 16384 },
  };

  if (PRINT_ONLY) {
    console.log("\n--- Devin registration (paste into ~/.config/devin/mcp_config.json) ---");
    console.log(JSON.stringify(devinSnippet(env), null, 2));
    return;
  }

  if (existsSync(outPath)) {
    const backup = `${outPath}.bak-${Date.now()}`;
    copyFileSync(outPath, backup);
    console.log(`\nExisting config backed up to ${backup}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${outPath}`);

  console.log("\n--- Devin registration ---");
  console.log("Add via Devin settings → MCP → Add custom MCP, or paste this into ~/.config/devin/mcp_config.json:\n");
  console.log(JSON.stringify(devinSnippet(env), null, 2));
  console.log("\nSee README for the recommended permissions.allow / permissions.ask lists.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
