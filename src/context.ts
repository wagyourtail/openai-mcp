import { loadConfig, type Config } from "./config.ts";
import { buildProviders, type Providers } from "./providers/index.ts";
import { FsGuard } from "./lib/fs-guard.ts";

export interface ServerContext {
  config: Config;
  configPath: string;
  providers: Providers;
  guard: FsGuard;
  /** "propose" = staged ops only, commit_write refused. "write" = commits allowed. */
  writeMode: "propose" | "write";
  env: {
    runCommand: boolean;
    dynamicTools: boolean;
  };
}

export function buildContext(): ServerContext {
  const { config, path } = loadConfig();
  const providers = buildProviders(config);
  const guard = new FsGuard(config.allowed_roots, config.deny_globs, config.limits.max_read_bytes);
  return {
    config,
    configPath: path,
    providers,
    guard,
    writeMode: config.write_mode,
    env: {
      runCommand: process.env.LOCAL_LLM_RUN_COMMAND === "1",
      dynamicTools: process.env.LOCAL_LLM_DYNAMIC_TOOLS === "1",
    },
  };
}

/** Resolve model for a call: explicit arg > provider default > config default > error. */
export function pickModel(ctx: ServerContext, providerName: string | undefined, model: string | undefined): { provider: ReturnType<Providers["get"]>; model: string } {
  const provider = ctx.providers.get(providerName);
  const m = model ?? provider.defaultModel ?? ctx.config.default_model;
  if (!m) {
    throw new Error(
      `no model specified and no default configured (provider "${provider.name}" has no default_model; ` +
        `config default_model unset). Pass \`model\` explicitly — use list_models to see options.`,
    );
  }
  return { provider, model: m };
}
