import { recordDelegatedBytes, recordUsage, type ToolUsage } from "../lib/usage.ts";
import type { ChatRequest, ChatResult, Provider } from "../providers/index.ts";
import { z } from "zod";

/** Generation params shared by all local-LLM tool schemas; forwarded onto ChatRequest. */
export const GEN_PARAMS = {
  think: z
    .union([z.boolean(), z.enum(["low", "medium", "high"])])
    .optional()
    .describe(
      "Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). " +
        "think:false keeps the whole max_tokens budget for the answer.",
    ),
  top_p: z.number().optional().describe("Nucleus sampling threshold."),
  seed: z.number().int().optional().describe("Fixed seed for reproducible output."),
  stop: z.array(z.string()).optional().describe("Stop sequences."),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Provider-native overrides merged into the request (ollama `options` keys like " +
        "top_k/repeat_penalty; openai-compatible body fields). Wins over named params.",
    ),
};

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

/**
 * MCP progress reporter. Sends `notifications/progress` ONLY if the client
 * supplied a progressToken in the request's _meta — these go to client UI
 * plumbing, NOT into the model's context, so they cost zero tokens.
 */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

export function makeProgress(extra: ProgressExtra, total?: number) {
  const token = extra._meta?.progressToken;
  let n = 0;
  return (message: string, progress?: number): void => {
    if (token === undefined) return;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: progress ?? ++n, total, message },
      })
      .catch(() => {});
  };
}

/** Resolve `p`, or "timeout" if `ms` elapses first. `p` keeps running either way. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ms))]);
}

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
