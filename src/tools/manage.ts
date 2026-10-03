import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.ts";
import { jsonResult } from "./helpers.ts";
import { controlJob, createJob, finishJob, getJob, listJobs, updateJob, type JobAction } from "../lib/jobs.ts";
import { normPci, ollamaGpuPlacement, systemResources, type GpuInfo, type OllamaGpuPlacement } from "../lib/sysinfo.ts";
import { pruneCandidates, rankModels } from "../lib/modelpick.ts";
import { patchProvider } from "../config.ts";
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
        "a model or num_ctx for heavy jobs. Includes `ollama_gpu`: which GPU(s) the ollama server " +
        "is pinned to (env) or observed using (runner process device fds).",
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
      const placement = await ollamaGpuPlacement(res.gpus);
      fillInferenceMem(res.gpus, placement);
      return jsonResult({ provider: p.name, ...res, loaded_models: loaded, ollama_gpu: placement });
    },
  );

  /** Fill missing GPU memory from ollama's own discovery (journal `inference compute` lines). */
  function fillInferenceMem(gpus: GpuInfo[], placement: OllamaGpuPlacement): void {
    for (const g of gpus) {
      if (!g.pciSlot || (g.freeMB !== undefined && g.totalMB !== undefined)) continue;
      const d = placement.inference_devices.find((x) => x.pci && normPci(x.pci) === normPci(g.pciSlot));
      if (!d) continue;
      g.totalMB ??= d.totalMB || undefined;
      g.freeMB ??= d.availMB || undefined;
    }
  }

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
    "recommend_model",
    {
      description:
        "Analyze installed models against detected hardware and recommend a default_model for a " +
        "provider. Prefers tool-calling models that fit the target GPU's free VRAM (or free RAM " +
        "for CPU-only). With apply=true, writes the pick to the provider's default_model in the " +
        "config file AND applies it live to this server.",
      inputSchema: {
        provider: z.string().optional().describe("Provider name (default: default_provider)"),
        apply: z.boolean().optional().describe("Persist the recommendation to config + apply it live"),
        budget_mb: z
          .number()
          .int()
          .optional()
          .describe("Override the detected memory budget in MB (e.g. when sizing against a remote ollama host manually)"),
      },
    },
    async ({ provider: pName, apply, budget_mb }) => {
      const p = ctx.providers.get(pName);
      const models = await p.listModels();
      if (!models.length) throw new Error(`provider "${p.name}" reports no installed models`);

      let budgetBytes = budget_mb ? budget_mb * 1024 * 1024 : 0;
      let budgetSource = budget_mb ? "caller override" : "none detected";
      let placement: OllamaGpuPlacement | undefined;
      if (!budgetBytes && p.isLocal && p.type === "ollama") {
        const res = await systemResources();
        const pl = await ollamaGpuPlacement(res.gpus);
        placement = pl;
        fillInferenceMem(res.gpus, pl);
        // GPU identity is PCI slot. Target priority: GPUs observed in use >
        // GPUs pinned via server env > discrete GPUs (auto-select) > everything.
        const slots = pl.gpus_in_use.length ? pl.gpus_in_use : pl.pinned_slots;
        const discrete = res.gpus.filter((g) => !g.integrated);
        const targets = slots.length
          ? res.gpus.filter((g) => g.pciSlot && slots.includes(normPci(g.pciSlot)))
          : (discrete.length ? discrete : res.gpus);
        let freeMB = Math.max(0, ...targets.map((g) => g.freeMB ?? 0));
        if (freeMB > 0) {
          budgetBytes = freeMB * 1024 * 1024;
          budgetSource =
            pl.gpus_in_use.length > 0
              ? `free VRAM on GPU(s) in use by ollama: ${pl.gpus_in_use.join(",")}`
              : pl.pinned_slots.length > 0
                ? `free VRAM on pinned GPU(s): ${pl.pinned_slots.join(",")} (server env: ${Object.entries(pl.env).filter(([k]) => /VISIBLE|SELECTOR|AFFINITY|PRIME|ICD/.test(k)).map(([k, v]) => `${k}=${v}`).join(" ") || "unknown"})`
                : "largest free VRAM across discrete GPUs (ollama auto-selects)";
        } else if (slots.length && targets.length) {
          // Pinned/observed GPU but its free VRAM is unknown — do NOT fall back
          // to some other GPU's roomier memory; ollama can't use it. Use the
          // pinned device's journal `available`, else its total, else RAM.
          const jAvail = Math.max(
            0,
            ...targets.map(
              (g) =>
                pl.inference_devices.find((d) => d.pci && normPci(d.pci) === normPci(g.pciSlot))?.availMB ?? 0,
            ),
          );
          const tTotal = Math.max(0, ...targets.map((g) => g.totalMB ?? 0));
          if (jAvail > 0) {
            budgetBytes = jAvail * 1024 * 1024;
            budgetSource = `pinned GPU ${slots.join(",")} free VRAM from ollama journal (nvtop/sysfs couldn't measure it)`;
          } else if (tTotal > 0) {
            budgetBytes = tTotal * 1024 * 1024;
            budgetSource = `pinned GPU ${slots.join(",")} TOTAL VRAM (free unknown — may overestimate)`;
          }
        }
        if (!budgetBytes && res.ram.freeMB > 0) {
          budgetBytes = res.ram.freeMB * 1024 * 1024;
          budgetSource = slots.length
            ? `free RAM fallback (pinned GPU ${slots.join(",")} had no measurable VRAM)`
            : "free RAM (no GPU detected — CPU inference)";
        }
      }
      const ranked = rankModels(models, budgetBytes);
      const best = ranked.find((r) => r.fits) ?? null;
      const result: Record<string, unknown> = {
        provider: p.name,
        recommended: best?.id ?? null,
        current_default: p.defaultModel ?? ctx.config.default_model,
        budget_mb: budgetBytes ? Math.round(budgetBytes / 1024 / 1024) : undefined,
        budget_source: budgetSource,
        ...(best ? {} : { warning: "no installed model fits the detected memory budget — pull a smaller model or free VRAM" }),
        ...(placement ? { ollama_gpu: placement } : {}),
        ranked: ranked.map((r) => ({
          id: r.id,
          size_gb: r.sizeBytes ? Math.round(r.sizeBytes / 1e9 * 10) / 10 : undefined,
          fits: r.fits,
          modified_at: r.modifiedAt,
          reason: r.reason,
        })),
      };
      if (apply && best) {
        await patchProvider(ctx.configPath, p.name, { default_model: best.id });
        const cfgEntry = ctx.config.providers[p.name];
        if (cfgEntry) cfgEntry.default_model = best.id;
        result.applied = best.id;
        result.note = `default_model for provider "${p.name}" set to ${best.id} (config + live)`;
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "delete_model",
    {
      description:
        "Permanently delete a model from an ollama provider (DELETE /api/delete). " +
        "Irreversible — the model must be re-pulled to restore. Refuses to delete the provider's " +
        "default_model or a currently-loaded model unless force=true.",
      inputSchema: {
        model: z.string().describe("Model id to delete, e.g. 'llama3.1:8b'"),
        provider: z.string().optional(),
        force: z.boolean().optional().describe("Allow deleting the default/loaded model"),
      },
    },
    async ({ model, provider: pName, force }) => {
      const p = ctx.providers.get(pName);
      if (!p.delete) throw new Error(`provider "${p.name}" (${p.type}) does not support delete — ollama providers only`);
      const def = p.defaultModel ?? ctx.config.default_model;
      const loaded = p.ps ? (await p.ps()).map((l) => l.id) : [];
      const normalized = (id: string) => (id.includes(":") ? id : `${id}:latest`);
      if (!force && normalized(def ?? "") === normalized(model)) {
        throw new Error(`"${model}" is the provider default — set a new default first (recommend_model apply:true) or pass force=true`);
      }
      if (!force && loaded.some((l) => normalized(l) === normalized(model))) {
        throw new Error(`"${model}" is currently loaded in VRAM — unload_model it first or pass force=true`);
      }
      await p.delete(model);
      return jsonResult({ deleted: model, provider: p.name });
    },
  );

  server.registerTool(
    "prune_models",
    {
      description:
        "Bulk-delete old models from an ollama provider. dry_run=true (default) only reports " +
        "candidates. Always keeps: keep[] ids, the provider default_model, currently-loaded models, " +
        "and the keep_recent most recently modified others. With dry_run=false, deletes the rest.",
      inputSchema: {
        provider: z.string().optional(),
        dry_run: z.boolean().default(true),
        keep: z.array(z.string()).optional().describe("Model ids to never delete"),
        keep_recent: z.number().int().min(0).optional().describe("Also keep this many most-recently-modified models (default 0)"),
      },
    },
    async ({ provider: pName, dry_run, keep, keep_recent }) => {
      const p = ctx.providers.get(pName);
      const models = await p.listModels();
      const loaded = p.ps ? (await p.ps()).map((l) => l.id) : [];
      const plan = pruneCandidates(models, {
        keep,
        keepRecent: keep_recent,
        defaultModel: p.defaultModel ?? ctx.config.default_model,
        loaded,
      });
      if (dry_run) {
        return jsonResult({
          dry_run: true,
          provider: p.name,
          ...plan,
          would_free_gb: Math.round(plan.wouldFreeBytes / 1e9 * 10) / 10,
          note: "Re-run with dry_run=false to delete these models.",
        });
      }
      if (!p.delete) throw new Error(`provider "${p.name}" (${p.type}) does not support delete — ollama providers only`);
      const deleted: string[] = [];
      const errors: Record<string, string> = {};
      for (const c of plan.candidates) {
        try {
          await p.delete(c.id);
          deleted.push(c.id);
        } catch (e) {
          errors[c.id] = e instanceof Error ? e.message : String(e);
        }
      }
      return jsonResult({
        provider: p.name,
        deleted,
        freed_gb: Math.round(plan.wouldFreeBytes / 1e9 * 10) / 10,
        kept: plan.kept,
        errors: Object.keys(errors).length ? errors : undefined,
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
            think: ctx.config.providers[n]?.think,
            options: ctx.config.providers[n]?.options,
            supports: {
              pull: !!p.pull,
              unload: !!p.unload,
              delete: !!p.delete,
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
