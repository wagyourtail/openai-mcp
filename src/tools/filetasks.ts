import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { GEN_PARAMS, jsonResult, makeProgress, pool, stripFences, trackedChat, type ProgressExtra } from "./helpers.ts";
import { stageWrite } from "../lib/staging.ts";
import { recordUsage } from "../lib/usage.ts";
import { validateSchema } from "../lib/schema-validate.ts";

const COMMON = {
  model: z.string().optional(),
  provider: z.string().optional(),
  temperature: z.number().optional(),
  num_ctx: z.number().int().optional(),
  ...GEN_PARAMS,
};

interface Source {
  label: string;
  content: string;
  bytes: number;
}

/** Collect text inputs: inline text and/or files via guard (paths/globs read server-side). */
async function collectSources(
  ctx: ServerContext,
  input: { text?: string; path?: string; paths?: string[]; glob?: string },
): Promise<Source[]> {
  const out: Source[] = [];
  if (input.text !== undefined) {
    out.push({ label: "(inline text)", content: input.text, bytes: Buffer.byteLength(input.text) });
  }
  const files = new Set<string>();
  if (input.path) files.add(input.path);
  for (const p of input.paths ?? []) files.add(p);
  if (input.glob) {
    for (const p of await ctx.guard.glob(input.glob, ctx.config.limits.max_glob_matches)) {
      files.add(p);
    }
  }
  for (const f of files) {
    const { content, bytes, truncated } = await ctx.guard.readFile(f);
    out.push({
      label: f,
      content: truncated ? `[TRUNCATED at ${bytes} bytes]\n${content}` : content,
      bytes,
    });
  }
  if (out.length === 0) throw new Error("no input: provide `text`, `path`, `paths`, or `glob`");
  return out;
}

