import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ProviderConfigSchema = z.object({
  type: z.enum(["ollama", "openai"]),
  base_url: z.string().url(),
  api_key_env: z.string().optional(),
  default_model: z.string().optional(),
  num_ctx: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  /** Default think setting for all requests to this provider (e.g. false for thinking models). */
  think: z.union([z.boolean(), z.enum(["low", "medium", "high"])]).optional(),
  /** Provider-native default options merged into every request (ollama `options` keys / openai body fields). */
  options: z.record(z.string(), z.unknown()).optional(),
  keep_alive: z.string().optional(),
});

const WhitelistEntrySchema = z.object({
  allow_args: z.array(z.string()).nullable().optional(),
});

const LimitsSchema = z.object({
  max_read_bytes: z.number().int().positive().default(512 * 1024),
  max_steps: z.number().int().positive().default(12),
  agent_timeout_s: z.number().int().positive().default(120),
  stage_ttl_s: z.number().int().positive().default(1800),
  max_result_chars: z.number().int().positive().default(16000),
  max_tool_result_chars: z.number().int().positive().default(8000),
  max_map_files: z.number().int().positive().default(50),
  max_glob_matches: z.number().int().positive().default(500),
  request_timeout_s: z.number().int().positive().default(300),
  run_command_timeout_s: z.number().int().positive().default(30),
  run_command_output_chars: z.number().int().positive().default(8000),
  num_ctx: z.number().int().positive().default(16384),
});

export const ConfigSchema = z.object({
  default_provider: z.string().default("local"),
  default_model: z.string().optional(),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  allowed_roots: z.array(z.string()).default([]),
  trust_cwd: z.boolean().default(true),
  deny_globs: z.array(z.string()).default([
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/.ssh/**",
    "**/secrets/**",
  ]),
  command_whitelist: z
    .object({
      enabled: z.boolean().default(true),
      commands: z.record(z.string(), WhitelistEntrySchema).default({}),
    })
    .default({ enabled: true, commands: {} }),
  write_mode: z.enum(["propose", "write"]).default("propose"),
  /** When true, run_local_agent runs as a background job unless run_async is explicitly false. */
  agent_async: z.boolean().default(false),
  /** How long a synchronous run_local_agent call waits before returning a job_id instead of the result. */
  agent_sync_grace_ms: z.number().int().positive().default(45_000),
  limits: LimitsSchema.default({}),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "openai-mcp");
}

export function configPath(): string {
  return process.env.LOCAL_LLM_CONFIG ?? join(configDir(), "config.json");
}

export function dynamicToolsPath(): string {
  return join(configDir(), "dynamic_tools.json");
}

const DEFAULT_COMMANDS: Record<string, { allow_args: string[] | null }> = {
  ls: { allow_args: null },
  cat: { allow_args: null },
  head: { allow_args: null },
  tail: { allow_args: null },
  wc: { allow_args: null },
  sort: { allow_args: null },
  uniq: { allow_args: null },
  grep: { allow_args: null },
  rg: { allow_args: null },
  find: { allow_args: null },
  file: { allow_args: null },
  stat: { allow_args: null },
  jq: { allow_args: null },
  git: { allow_args: ["status", "log", "diff", "show", "grep", "ls-files", "rev-parse", "branch"] },
};

export function loadConfig(): { config: Config; path: string; exists: boolean } {
  const path = configPath();
  let raw: unknown = {};
  const exists = existsSync(path);
  if (exists) {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  }

  // Env-var single-provider quickstart: LOCAL_LLM_BASE_URL etc.
  const envBase = process.env.LOCAL_LLM_BASE_URL;
  const parsed = ConfigSchema.parse(raw);
  if (envBase && !parsed.providers[process.env.LOCAL_LLM_PROVIDER_NAME ?? "local"]) {
    parsed.providers[process.env.LOCAL_LLM_PROVIDER_NAME ?? "local"] = {
      type: (process.env.LOCAL_LLM_PROVIDER_TYPE as "ollama" | "openai") ?? "openai",
      base_url: envBase,
      api_key_env: process.env.LOCAL_LLM_API_KEY_ENV ?? undefined,
      default_model: process.env.LOCAL_LLM_MODEL,
    };
  }
  if (Object.keys(parsed.providers).length === 0) {
    parsed.providers.local = {
      type: "ollama",
      base_url: "http://localhost:11434",
      default_model: process.env.LOCAL_LLM_MODEL ?? "llama3.1:8b",
      num_ctx: parsed.limits.num_ctx,
      temperature: 0.2,
      keep_alive: "5m",
    };
  }
  if (process.env.LOCAL_LLM_MODEL && !parsed.default_model) {
    parsed.default_model = process.env.LOCAL_LLM_MODEL;
  }
  if (Object.keys(parsed.command_whitelist.commands).length === 0) {
    parsed.command_whitelist.commands = { ...DEFAULT_COMMANDS };
  }
  return { config: parsed, path, exists };
}

/** Merge top-level keys into the config file on disk (creating it if needed). */
export async function patchConfig(path: string, patch: Record<string, unknown>): Promise<void> {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  }
  Object.assign(raw, patch);
  mkdirSync(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

/** Merge keys into providers.<name> in the config file (creating it if needed). */
export async function patchProvider(
  path: string,
  provider: string,
  patch: Record<string, unknown>,
): Promise<void> {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  }
  const providers = (raw.providers ??= {}) as Record<string, Record<string, unknown>>;
  Object.assign((providers[provider] ??= {}), patch);
  mkdirSync(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

export async function saveCommandWhitelist(
  path: string,
  commands: Record<string, { allow_args?: string[] | null }>,
  enabled: boolean,
): Promise<void> {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  }
  raw.command_whitelist = { enabled, commands };
  mkdirSync(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}
