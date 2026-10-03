import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { jsonResult, makeProgress, stripFences, trackedChat, type ProgressExtra } from "./helpers.ts";
import { commitOp, discardOp, getOp, listCommits, listOps, revertCommit, stageWrite } from "../lib/staging.ts";
import { patchConfig } from "../config.ts";

export function registerWriteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "propose_write",
    {
      description:
        "Have the local model rewrite/create ONE file per your instruction, staged for review. " +
        "Returns an op id + diff. Nothing is written until commit_write. Use for mechanical rewrites " +
        "where the file content shouldn't flow through your own context.",
      inputSchema: {
        path: z.string().describe("File to rewrite (existing) or create (new)"),
        instruction: z.string().describe("What the local model should do to the file"),
        model: z.string().optional(),
        provider: z.string().optional(),
        num_ctx: z.number().int().optional(),
      },
    },
    async ({ path, instruction, model, provider: pName, num_ctx }, extra) => {
      const report = makeProgress(extra as ProgressExtra);
      const { provider, model: m } = pickModel(ctx, pName, model);
      report(`generating: ${path}`);
      const { content } = await ctx.guard.readFile(path).catch((e) => {
        // New file: guard.resolve already validated the parent dir inside roots.
        if (String(e).includes("does not exist")) {
          ctx.guard.resolve(path);
          return { content: "", bytes: 0, truncated: false, path };
        }
        throw e;
      });
      const { res, usage } = await trackedChat("propose_write", provider, {
        model: m,
        temperature: 0.2,
        num_ctx,
        messages: [
          { role: "system", content: `You rewrite files. Instruction: ${instruction}\nReturn ONLY the complete new file content — no markdown fences, no commentary.` },
          { role: "user", content: `File: ${path}\n\n${content}` },
        ],
      });
      report(`staged: ${path}`);
      const op = stageWrite(ctx.guard, { path, content: stripFences(res.content), source: "propose_write" }, ctx.config.limits.stage_ttl_s * 1000);
      return jsonResult({
        op_id: op.id,
        path: op.path,
        kind: op.existedBefore ? "modify" : "create",
        diff: op.diff,
        usage,
        note: ctx.writeMode === "write"
          ? "Review the diff, then commit_write(op_id) or discard_write(op_id)."
          : "Staged only (write_mode=propose): apply this diff with your own tools, or discard_write(op_id).",
      });
    },
  );

  server.registerTool(
    "list_staged",
    {
      description: "List pending staged writes (proposed changes not yet on disk).",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        ops: listOps(),
        write_mode: ctx.writeMode,
        note: "Use get_diff(op_id) to inspect, commit_write(op_id) to apply, discard_write(op_id) to drop.",
      }),
  );

  server.registerTool(
    "get_diff",
    {
      description: "Show the unified diff for a staged write op.",
      inputSchema: {
        op_id: z.string(),
        include_content: z.boolean().optional().describe("Also return the full new file content (for applying via your own edit tools in propose mode)"),
      },
    },
    async ({ op_id, include_content }) => {
      const op = getOp(op_id);
      if (!op) throw new Error(`no staged op ${op_id}`);
      return jsonResult({
        op_id,
        path: op.path,
        kind: op.existedBefore ? "modify" : "create",
        needs_review: op.needsReview,
        note: op.reviewNote,
        write_mode: ctx.writeMode,
        diff: op.diff,
        ...(include_content ? { new_content: op.newContent } : {}),
      });
    },
  );

  server.registerTool(
    "set_write_mode",
    {
      description:
        "Switch the server's write posture. 'propose' (default): staged writes only — commit_write " +
        "is refused; you apply diffs with your own tools. 'write': commit_write applies staged ops " +
        "to disk. persist=true also writes the choice to the server config file.",
      inputSchema: {
        mode: z.enum(["propose", "write"]),
        persist: z.boolean().optional().describe("Also save to the server config file"),
      },
    },
    async ({ mode, persist }) => {
      ctx.writeMode = mode;
      if (persist) await patchConfig(ctx.configPath, { write_mode: mode });
      return jsonResult({ write_mode: mode, persisted: persist ?? false });
    },
  );

  server.registerTool(
    "commit_write",
    {
      description:
        "Apply a staged write to disk (atomic: tmp+rename). Call only AFTER reviewing the diff with " +
        "get_diff. Refuses if the file changed since it was staged — pass force=true to overwrite anyway. " +
        "Only works when write_mode is 'write' — in 'propose' mode apply the diff with your own tools.",
      inputSchema: {
        op_id: z.string(),
        force: z.boolean().optional().describe("Commit even if the file changed since staging"),
      },
    },
    async ({ op_id, force }) => {
      if (ctx.writeMode !== "write") {
        throw new Error(
          "write_mode is 'propose' — the server won't write to disk. Apply the staged diff with your own " +
            "edit tools (get_diff for the patch / include_content for full content), or call " +
            "set_write_mode('write') to enable server-side commits.",
        );
      }
      const r = await commitOp(ctx.guard, op_id, force ?? false);
      return jsonResult({
        committed: r.path,
        bytes: r.bytes,
        commit_id: r.commitId,
        drifted: r.drifted,
        note: "Undo available via revert_write(commit_id) — creates a staged revert op.",
      });
    },
  );

  server.registerTool(
    "discard_write",
    {
      description: "Drop a staged write op without applying it.",
      inputSchema: { op_id: z.string() },
    },
    async ({ op_id }) => jsonResult({ discarded: discardOp(op_id) }),
  );

  server.registerTool(
    "list_commits",
    {
      description: "List recently committed writes (last 20) — for revert_write.",
      inputSchema: {},
    },
    async () => jsonResult({ commits: listCommits() }),
  );

  server.registerTool(
    "revert_write",
    {
      description:
        "Undo a committed write: stages a NEW op restoring the pre-commit content " +
        "(goes through normal review — commit_write applies it).",
      inputSchema: { commit_id: z.string() },
    },
    async ({ commit_id }) => {
      const op = revertCommit(ctx.guard, commit_id, ctx.config.limits.stage_ttl_s * 1000);
      return jsonResult({
        op_id: op.id,
        path: op.path,
        needs_review: op.needsReview,
        note: op.reviewNote,
        diff: op.diff,
      });
    },
  );
}
