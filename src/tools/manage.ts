import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.ts";
import { jsonResult } from "./helpers.ts";
import { controlJob, createJob, finishJob, getJob, listJobs, updateJob, type JobAction } from "../lib/jobs.ts";
import { systemResources } from "../lib/sysinfo.ts";
import { getStats } from "../lib/usage.ts";
import { safeEnv } from "../lib/whitelist.ts";

let hfCli: string | null | undefined;
async function findHfCli(): Promise<string | null> {
  if (hfCli !== undefined) return hfCli;
  for (const bin of ["hf", "huggingface-cli"]) {
    try {
      await new Promise<void>((res, rej) =>
        execFile(bin, ["version"], { timeout: 5000, env: safeEnv() }, (e) => (e ? rej(e) : res())),
      );
      hfCli = bin;
      return bin;
    } catch {
      /* try next */
    }
  }
  hfCli = null;
  return null;
}

export function registerManageTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_models",
    {
      description:
        "List models available on a provider. For ollama providers includes size, parameter count, " +
        "quantization and capabilities — use this plus get_system_resources to pick the biggest model that fits VRAM.",
      inputSchema: {
        provider: z.string().optional().describe("Provider name (default: default_provider, or 'all' for every provider)"),
      },
    },
    async ({ provider: pName }) => {
      if (pName === "all") {
        const out: Record<string, unknown> = {};
        for (const n of ctx.providers.names()) {
          try {
            out[n] = { models: await ctx.providers.get(n).listModels() };
          } catch (e) {
            out[n] = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        return jsonResult({ providers: out });
      }
      const p = ctx.providers.get(pName);
      return jsonResult({ provider: p.name, models: await p.listModels() });
    },
  );

  server.registerTool(
    "get_system_resources",
    {
      description:
        "Report host RAM + GPU VRAM and currently-loaded models. Only works for LOCAL ollama " +
        "providers — returns {unavailable: true} for remote/openai-type providers. Use before picking " +
        "a model or num_ctx for heavy jobs.",
      inputSchema: { provider: z.string().optional() },
    },
    async ({ provider: pName }) => {
      const p = ctx.providers.get(pName);
      if (!p.isLocal || p.type !== "ollama") {
        return jsonResult({
          unavailable: true,
          reason: `provider "${p.name}" is ${p.isLocal ? "not an ollama provider" : "remote"} — host resource info only available for local ollama`,
        });
      }
      const res = await systemResources();
      const loaded = p.ps ? await p.ps() : [];
      return jsonResult({ provider: p.name, ...res, loaded_models: loaded });
    },
  );

  server.registerTool(
    "pull_model",
    {
      description:
        "Download a model on an ollama provider (e.g. 'qwen2.5-coder:7b'). Runs as a background job — " +
        "returns a job_id; poll progress with get_job. Only for ollama providers.",
      inputSchema: {
        model: z.string().describe("Model name to pull"),
        provider: z.string().optional(),
      },
    },
    async ({ model, provider: pName }) => {
      const p = ctx.providers.get(pName);
      if (!p.pull) {
        throw new Error(`provider "${p.name}" (${p.type}) does not support model pulls — ollama providers only`);
      }
      const job = createJob("pull_model");
      updateJob(job.id, { model, provider: p.name });
      const ac = new AbortController();
      job.abort = () => ac.abort();
      p.pull(model, (prog) => updateJob(job.id, { model, ...prog }), ac.signal)
        .then(() => finishJob(job.id))
        .catch((e) => finishJob(job.id, e instanceof Error ? e.message : String(e)));
      return jsonResult({ job_id: job.id, model, provider: p.name, note: "Poll get_job for progress." });
    },
  );

  server.registerTool(
    "download_model",
    {
      description:
        "Download a model from Hugging Face via the `hf` CLI (for llama.cpp/TabbyAPI/vLLM-style " +
        "servers where pull_model doesn't apply). Runs as a background job — poll with get_job. " +
        "e.g. repo 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF' with include '*Q4_K_M*'.",
      inputSchema: {
        repo: z.string().describe("HF repo id, e.g. 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF'"),
        include: z.string().optional().describe("Filename glob filter, e.g. '*Q4_K_M*.gguf'"),
        local_dir: z.string().optional().describe("Destination dir (must be inside allowed roots; default: HF cache)"),
        revision: z.string().optional().describe("Branch/tag/commit (default: main)"),
      },
    },
    async ({ repo, include, local_dir, revision }) => {
      const bin = await findHfCli();
      if (!bin) {
        throw new Error("no Hugging Face CLI found — install `huggingface_hub` (provides `hf`) to use download_model");
      }
      const argv = ["download", repo];
      if (include) argv.push("--include", include);
      if (revision) argv.push("--revision", revision);
      if (local_dir) argv.push("--local-dir", ctx.guard.resolve(local_dir));
      const job = createJob("download_model");
      updateJob(job.id, { repo, include, argv: argv.join(" ") });
      const child = execFile(
        bin,
        argv,
        { env: { ...safeEnv(), HF_HUB_ENABLE_HF_TRANSFER: "0" }, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            finishJob(job.id, `exit ${(err as { code?: number }).code ?? "?"}: ${String(stderr).slice(-800)}`);
          } else {
            updateJob(job.id, { output_tail: String(stdout).slice(-1000) });
            finishJob(job.id);
          }
        },
      );
      job.abort = () => child.kill();
      // Stream progress: hf writes progress bars to stderr/stdout — keep last line.
      const onData = (d: Buffer): void => {
        const tail = d.toString("utf-8").split("\n").filter(Boolean).pop();
        if (tail) updateJob(job.id, { last_line: tail.slice(0, 300) });
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      return jsonResult({ job_id: job.id, repo, note: "Poll get_job for progress. Files land in the HF cache unless local_dir was given." });
    },
  );

  server.registerTool(
    "get_job",
    { description: "Get status/progress of a background job (e.g. a model pull).", inputSchema: { job_id: z.string() } },
    async ({ job_id }) => {
      const j = getJob(job_id);
      if (!j) throw new Error(`no job ${job_id}`);
      return jsonResult({ job: j });
    },
  );

  server.registerTool(
    "list_jobs",
    { description: "List background jobs (most recent first).", inputSchema: {} },
    async () => jsonResult({ jobs: listJobs() }),
  );

  server.registerTool(
    "control_job",
    {
      description:
        "Steer a running background job: pause (halt between agent steps), resume, " +
        "cancel (aborts in-flight work too), or inject (append an operator instruction the local " +
        "agent sees on its next step — for course-correcting a run_local_agent mid-flight).",
      inputSchema: {
        job_id: z.string(),
        action: z.enum(["pause", "resume", "cancel", "inject"]),
        message: z.string().optional().describe("Required for action=inject"),
      },
    },
    async ({ job_id, action, message }) => {
      const r = controlJob(job_id, action as JobAction, message);
      if (!r.ok) throw new Error(r.reason);
      return jsonResult({
        job_id,
        action,
        control: { paused: r.control.paused, cancelled: r.control.cancelled, mailbox_pending: r.control.mailbox.length },
      });
    },
  );

  server.registerTool(
    "unload_model",
    {
      description: "Unload a model from VRAM on an ollama provider (frees memory immediately).",
      inputSchema: { model: z.string(), provider: z.string().optional() },
    },
    async ({ model, provider: pName }) => {
      const p = ctx.providers.get(pName);
      if (!p.unload) throw new Error(`provider "${p.name}" does not support unload`);
      await p.unload(model);
      return jsonResult({ unloaded: model, provider: p.name });
    },
  );

  server.registerTool(
    "get_usage_stats",
    {
      description:
        "Session totals: local LLM calls, tokens consumed on the cheap model, and delegated_bytes " +
        "(bytes of file content processed server-side that never entered your context — i.e. the savings).",
      inputSchema: {},
    },
    async () => jsonResult({ stats: getStats() }),
  );

  server.registerTool(
    "get_server_info",
    {
      description:
        "Show this server's config: providers (sanitized), allowed_roots, feature flags, limits. " +
        "Call this first if unsure what's configured.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        config_path: ctx.configPath,
        default_provider: ctx.config.default_provider,
        providers: ctx.providers.names().map((n) => {
          const p = ctx.providers.get(n);
          return {
            name: n,
            type: p.type,
            base_url: p.baseUrl,
            is_local: p.isLocal,
            default_model: p.defaultModel ?? ctx.config.default_model,
            default_num_ctx: p.defaultNumCtx ?? ctx.config.limits.num_ctx,
            supports: {
              pull: !!p.pull,
              unload: !!p.unload,
              ps: !!p.ps,
              tools: true,
            },
          };
        }),
        allowed_roots: ctx.guard.rootDetails,
        write_mode: ctx.writeMode,
        flags: {
          run_command: ctx.env.runCommand,
          dynamic_tools: ctx.env.dynamicTools,
          agent_async: ctx.config.agent_async,
          agent_sync_grace_ms: ctx.config.agent_sync_grace_ms,
        },
        command_whitelist: {
          enabled: ctx.config.command_whitelist.enabled,
          commands: Object.keys(ctx.config.command_whitelist.commands),
        },
        limits: ctx.config.limits,
      }),
  );
}
