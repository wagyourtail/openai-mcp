import type { ChatMessage, Provider, ToolCall, ToolSpec, Usage } from "../providers/index.ts";
import type { JobControl } from "./jobs.ts";

export interface LocalTool {
  spec: ToolSpec;
  /** Results are file content — count them toward delegated_bytes. */
  delegates?: boolean;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface StepRecord {
  step: number;
  toolCalls: { name: string; arguments: Record<string, unknown>; result: string; ok: boolean }[];
  assistantNote?: string;
}

export interface AgentLoopResult {
  finalAnswer: string;
  steps: StepRecord[];
  usage: Usage & { calls: number };
  /** Bytes of file content returned by tools flagged `delegates`. */
  delegatedBytes: number;
  aborted?: string;
}

const LOOP_LIMIT = 3; // identical call signature this many times -> abort

/**
 * Tool-calling loop for the local model. All tool execution happens here —
 * the model's file reads/searches never leave this process.
 */
export async function runAgentLoop(params: {
  provider: Provider;
  model: string;
  system: string;
  task: string;
  tools: LocalTool[];
  maxSteps: number;
  temperature?: number;
  numCtx?: number;
  think?: boolean | "low" | "medium" | "high";
  options?: Record<string, unknown>;
  timeoutS: number;
  toolResultChars: number;
  onProgress?: (info: { step: number; note: string }) => void;
  /** Operator control for async jobs: pause gate, cancel flag, injectable mailbox. */
  control?: JobControl;
  /** Abort signal tied to control.cancelled (kills an in-flight chat request). */
  signal?: AbortSignal;
}): Promise<AgentLoopResult> {
  const { provider, model } = params;
  const messages: ChatMessage[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.task },
  ];
  const toolMap = new Map(params.tools.map((t) => [t.spec.name, t]));
  const specs = params.tools.map((t) => t.spec);
  const steps: StepRecord[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let delegatedBytes = 0;
  const callCounts = new Map<string, number>();
  const deadline = Date.now() + params.timeoutS * 1000;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const finish = (extra?: Partial<AgentLoopResult>): AgentLoopResult => ({
    finalAnswer: lastAssistantContent(messages),
    steps,
    usage,
    delegatedBytes,
    ...extra,
  });

  for (let step = 1; step <= params.maxSteps; step++) {
    if (Date.now() > deadline) {
      return finish({ aborted: "timeout" });
    }
    // Operator controls (async jobs only): cancel, pause gate, injected messages.
    const ctl = params.control;
    if (ctl?.cancelled) return finish({ aborted: "cancelled by operator" });
    while (ctl?.paused && !ctl.cancelled) {
      if (Date.now() > deadline) return finish({ aborted: "timeout while paused" });
      await sleep(400);
    }
    if (ctl?.cancelled) return finish({ aborted: "cancelled by operator" });
    if (ctl?.mailbox.length) {
      for (const msg of ctl.mailbox.splice(0)) {
        messages.push({ role: "user", content: `[operator instruction — adjust course] ${msg}` });
        params.onProgress?.({ step, note: `injected: ${msg.slice(0, 80)}` });
      }
    }

    let res;
    try {
      res = await provider.chat({
        model,
        messages,
        tools: specs.length ? specs : undefined,
        temperature: params.temperature ?? 0.2,
        num_ctx: params.numCtx,
        think: params.think,
        options: params.options,
        signal: params.signal
          ? AbortSignal.any([AbortSignal.timeout(Math.max(1000, deadline - Date.now())), params.signal])
          : AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (e) {
      if (ctl?.cancelled || params.signal?.aborted) {
        return finish({ aborted: "cancelled by operator" });
      }
      throw e;
    }
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    usage.calls++;

    // Small models sometimes emit the tool call as JSON text in content rather
    // than the structured tool_calls field (e.g. qwen2.5-coder on older Ollama).
    const toolCalls =
      res.toolCalls.length > 0
        ? res.toolCalls
        : specs.length
          ? salvageToolCalls(res.content, toolMap)
          : [];
    if (toolCalls.length === 0) {
      return { finalAnswer: res.content, steps, usage, delegatedBytes };
    }

    messages.push({ role: "assistant", content: res.content, tool_calls: toolCalls });
    const record: StepRecord = {
      step,
      toolCalls: [],
      assistantNote: res.content?.slice(0, 500) || undefined,
    };

    let abort: string | undefined;
    for (const tc of toolCalls) {
      const sig = `${tc.name}(${stableJson(tc.arguments)})`;
      const n = (callCounts.get(sig) ?? 0) + 1;
      callCounts.set(sig, n);
      if (n >= LOOP_LIMIT) {
        abort = `loop detected: ${sig} called ${n}x with identical arguments`;
      }

      const tool = toolMap.get(tc.name);
      let result: string;
      let ok = true;
      if (!tool) {
        result = `error: unknown tool "${tc.name}". available: ${[...toolMap.keys()].join(", ")}`;
        ok = false;
      } else {
        try {
          result = await tool.execute(tc.arguments);
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
          ok = false;
        }
      }
      if (ok && tool?.delegates) delegatedBytes += Buffer.byteLength(result, "utf8");
      const truncated =
        result.length > params.toolResultChars
          ? result.slice(0, params.toolResultChars) + `\n...[truncated ${result.length - params.toolResultChars} chars]`
          : result;
      record.toolCalls.push({ name: tc.name, arguments: tc.arguments, result: truncated.slice(0, 2000), ok });
      messages.push({ role: "tool", name: tc.name, tool_call_id: tc.id, content: truncated });
    }
    steps.push(record);
    params.onProgress?.({
      step,
      note: `step ${step}: ${record.toolCalls.map((t) => t.name).join(", ") || "final answer"}`,
    });
    if (abort) {
      return finish({ aborted: abort });
    }
  }
  return finish({ aborted: `max_steps (${params.maxSteps}) reached` });
}

/**
 * Small models (notably qwen2.5-coder on older Ollama) sometimes emit a tool
 * call as plain JSON text instead of the structured tool_calls field. Salvage
 * it by parsing content for {name, arguments} shapes — but only when `name`
 * matches a registered tool, so a real answer that happens to be JSON isn't
 * hijacked into a spurious call.
 */
export function salvageToolCalls(content: string, tools: Map<string, LocalTool>): ToolCall[] {
  const candidates: string[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    candidates.push(m[1]);
  }
  let body = content.trim();
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) body = fence[1].trim();
  if (candidates.length === 0 && (body.startsWith("{") || body.startsWith("["))) {
    candidates.push(body);
  }
  const out: ToolCall[] = [];
  for (const cand of candidates) {
    let v: unknown;
    try {
      v = JSON.parse(cand);
    } catch {
      continue;
    }
    for (const item of Array.isArray(v) ? v : [v]) {
      const tc = asToolCall(item);
      if (tc && tools.has(tc.name)) {
        out.push({ id: `salvaged_${out.length}`, name: tc.name, arguments: tc.arguments });
      }
    }
  }
  return out;
}

/** Coerce {name, arguments} / {name, parameters} / {function:{name, arguments}} into a ToolCall shape. */
function asToolCall(v: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const fn =
    o.function && typeof o.function === "object" && !Array.isArray(o.function)
      ? (o.function as Record<string, unknown>)
      : o;
  if (typeof fn.name !== "string" || !fn.name) return null;
  let args: unknown = fn.arguments ?? fn.parameters ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  return { name: fn.name, arguments: args as Record<string, unknown> };
}

function lastAssistantContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content) return messages[i].content;
  }
  return "(no final answer produced)";
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
