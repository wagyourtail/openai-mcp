import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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
  recordModelUse(u.model);
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

// ---------------------------------------------------------------------------
// Per-model last-used ledger — powers prune_models unused_days. Persisted next
// to the server config so it survives restarts; best-effort (never throws).
// ---------------------------------------------------------------------------

let modelUsePath = "";
let modelUseLoaded = false;
let modelUse: Record<string, string> = {};

function modelUseFile(): string {
  if (!modelUsePath) {
    const cfg = process.env.LOCAL_LLM_CONFIG;
    const dir = cfg ? dirname(cfg) : join(process.env.HOME ?? ".", ".config", "openai-mcp");
    modelUsePath = join(dir, "model-usage.json");
  }
  return modelUsePath;
}

function loadModelUse(): Record<string, string> {
  if (!modelUseLoaded) {
    modelUseLoaded = true;
    try {
      modelUse = JSON.parse(readFileSync(modelUseFile(), "utf-8")) as Record<string, string>;
    } catch {
      modelUse = {};
    }
  }
  return modelUse;
}

export function recordModelUse(model: string): void {
  if (!model) return;
  loadModelUse()[model] = new Date().toISOString();
  try {
    mkdirSync(dirname(modelUseFile()), { recursive: true });
    writeFileSync(modelUseFile(), JSON.stringify(modelUse, null, 2));
  } catch {
    /* read-only fs or unwritable dir — ledger is best-effort */
  }
}

/** model id -> ISO timestamp of last recorded inference. */
export function getModelUse(): Record<string, string> {
  return { ...loadModelUse() };
}
