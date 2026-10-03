import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.ts";
import { jsonResult } from "./helpers.ts";
import { controlJob, createJob, finishJob, getJob, listJobs, updateJob, type JobAction } from "../lib/jobs.ts";
import { normPci, ollamaGpuPlacement, systemResources, type GpuInfo, type OllamaGpuPlacement } from "../lib/sysinfo.ts";
import { listRegistryTags, searchRegistry } from "../lib/registry.ts";
import { pruneCandidates, rankModels } from "../lib/modelpick.ts";
import { patchProvider } from "../config.ts";
import { getStats, getModelUse } from "../lib/usage.ts";
import { searchBackend } from "../lib/filesearch.ts";
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
      if (g.freeMB === undefined && d.availMB) {
        g.freeMB = d.availMB;
        g.freeSource = "journal-boot"; // startup snapshot — live free may be lower
      }
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
    "search_models",
    {
      description:
        "Search the public ollama registry (ollama.com) for models to pull_model. Returns name, " +
        "description, capability chips (tools/thinking/vision), available parameter sizes, and " +
        "whether the family is already installed. Requires internet access.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. 'coder', 'qwen3 small'"),
        category: z
          .enum(["tools", "thinking", "vision", "embedding", "cloud"])
          .optional()
          .describe("Filter by capability category"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 12)"),
        provider: z.string().optional().describe("Provider to check installed models against"),
      },
    },
    async ({ query, category, limit, provider: pName }) => {
      const hits = await searchRegistry(query, { category, limit });
      const p = ctx.providers.get(pName);
      const installed = p.type === "ollama" ? (await p.listModels()).map((m) => m.id) : [];
      const families = new Set(installed.map((id) => id.split(":")[0]));
      return jsonResult({
        registry: "ollama.com",
        results: hits.map((h) => ({
          name: h.name,
          description: h.description,
          ...(h.capabilities.length ? { capabilities: h.capabilities } : {}),
          ...(h.sizes.length ? { sizes: h.sizes } : {}),
          ...(h.pulls ? { pulls: h.pulls } : {}),
          ...(h.updated ? { updated: h.updated } : {}),
          installed: families.has(h.name),
        })),
        note: "Pull a match with pull_model {model: '<name>:<tag>'} — see list_model_tags for available tags.",
      });
    },
  );

  server.registerTool(
    "list_model_tags",
    {
      description:
        "List pullable tags for a model in the ollama registry (e.g. model 'gemma4' -> " +
        "e4b, 12b, 26b, ...). With include_sizes=true, fetches each tag's download size from the " +
        "registry manifest API (one request per tag). Requires internet access.",
      inputSchema: {
        model: z.string().describe("Model name without tag, e.g. 'gemma4'"),
        include_sizes: z.boolean().optional().describe("Fetch real download size per tag (slower)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max tags (default 30)"),
        provider: z.string().optional().describe("Provider to check installed models against"),
      },
    },
    async ({ model, include_sizes, limit, provider: pName }) => {
      const tags = await listRegistryTags(model, { includeSizes: include_sizes, limit: limit ?? 30 });
      if (!tags.length) {
        return jsonResult({
          model,
          tags: [],
          warning: `no tags found — is "${model}" a valid ollama registry name? (search_models can find it)`,
        });
      }
      const p = ctx.providers.get(pName);
      const installed = p.type === "ollama" ? new Set((await p.listModels()).map((m) => m.id)) : new Set<string>();
      const norm = (id: string) => (id.includes(":") ? id : `${id}:latest`);
      return jsonResult({
        model,
        tags: tags.map((t) => ({
          ...t,
          size_gb: t.sizeBytes ? Math.round(t.sizeBytes / 1e9 * 10) / 10 : undefined,
          installed: [...installed].some((i) => norm(i) === norm(t.fullName)),
        })),
      });
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
    "wait",
    {
      description:
        "Sleep for a number of seconds (max 600), then return. With job_id, returns early " +
        "as soon as that job reaches done/error — use to poll pull_model/run_local_agent " +
        "without busy-looping get_job.",
      inputSchema: {
        seconds: z.number().min(0).max(600).describe("Seconds to wait (fractions allowed)"),
        job_id: z.string().optional().describe("Return early when this job finishes"),
      },
    },
    async ({ seconds, job_id }) => {
      const start = Date.now();
      const deadline = start + seconds * 1000;
      let job = job_id ? getJob(job_id) : undefined;
      if (job_id && !job) throw new Error(`no job ${job_id}`);
      const jid = job_id;
      while (Date.now() < deadline) {
        if (job && job.status !== "running") break;
        await new Promise((r) => setTimeout(r, Math.min(500, deadline - Date.now())));
        if (job && jid) job = getJob(jid);
      }
      return jsonResult({
        waited_s: Math.round((Date.now() - start) / 100) / 10,
        ...(job ? { job: { id: job.id, kind: job.kind, status: job.status, error: job.error } } : {}),
      });
    },
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
        apply: z.boolean().optional().describe("Persist the pick to config + apply it live"),
        model: z
          .string()
          .optional()
          .describe("Explicit model to set as default with apply:true (must be installed; skips auto-pick)"),
        budget_mb: z
          .number()
          .int()
          .optional()
          .describe("Override the detected memory budget in MB (e.g. when sizing against a remote ollama host manually)"),
      },
    },
    async ({ provider: pName, apply, budget_mb, model: explicit }) => {
      const p = ctx.providers.get(pName);
      const models = await p.listModels();
      if (!models.length) throw new Error(`provider "${p.name}" reports no installed models`);

      let budgetBytes = budget_mb ? budget_mb * 1024 * 1024 : 0;
      let budgetSource = budget_mb ? "caller override" : "none detected";
      const warnings: string[] = [];
      let placement: OllamaGpuPlacement | undefined;
      if (!budgetBytes && p.isLocal && p.type === "ollama") {
        const res = await systemResources();
        const pl = await ollamaGpuPlacement(res.gpus);
        placement = pl;
        fillInferenceMem(res.gpus, pl);
        // GPU identity is PCI slot. Target priority: GPUs observed in use >
        // GPUs pinned via server env > discrete GPUs (auto-select) > everything.
        const slots = pl.gpus_in_use.length ? pl.gpus_in_use : pl.pinned_slots;
        // slots are canonPci form ("0000:04:00.0") — key matches by normPci ("04:00.0").
        const slotKeys = new Set(slots.map(normPci));
        const pinPresent = pl.pinned_indices.length > 0;
        const discrete = res.gpus.filter((g) => !g.integrated);
        // A pin that can't be resolved must NOT fall back to auto-select —
        // sizing against a GPU ollama can't see is the original bug.
        const targets = slots.length
          ? res.gpus.filter((g) => g.pciSlot && slotKeys.has(normPci(g.pciSlot)))
          : pinPresent
            ? []
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
        } else if (slots.length || pinPresent) {
          // Pinned/observed but direct measurement failed — use ollama's own
          // discovery. Under an active pin, journal inference_devices ARE the
          // survivors, so they're usable even when the pin couldn't be mapped
          // back to a pciSlot.
          const devs = slots.length
            ? pl.inference_devices.filter((d) => d.pci && slotKeys.has(normPci(d.pci)))
            : pl.inference_devices;
          const jAvail = Math.max(0, ...devs.map((d) => d.availMB));
          const tTotal = Math.max(0, ...targets.map((g) => g.totalMB ?? 0), ...devs.map((d) => d.totalMB));
          const pinned = slots.length ? `pinned GPU ${slots.join(",")}` : `pinned GPU (env selector, pci unresolved)`;
          if (jAvail > 0) {
            budgetBytes = jAvail * 1024 * 1024;
            budgetSource = `${pinned} free VRAM from ollama journal (boot-time snapshot — live free may be lower)`;
          } else if (tTotal > 0) {
            budgetBytes = tTotal * 1024 * 1024;
            budgetSource = `${pinned} TOTAL VRAM (free unknown — may overestimate)`;
          } else {
            budgetSource = "pin env present but no device memory could be measured";
            warnings.push(
              `ollama pin env (${Object.keys(pl.env).filter((k) => /VISIBLE|SELECTOR|AFFINITY|PRIME|ICD/.test(k)).join(",") || "?"}) ` +
              `is set but couldn't be resolved to a GPU or journal device — verify GGML_VK_VISIBLE_DEVICES/CUDA_VISIBLE_DEVICES indexing on this host`,
            );
          }
        }
        if (!budgetBytes && res.ram.freeMB > 0) {
          budgetBytes = res.ram.freeMB * 1024 * 1024;
          budgetSource = pinPresent || slots.length
            ? `free RAM fallback (${budgetSource})`
            : "free RAM (no GPU detected — CPU inference)";
        }
      }
      const ranked = rankModels(models, budgetBytes);
      let best: (typeof ranked)[number] | null = ranked.find((r) => r.fit === "yes") ?? null;
      if (!best && ranked.find((r) => r.fit === "marginal")) {
        best = ranked.find((r) => r.fit === "marginal")!;
        warnings.push(`recommended model "${best.id}" is marginal — blob fits but KV/headroom is tight; expect partial CPU offload`);
      }
      if (!best) warnings.push("no installed model fits the detected memory budget — pull a smaller model or free VRAM");
      if (explicit) {
        const norm = (id: string) => (id.includes(":") ? id : `${id}:latest`);
        const hit = ranked.find((m) => norm(m.id) === norm(explicit));
        if (!hit) throw new Error(`model "${explicit}" is not installed on provider "${p.name}" — pull_model it first`);
        best = { ...hit, reason: `explicit pick (${hit.reason})` };
      }
      const result: Record<string, unknown> = {
        provider: p.name,
        recommended: best?.id ?? null,
        current_default: p.defaultModel ?? ctx.config.default_model,
        budget_mb: budgetBytes ? Math.round(budgetBytes / 1024 / 1024) : undefined,
        budget_source: budgetSource,
        ...(warnings.length ? { warning: warnings.join("; ") } : {}),
        ...(placement ? { ollama_gpu: placement } : {}),
        ranked: ranked.map((r) => ({
          id: r.id,
          size_gb: r.sizeBytes ? Math.round(r.sizeBytes / 1e9 * 10) / 10 : undefined,
          fit: r.fit,
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
        max_age_days: z.number().min(0).optional().describe("Keep models modified within the last N days"),
        unused_days: z
          .number()
          .min(0)
          .optional()
          .describe("Keep models with a recorded inference within N days (uses the model-usage ledger; models with no record are kept)"),
      },
    },
    async ({ provider: pName, dry_run, keep, keep_recent, max_age_days, unused_days }) => {
      const p = ctx.providers.get(pName);
      const models = await p.listModels();
      const loaded = p.ps ? (await p.ps()).map((l) => l.id) : [];
      const plan = pruneCandidates(models, {
        keep,
        keepRecent: keep_recent,
        maxAgeDays: max_age_days,
        unusedDays: unused_days,
        lastUsed: unused_days !== undefined ? getModelUse() : undefined,
        defaultModel: p.defaultModel ?? ctx.config.default_model,
        loaded,
      });
      if (dry_run) {
        return jsonResult({
          dry_run: true,
          provider: p.name,
          ...plan,
          would_free_gb: Math.round(plan.wouldFreeBytes / 1e9 * 10) / 10,
          ...(unused_days !== undefined ? { last_used: getModelUse() } : {}),
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
          search_files_backend: await searchBackend(),
        },
        command_whitelist: {
          enabled: ctx.config.command_whitelist.enabled,
          commands: Object.keys(ctx.config.command_whitelist.commands),
        },
        limits: ctx.config.limits,
      }),
  );
}
