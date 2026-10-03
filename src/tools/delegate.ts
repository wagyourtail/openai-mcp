import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { jsonResult, makeProgress, trackedChat, withTimeout, type ProgressExtra } from "./helpers.ts";
import { recordUsage } from "../lib/usage.ts";
import { runAgentLoop, type LocalTool } from "../lib/agent-loop.ts";
import { buildLocalTools } from "../lib/local-tools.ts";
import { listOps } from "../lib/staging.ts";
import { createJob, finishJob, updateJob } from "../lib/jobs.ts";

const SYSTEM = `You are a careful local subagent completing a delegated task on the user's machine.
Rules:
- Use the provided tools to read/search files and run whitelisted commands. Do not guess at file contents.
- NEVER claim to have modified a file. Any change must go through stage_write, which only creates a reviewable draft.
- Your final message MUST directly answer the task. If the task asks a question, give the answer. If it asks for an action, state what you did. Only mention staged op ids when you actually created staged writes.
- If the task is too hard or ambiguous, say so plainly instead of producing garbage.`;

interface DelegateParams {
  task: string;
  context?: string;
  files?: string[];
  paths?: string[];
  allowed_tools?: string[];
  model?: string;
  provider?: string;
  num_ctx?: number;
  max_steps?: number;
  temperature?: number;
  think?: boolean | "low" | "medium" | "high";
  options?: Record<string, unknown>;
  timeout_s?: number;
  verify?: "none" | "self";
}

async function doDelegate(
  ctx: ServerContext,
  p: DelegateParams,
  report: (msg: string, progress?: number) => void,
  control?: { paused: boolean; cancelled: boolean; mailbox: string[] },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { provider, model: m } = pickModel(ctx, p.provider, p.model);
  const limits = ctx.config.limits;

  // Inline requested files into the task (server-side reads → delegated bytes).
  let taskBody = p.task;
  let delegated = 0;
  if (p.files?.length) {
    if (p.files.length > limits.max_map_files) {
      throw new Error(`files[] has ${p.files.length} entries (max ${limits.max_map_files}) — use \`paths\` instead so the agent reads them on demand`);
    }
    const blocks: string[] = [];
    for (const f of p.files) {
      const { content, bytes, truncated } = await ctx.guard.readFile(f);
      delegated += bytes;
      blocks.push(`--- ${f}${truncated ? " (TRUNCATED)" : ""} ---\n${content}`);
    }
    taskBody += `\n\nRelevant file contents:\n${blocks.join("\n\n")}`;
  }
  if (p.context) taskBody = `${taskBody}\n\nContext: ${p.context}`;
  if (p.paths?.length) {
    // Validate each through the guard, but only names go into the prompt.
    const checked = p.paths.map((pth) => ctx.guard.resolve(pth));
    taskBody += `\n\nFiles/dirs available (read them with tools as needed):\n${checked.map((pth) => `- ${pth}`).join("\n")}`;
  }
  const effectiveNumCtx = p.num_ctx ?? limits.num_ctx;
  const estTokens = Math.ceil(taskBody.length / 4);
  const contextWarning =
    estTokens > effectiveNumCtx * 0.6
      ? `task + inlined files ≈ ${estTokens} tokens vs num_ctx ${effectiveNumCtx} — the local model will likely lose the thread. Use \`paths\` instead of \`files\` or raise num_ctx.`
      : undefined;

  const localTools = buildLocalTools({
    guard: ctx.guard,
    whitelist: ctx.config.command_whitelist,
    runCommandEnabled: ctx.env.runCommand,
    stageTtlMs: limits.stage_ttl_s * 1000,
    runCommandTimeoutS: limits.run_command_timeout_s,
    runCommandOutputChars: limits.run_command_output_chars,
    searchOutputChars: limits.max_tool_result_chars,
  });
  const tools: LocalTool[] = p.allowed_tools?.length
    ? localTools.filter((t) => p.allowed_tools!.includes(t.spec.name))
    : localTools;

  const opsBefore = new Set(listOps().map((o) => o.id));
  const t0 = Date.now();
  const result = await runAgentLoop({
    provider,
    model: m,
    system: SYSTEM,
    task: taskBody,
    tools,
    maxSteps: Math.min(p.max_steps ?? limits.max_steps, limits.max_steps),
    temperature: p.temperature,
    numCtx: effectiveNumCtx,
    think: p.think,
    options: p.options,
    timeoutS: p.timeout_s ?? limits.agent_timeout_s,
    toolResultChars: limits.max_tool_result_chars,
    onProgress: ({ step, note }) => report(note, step),
    control,
    signal,
  });
  const newOps = listOps().filter((o) => !opsBefore.has(o.id));

  delegated += result.delegatedBytes; // file content the agent's own tools read
  const usage = {
    provider: provider.name,
    model: m,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    llmCalls: result.usage.calls,
    elapsedMs: Date.now() - t0,
  };
  recordUsage(
    "run_local_agent",
    {
      provider: provider.name,
      model: m,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      elapsedMs: usage.elapsedMs,
    },
    delegated,
    usage.llmCalls,
  );

  // Optional cheap self-verification pass.
  let verification: Record<string, unknown> | undefined;
  if (p.verify === "self") {
    report("verify: self-check pass");
    const check = await trackedChat("run_local_agent", provider, {
      model: m,
      temperature: 0,
      num_ctx: p.num_ctx,
      think: p.think,
      options: p.options,
      messages: [
        { role: "system", content: 'You verify another model\'s work. Reply with JSON: {"verdict":"ok"|"suspect","reason":"one line"}' },
        { role: "user", content: `Task: ${p.task}\n\nProduced result:\n${result.finalAnswer}\n\nStaged ops: ${newOps.map((o) => `${o.id}:${o.path}`).join(", ") || "none"}` },
      ],
      response_format: "json",
    });
    try {
      const v = JSON.parse(check.res.content) as { verdict?: string; reason?: string };
      verification = { verdict: v.verdict ?? "unknown", reason: v.reason, needs_review: v.verdict === "suspect" };
    } catch {
      verification = { verdict: "unknown", needs_review: true, reason: "verifier returned non-JSON" };
    }
  }

  return {
    final_answer: result.finalAnswer,
    steps: result.steps,
    staged_ops: newOps.map((o) => ({ id: o.id, path: o.path, kind: o.existedBefore ? "modify" : "create" })),
    ...(result.aborted ? { aborted: result.aborted } : {}),
    ...(verification ? { verification } : {}),
    ...(contextWarning ? { context_warning: contextWarning } : {}),
    delegated_bytes: delegated,
    usage,
    note: newOps.length
      ? ctx.writeMode === "write"
        ? "Staged writes are NOT on disk. Review with get_diff(op_id), then commit_write or discard_write."
        : "Staged writes are NOT on disk (write_mode=propose). Review with get_diff(op_id) and apply with your own tools, or discard_write."
      : undefined,
  };
}

