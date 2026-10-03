import type { Config } from "../config.ts";
import type { Provider } from "./types.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";

export type { Provider } from "./types.ts";
export * from "./types.ts";

export interface Providers {
  get(name?: string): Provider;
  names(): string[];
  default: Provider;
}

export function buildProviders(config: Config): Providers {
  const map = new Map<string, Provider>();
  for (const [name, cfg] of Object.entries(config.providers)) {
    // Ollama defaults to the model's FULL context window — on llama3.1:8b that's
    // a 128k ctx / ~8GB KV cache, which can exceed free VRAM. Always bound it.
    if (cfg.type === "ollama" && cfg.num_ctx === undefined) {
      cfg.num_ctx = config.limits.num_ctx;
    }
    map.set(
      name,
      cfg.type === "ollama" ? new OllamaProvider(name, cfg) : new OpenAICompatProvider(name, cfg),
    );
  }
  const providers: Providers = {
    get(name?: string): Provider {
      const key = name ?? config.default_provider;
      const p = map.get(key);
      if (!p) {
        throw new Error(
          `unknown provider "${key}". configured: ${[...map.keys()].join(", ") || "(none)"}`,
        );
      }
      return p;
    },
    names: () => [...map.keys()],
    get default() {
      return providers.get();
    },
  };
  return providers;
}