export function registerFileTaskTools(server: McpServer, ctx: ServerContext): void {
  const INPUT = {
    text: z.string().optional().describe("Inline text instead of files"),
    path: z.string().optional().describe("Single file path (read server-side — never enters your context)"),
    paths: z.array(z.string()).optional().describe("Multiple file paths"),
    glob: z.string().optional().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  };

  server.registerTool(
    "summarize",
    {
      description:
        "Summarize files or text with the local model. File contents are read server-side and " +
        "NEVER enter your context — only the summaries come back. Prefer this over reading large files yourself.",
      inputSchema: {
        instruction: z.string().optional().describe("What to focus on (default: concise technical summary)"),
        max_chars_per_file: z.number().int().optional().describe("Cap each summary length"),
        concurrency: z.number().int().min(1).max(4).optional().describe("Parallel local-LLM requests (default 2)"),
        ...INPUT,
        ...COMMON,
      },
    },
    async ({ instruction, max_chars_per_file, concurrency, text, path, paths, glob, model, provider: pName, temperature, num_ctx, ...gen }, extra) => {
      const sources = await collectSources(ctx, { text, path, paths, glob });
      const { provider, model: m } = pickModel(ctx, pName, model);
      const instr = instruction ?? "Summarize this concisely: purpose, key items, anything notable.";
      const delegated = sources.reduce((s, x) => s + x.bytes, 0);
      const report = makeProgress(extra as ProgressExtra, sources.length);
      let done = 0;
      const summaries = await pool(sources, concurrency ?? 2, async (src) => {
        const { res, usage } = await trackedChat(
          "summarize",
          provider,
          {
            model: m,
            messages: [
              { role: "system", content: `You are a precise technical summarizer. ${instr}${max_chars_per_file ? ` Keep under ${max_chars_per_file} chars.` : ""}` },
              { role: "user", content: `Source: ${src.label}\n\n${src.content}` },
            ],
            temperature: temperature ?? 0.2,
            num_ctx,
            ...gen,
          },
          src.bytes,
        );
        done++;
        report(`${done}/${sources.length}: ${src.label}`, done);
        return { source: src.label, summary: res.content, usage };
      });
      return jsonResult({ summaries, delegated_bytes: delegated });
    },
  );

  server.registerTool(
    "extract",
    {
      description:
        "Extract structured data from text/files with the local model. Optionally validate output " +
        "against a JSON schema (one automatic retry on invalid output).",
      inputSchema: {
        instruction: z.string().describe("What to extract, e.g. 'all function names and their purposes'"),
        schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema the result must satisfy"),
        ...INPUT,
        ...COMMON,
      },
    },
    async ({ instruction, schema, text, path, paths, glob, model, provider: pName, temperature, num_ctx, ...gen }, extra) => {
      const sources = await collectSources(ctx, { text, path, paths, glob });
      const { provider, model: m } = pickModel(ctx, pName, model);
      const results = [];
      const delegated = sources.reduce((s, x) => s + x.bytes, 0);
      const report = makeProgress(extra as ProgressExtra, sources.length);
      let done = 0;
      for (const src of sources) {
        const baseMessages = [
          {
            role: "system" as const,
            content:
              "You extract structured data and respond with JSON only. " +
              `Task: ${instruction}` +
              (schema ? ` The output must satisfy this JSON schema: ${JSON.stringify(schema)}` : ""),
          },
          { role: "user" as const, content: `Source: ${src.label}\n\n${src.content}` },
        ];
        let lastErr = "";
        let data: unknown = null;
        let attempts = 0;
        for (attempts = 1; attempts <= 2; attempts++) {
          const messages =
            attempts === 1
              ? baseMessages
              : [
                  ...baseMessages,
                  { role: "user" as const, content: `Your previous output failed validation: ${lastErr}. Return corrected JSON only.` },
                ];
          const { res, usage } = await trackedChat(
            "extract",
            provider,
            {
              model: m,
              messages,
              temperature: temperature ?? 0.1,
              num_ctx,
              ...gen,
              response_format: schema ?? "json",
            },
            src.bytes,
          );
          try {
            data = JSON.parse(res.content);
          } catch {
            lastErr = `invalid JSON: ${res.content.slice(0, 200)}`;
            continue;
          }
          if (schema) {
            const errors = validateSchema(data, schema);
            if (errors.length) {
              lastErr = errors.slice(0, 5).join("; ");
              data = null;
              continue;
            }
          }
          lastErr = "";
          break;
        }
        results.push({
          source: src.label,
          data,
          valid: lastErr === "",
          ...(lastErr ? { error: lastErr, needs_review: true } : {}),
          attempts,
        });
        done++;
        report(`${done}/${sources.length}: ${src.label}`, done);
      }
      return jsonResult({ results, delegated_bytes: delegated });
    },
  );

  server.registerTool(
    "classify",
    {
      description: "Classify text/file content into one or more labels with the local model.",
      inputSchema: {
        labels: z.array(z.string()).min(2).describe("Candidate labels"),
        multi_label: z.boolean().optional().describe("Allow multiple labels (default false)"),
        ...INPUT,
        ...COMMON,
      },
    },
    async ({ labels, multi_label, text, path, paths, glob, model, provider: pName, temperature, num_ctx, ...gen }, extra) => {
      const sources = await collectSources(ctx, { text, path, paths, glob });
      const { provider, model: m } = pickModel(ctx, pName, model);
      const delegated = sources.reduce((s, x) => s + x.bytes, 0);
      const report = makeProgress(extra as ProgressExtra, sources.length);
      let done = 0;
      const schema = {
        type: "object",
        properties: {
          labels: { type: "array", items: { type: "string", enum: labels } },
          reasoning: { type: "string" },
        },
        required: ["labels"],
      };
      const results = [];
      for (const src of sources) {
        const { res, usage } = await trackedChat(
          "classify",
          provider,
          {
            model: m,
            messages: [
              {
                role: "system",
                content: `Classify the content into ${multi_label ? "one or more of" : "exactly one of"} these labels: ${labels.join(", ")}. Return JSON: {"labels": [...], "reasoning": "one line"}`,
              },
              { role: "user", content: `Source: ${src.label}\n\n${src.content.slice(0, 30000)}` },
            ],
            temperature: temperature ?? 0.1,
            num_ctx,
            ...gen,
            response_format: schema,
          },
          src.bytes,
        );
        let parsed: { labels?: string[]; reasoning?: string } = {};
        try {
          parsed = JSON.parse(res.content);
        } catch {
          /* leave empty */
        }
        const picked = (parsed.labels ?? []).filter((l) => labels.includes(l));
        results.push({ source: src.label, labels: picked, reasoning: parsed.reasoning, usage });
        done++;
        report(`${done}/${sources.length}: ${src.label}`, done);
      }
      return jsonResult({ results, delegated_bytes: delegated });
    },
  );

  server.registerTool(
    "decide",
    {
      description:
        "Decision-model scoring (ollama /api/systemone — clef / clef-flash / nimble / tev). " +
        "Scores 1–64 TYPED questions about a state in ONE forward pass and returns calibrated " +
        "probabilities per option — no text generation, no output parsing, no retries. Prefer " +
        "over `classify` when a decision model is available: you get real probabilities instead " +
        "of parsed JSON. Question types: 'choice' (criteria maps option keys→descriptions, null " +
        "uses the key), 'score' (numeric scale), 'noul' (true/false). Requires an ollama provider " +
        "running a decision model; a normal chat model returns an error. State is read " +
        "server-side — files never enter your context.",
      inputSchema: {
        questions: z
          .record(
            z.string(),
            z.object({
              type: z.enum(["choice", "score", "noul"]),
              instructions: z.string().describe("The question text"),
              criteria: z
                .record(z.string(), z.any())
                .optional()
                .describe("choice: option key → description (null = use key); shape varies by type"),
            }),
          )
          .describe("Named questions, 1–64"),
        state: z.string().optional().describe("Inline state (plain text or JSON text)"),
        path: z.string().optional().describe("State from a file (read server-side)"),
        paths: z.array(z.string()).optional().describe("Multiple state files"),
        glob: z.string().optional().describe("Glob for state files"),
        model: z
          .string()
          .optional()
          .describe("Decision model, e.g. 'clef-flash:9b' (default: provider default_model)"),
        provider: z.string().optional(),
      },
    },
    async ({ questions, state, path, paths, glob, model, provider: pName }) => {
      const { provider, model: m } = pickModel(ctx, pName, model);
      if (!provider.decide) {
        throw new Error(
          `provider '${provider.name}' (${provider.type}) has no decision endpoint — ` +
            `decide requires an ollama provider running a decision model (clef-flash, nimble, tev)`,
        );
      }
      let statePayload: unknown;
      if (path || paths?.length || glob) {
        const sources = await collectSources(ctx, { path, paths, glob });
        statePayload = [
          ...(state !== undefined ? [{ text: state }] : []),
          ...sources.map((s) => ({ file: s.label, content: s.content })),
        ];
      } else {
        if (state === undefined) throw new Error("no state: provide `state`, `path`, `paths`, or `glob`");
        try {
          statePayload = JSON.parse(state);
        } catch {
          statePayload = state;
        }
      }
      const t0 = Date.now();
      const res = await provider.decide({ model: m, state: statePayload, questions });
      recordUsage(
        "decide",
        {
          provider: provider.name,
          model: res.model,
          promptTokens: res.usage?.inputTokens ?? 0,
          completionTokens: res.usage?.outputTokens ?? 0,
          elapsedMs: Date.now() - t0,
        },
        typeof statePayload === "string"
          ? Buffer.byteLength(statePayload)
          : Buffer.byteLength(JSON.stringify(statePayload)),
      );
      return jsonResult({ model: res.model, answers: res.answers });
    },
  );

  server.registerTool(
    "map_files",
    {
      description:
        "Run one instruction over many files with the local model (batch job). " +
        "output='report': get per-file results. output='stage_writes': the model rewrites each file and " +
        "every change is staged as a diff for your review — NOTHING hits disk until you commit_write.",
      inputSchema: {
        glob: z.string().describe("Glob pattern, e.g. 'src/**/*.test.ts'"),
        instruction: z
          .string()
          .describe(
            "Instruction applied to each file. For stage_writes the model must return the COMPLETE new file content.",
          ),
        output: z.enum(["report", "stage_writes"]).default("report"),
        max_files: z.number().int().optional(),
        concurrency: z.number().int().min(1).max(4).optional().describe("Parallel local-LLM requests (default 2)"),
        ...COMMON,
      },
    },
    async ({ glob, instruction, output, max_files, concurrency, model, provider: pName, temperature, num_ctx, ...gen }, extra) => {
      const limit = Math.min(max_files ?? ctx.config.limits.max_map_files, ctx.config.limits.max_map_files);
      const files = await ctx.guard.glob(glob, limit);
      if (files.length === 0) throw new Error(`no files match glob: ${glob}`);
      const { provider, model: m } = pickModel(ctx, pName, model);
      const report = makeProgress(extra as ProgressExtra, files.length);
      let done = 0;
      let delegated = 0;
      const results = await pool(files, concurrency ?? 2, async (f) => {
        const { content, bytes, truncated } = await ctx.guard.readFile(f);
        delegated += bytes;
        const sys =
          output === "stage_writes"
            ? `You rewrite files. Instruction: ${instruction}\nReturn ONLY the complete new file content — no markdown fences, no commentary.`
            : instruction;
        const { res, usage } = await trackedChat(
          "map_files",
          provider,
          {
            model: m,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: `File: ${f}${truncated ? " [TRUNCATED]" : ""}\n\n${content}` },
            ],
            temperature: temperature ?? 0.2,
            num_ctx,
            ...gen,
          },
          bytes,
        );
        done++;
        report(`${done}/${files.length}: ${f}`, done);
        if (output === "stage_writes") {
          const op = stageWrite(ctx.guard, { path: f, content: stripFences(res.content), source: "map_files" }, ctx.config.limits.stage_ttl_s * 1000);
          return { path: f, staged_op: op.id, diff_chars: op.diff.length, usage };
        }
        return { path: f, result: res.content, usage };
      });
      return jsonResult({
        files_processed: results.length,
        files_capped: files.length >= limit,
        results,
        staged_ops: output === "stage_writes" ? results.map((r) => (r as { staged_op?: string }).staged_op) : undefined,
        delegated_bytes: delegated,
        note: output === "stage_writes"
          ? ctx.writeMode === "write"
            ? "Review each op with get_diff, then commit_write or discard_write."
            : "Staged only (write_mode=propose): review with get_diff and apply with your own tools, or discard_write."
          : undefined,
      });
    },
  );
}
