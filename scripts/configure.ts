/**
 * Interactive config builder for openai-mcp.
 *   node scripts/configure.ts            — wizard (prefills from existing config if present)
 *   node scripts/configure.ts --yes      — accept all defaults, non-interactive
 *   node scripts/configure.ts --out PATH — write config elsewhere
 *   node scripts/configure.ts --print-devin — only print the Devin MCP registration JSON
 *   node scripts/configure.ts --no-install — don't offer to write Devin config files
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const serverPath = join(projectRoot, "src", "index.ts");
const args = argv.slice(2);
const YES = args.includes("--yes");
const PRINT_ONLY = args.includes("--print-devin");
const NO_INSTALL = args.includes("--no-install");
const outIdx = args.indexOf("--out");
const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const outPath =
  outIdx >= 0 ? args[outIdx + 1] : process.env.LOCAL_LLM_CONFIG ?? join(xdg, "openai-mcp", "config.json");
const devinDir = join(xdg, "devin");
const devinMcpPath = join(devinDir, "mcp_config.json");
const devinConfigPath = join(devinDir, "config.json");

const ALLOW_TOOLS = [
  "chat", "complete", "summarize", "extract", "classify", "map_files",
  "run_local_agent", "list_models", "get_system_resources", "list_staged",
  "get_diff", "discard_write", "get_usage_stats", "list_dynamic_tools",
  "get_command_whitelist", "get_job", "list_jobs", "control_job",
  "get_server_info", "propose_write", "recommend_model", "list_commits",
  "revert_write", "search_models", "list_model_tags", "wait",
].map((t) => `mcp__local_llm__${t}`);

const ASK_TOOLS = [
  "commit_write", "set_write_mode", "pull_model", "download_model",
  "delete_model", "prune_models", "register_tool", "unregister_tool",
  "update_command_whitelist", "unload_model", "uncommit_write", "verify_staged",
].map((t) => `mcp__local_llm__${t}`);

interface ProviderDraft {
  type: "ollama" | "openai";
  base_url: string;
  default_model?: string;
  api_key_env?: string;
  num_ctx?: number;
  keep_alive?: string;
  think?: boolean | "low" | "medium" | "high";
  options?: Record<string, unknown>;
}

interface ExistingConfig {
  default_provider?: string;
  providers?: Record<string, ProviderDraft>;
  trust_cwd?: boolean;
  allowed_roots?: string[];
  write_mode?: "propose" | "write";
  limits?: { num_ctx?: number };
  [k: string]: unknown;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  if (existsSync(path)) {
    const backup = `${path}.bak-${Date.now()}`;
    copyFileSync(path, backup);
    console.log(`  (backed up existing -> ${backup})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
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

function serverEntry(env: Record<string, string>): object {
  return { command: "node", args: [serverPath], env };
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

  // --- deps: the server crashes at spawn with ERR_MODULE_NOT_FOUND without them ---
  if (!existsSync(join(projectRoot, "node_modules", "@modelcontextprotocol"))) {
    console.log("node_modules missing — the MCP server can't start without it.");
    const doInstall = YES || (await askBool(`Run npm install in ${projectRoot}?`, true));
    if (doInstall) {
      execFileSync("npm", ["install"], { cwd: projectRoot, stdio: "inherit" });
    } else {
      console.log("  Skipped — run `npm install` yourself before registering the server.");
    }
  }

  // --- update mode: prefill from existing config ---
  const existing = existsSync(outPath) ? readJson<ExistingConfig>(outPath, {}) : {};
  const isUpdate = Object.keys(existing).length > 0;
  if (isUpdate) {
    console.log(`Found existing config at ${outPath} — prefilling (update mode).`);
    console.log(`  providers: ${Object.keys(existing.providers ?? {}).join(", ") || "none"}`);
  }

  const env: Record<string, string> = { LOCAL_LLM_CONFIG: outPath };

  // --- providers ---
  let providers: Record<string, ProviderDraft> = { ...(existing.providers ?? {}) };
  const seen = await probeOllama("http://localhost:11434");
  if (seen.length) console.log(`Detected ollama at localhost:11434 with models: ${seen.join(", ")}`);

  if (isUpdate && Object.keys(providers).length) {
    const rebuild = await askBool("Reconfigure providers from scratch? (n = keep existing)", false);
    if (rebuild) providers = {};
  }
  if (!Object.keys(providers).length) {
    let addMore = true;
    while (addMore) {
      const name = await ask("Provider name", "local");
      const type = (await ask("Type (ollama/openai)", "ollama")) as "ollama" | "openai";
      const base = await ask("Base URL", type === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1");
      const models = type === "ollama" ? await probeOllama(base) : [];
      const defModel =
        models.find((m) => m.includes("coder")) ?? models.find((m) => m.includes("llama3.1:8b")) ?? models.sort((a, b) => a.length - b.length)[0];
      const model = await ask(`Default model${models.length ? ` (installed: ${models.join(", ")})` : ""}`, defModel ?? "llama3.1:8b");
      const p: ProviderDraft = { type, base_url: base, default_model: model };
      const noThink = await askBool(
        "Disable chain-of-thought by default? (recommended: thinking models like qwen3/gpt-oss/gemma4 spend max_tokens on reasoning, which can empty the answer)",
        true,
      );
      if (noThink) p.think = false;
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
  }

  // --- roots & posture ---
  const rootsRaw = await ask(
    "allowed_roots (comma-separated extra dirs beyond auto-detected project dir; blank = none)",
    (existing.allowed_roots ?? []).join(","),
  );
  const roots = rootsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const trustCwd = await askBool("Auto-trust the directory Devin launches from (project dir)?", existing.trust_cwd ?? true);
  const writeMode = await ask(
    "Write mode — 'propose' (server only stages diffs; Devin applies) or 'write' (commit_write writes to disk)",
    existing.write_mode ?? "propose",
  );

  // --- feature flags ---
  const runCmd = await askBool("Enable whitelisted run_command for the local agent?", true);
  const dynTools = await askBool("Enable runtime tool registration (dynamic tools)?", true);
  if (runCmd) env.LOCAL_LLM_RUN_COMMAND = "1";
  if (dynTools) env.LOCAL_LLM_DYNAMIC_TOOLS = "1";

  const config = {
    ...existing,
    default_provider: existing.default_provider && providers[existing.default_provider]
      ? existing.default_provider
      : Object.keys(providers)[0],
    providers,
    trust_cwd: trustCwd,
    allowed_roots: roots,
    write_mode: writeMode === "write" ? "write" : "propose",
    limits: { ...(existing.limits ?? {}), num_ctx: existing.limits?.num_ctx ?? 16384 },
  };

  if (PRINT_ONLY) {
    console.log("\n--- Devin registration ---");
    console.log(JSON.stringify({ mcpServers: { local_llm: serverEntry(env) } }, null, 2));
    rl.close();
    return;
  }

  writeJson(outPath, config);
  console.log(`\nWrote ${outPath}`);

  // --- Devin install ---
  const install = !NO_INSTALL && (YES || (await askBool(`Install into ${devinMcpPath}?`, true)));
  if (install) {
    const mcpCfg = readJson<{ mcpServers?: Record<string, unknown> }>(devinMcpPath, {});
    mcpCfg.mcpServers = { ...(mcpCfg.mcpServers ?? {}), local_llm: serverEntry(env) };
    writeJson(devinMcpPath, mcpCfg);
    console.log(`Wrote server "local_llm" -> ${devinMcpPath}`);
  }

  const perms = !NO_INSTALL && (YES || (await askBool(`Merge recommended permissions into ${devinConfigPath}?`, true)));
  if (perms) {
    const cfg = readJson<{ permissions?: { allow?: string[]; ask?: string[]; deny?: string[] }; [k: string]: unknown }>(
      devinConfigPath,
      {},
    );
    cfg.permissions = cfg.permissions ?? {};
    const merge = (cur: string[] | undefined, add: string[]): string[] => [...new Set([...(cur ?? []), ...add])];
    const before = {
      allow: (cfg.permissions.allow ?? []).length,
      ask: (cfg.permissions.ask ?? []).length,
    };
    cfg.permissions.allow = merge(cfg.permissions.allow, ALLOW_TOOLS);
    cfg.permissions.ask = merge(cfg.permissions.ask, ASK_TOOLS);
    writeJson(devinConfigPath, cfg);
    console.log(
      `Permissions merged: allow ${before.allow} -> ${cfg.permissions.allow.length}, ask ${before.ask} -> ${cfg.permissions.ask.length}`,
    );
  }
  rl.close();

  if (!install) {
    console.log("\n--- Devin registration (manual) ---");
    console.log("Paste into ~/.config/devin/mcp_config.json:\n");
    console.log(JSON.stringify({ mcpServers: { local_llm: serverEntry(env) } }, null, 2));
  }
  console.log("\nDone. New Devin sessions will pick up the local_llm tools.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
