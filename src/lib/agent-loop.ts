import type { ChatMessage, Provider, ToolSpec, Usage } from "../providers/index.ts";
import type { JobControl } from "./jobs.ts";

export interface LocalTool {
  spec: ToolSpec;
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
  const callCounts = new Map<string, number>();
  const deadline = Date.now() + params.timeoutS * 1000;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const finish = (extra?: Partial<AgentLoopResult>): AgentLoopResult => ({
    finalAnswer: lastAssistantContent(messages),
    steps,
    usage,
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

    if (res.toolCalls.length === 0) {
      return { finalAnswer: res.content, steps, usage };
    }

    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    const record: StepRecord = {
      step,
      toolCalls: [],
      assistantNote: res.content?.slice(0, 500) || undefined,
    };

    let abort: string | undefined;
    for (const tc of res.toolCalls) {
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
      return { finalAnswer: lastAssistantContent(messages), steps, usage, aborted: abort };
    }
  }
  return {
    finalAnswer: lastAssistantContent(messages),
    steps,
    usage,
    aborted: `max_steps (${params.maxSteps}) reached`,
  };
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
