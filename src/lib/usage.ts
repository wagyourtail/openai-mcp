export interface ToolUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}

interface SessionStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  delegatedBytes: number;
  byTool: Record<string, { calls: number; promptTokens: number; completionTokens: number; delegatedBytes: number }>;
  startedAt: string;
}

const stats: SessionStats = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  delegatedBytes: 0,
  byTool: {},
  startedAt: new Date().toISOString(),
};

export function recordUsage(tool: string, u: ToolUsage, delegatedBytes = 0, calls = 1): void {
  stats.calls += calls;
  stats.promptTokens += u.promptTokens;
  stats.completionTokens += u.completionTokens;
  stats.delegatedBytes += delegatedBytes;
  const t = (stats.byTool[tool] ??= { calls: 0, promptTokens: 0, completionTokens: 0, delegatedBytes: 0 });
  t.calls += calls;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.delegatedBytes += delegatedBytes;
}

/** Bytes the local model processed that would otherwise have entered the caller's context. */
export function recordDelegatedBytes(tool: string, bytes: number): void {
  stats.delegatedBytes += bytes;
  const t = (stats.byTool[tool] ??= { calls: 0, promptTokens: 0, completionTokens: 0, delegatedBytes: 0 });
  t.delegatedBytes += bytes;
}

export function getStats(): SessionStats {
  return JSON.parse(JSON.stringify(stats));
}
