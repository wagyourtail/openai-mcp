import { recordDelegatedBytes, recordUsage, type ToolUsage } from "../lib/usage.ts";
import type { ChatRequest, ChatResult, Provider } from "../providers/index.ts";

let requestTimeoutMs = 300_000;

/** Called once at startup from config.limits.request_timeout_s. */
export function setRequestTimeout(ms: number): void {
  requestTimeoutMs = ms;
}

/** Wrap a result object as an MCP tool response (text + structured). */
export function jsonResult(obj: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

/**
 * Small models love wrapping output in ``` fences — which would otherwise get
 * staged into files. Strip a single outer fenced block if present.
 */
export function stripFences(text: string): string {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (!m) return text;
  const inner = m[1];
  return text.endsWith("\n") && !inner.endsWith("\n") ? inner + "\n" : inner;
}

/** Run a provider.chat, tracking elapsed time + session usage. */
export async function trackedChat(
  tool: string,
  provider: Provider,
  req: ChatRequest,
  delegatedBytes = 0,
): Promise<{ res: ChatResult; usage: ToolUsage }> {
  const t0 = Date.now();
  req.signal ??= AbortSignal.timeout(requestTimeoutMs);
  const res = await provider.chat(req);
  const usage: ToolUsage = {
    provider: provider.name,
    model: res.model,
    promptTokens: res.usage.promptTokens,
    completionTokens: res.usage.completionTokens,
    elapsedMs: Date.now() - t0,
  };
  recordUsage(tool, usage, delegatedBytes);
  return { res, usage };
}

export { recordDelegatedBytes };

/** Run `fn` over items with a concurrency cap; preserves input order in results. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}