export function registerDelegateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "run_local_agent",
    {
      description:
        "Delegate a low-complexity task to the LOCAL SUBAGENT: the cheap model runs its own tool " +
        "loop (read_file, list_dir, search_files, stage_write, whitelisted run_command, plus any " +
        "registered dynamic tools) entirely server-side. File contents and intermediate steps never " +
        "enter your context — you get back a compact final answer + staged-write op ids to review. " +
        "Use for mechanical, monotonous, or bulk work: finding things, transforming files, answering " +
        "questions over many files. Do NOT delegate work needing real reasoning, security judgment, or " +
        "architecture decisions.",
      inputSchema: {
        task: z.string().describe("Self-contained task description. The local agent sees ONLY this text + optional context/files — include paths, names, and exactly what to return."),
        context: z.string().optional().describe("Extra background for the local agent (kept compact)."),
        files: z.array(z.string()).optional().describe("File paths to read server-side and inline into the task (contents bypass your context). Keep this small — it consumes the local model's context window."),
        paths: z.array(z.string()).optional().describe("File/dir paths to tell the agent about WITHOUT inlining contents — it reads them via tools as needed. Better for many/large files."),
        allowed_tools: z.array(z.string()).optional().describe("Subset of local tools to permit, e.g. [\"read_file\",\"search_files\"]. Default: all built-ins + dynamic tools."),
        model: z.string().optional(),
        provider: z.string().optional(),
        num_ctx: z.number().int().optional().describe("Context window for the local model (ollama only). Smaller = less VRAM."),
        max_steps: z.number().int().optional(),
        temperature: z.number().optional(),
        think: z
          .union([z.boolean(), z.enum(["low", "medium", "high"])])
          .optional()
          .describe("Chain-of-thought control for the agent's model (ollama `think`). think:false leaves more context/steps for tool calls on thinking models."),
        options: z.record(z.string(), z.unknown()).optional().describe("Provider-native request overrides (ollama `options` keys / openai body fields)."),
        timeout_s: z.number().int().optional(),
        verify: z.enum(["none", "self"]).optional().describe('"self" = a second local pass critiques the result and flags it needs_review if it looks wrong.'),
        run_async: z.boolean().optional().describe("true = run as a background job; returns job_id immediately, poll get_job for progress + result. false = synchronous, but if the task outlasts config agent_sync_grace_ms the call returns a job_id so the result is never lost. Default: config agent_async."),
      },
    },
    async (params, extra) => {
      const report = makeProgress(extra as ProgressExtra, params.max_steps);
      const job = createJob("run_local_agent");
      updateJob(job.id, { task: params.task.slice(0, 200) });
      const ac = new AbortController();
      job.abort = () => ac.abort();
      const run = doDelegate(
        ctx,
        params,
        (msg, n) => {
          updateJob(job.id, { step: n, last: msg });
          report(msg, n);
        },
        job.control,
        ac.signal,
      ).then(
        (r) => {
          finishJob(job.id, undefined, r);
          return { ok: true as const, result: r };
        },
        (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          finishJob(job.id, msg);
          return { ok: false as const, error: msg };
        },
      );
      const jobRef = () =>
        jsonResult({
          job_id: job.id,
          note: "Poll get_job(job_id) for progress; result lands in job.result. Steer it with control_job (pause/resume/cancel/inject).",
        });
      if (params.run_async ?? ctx.config.agent_async) return jobRef();
      const out = await withTimeout(run, ctx.config.agent_sync_grace_ms);
      if (out === "timeout") return jobRef();
      if (!out.ok) throw new Error(out.error);
      return jsonResult(out.result);
    },
  );
}
