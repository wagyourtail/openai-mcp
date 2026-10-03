import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { GEN_PARAMS, jsonResult, makeProgress, stripFences, trackedChat, type ProgressExtra } from "./helpers.ts";
import { commitOp, discardOp, getOp, listCommits, listOps, revertCommit, stageWrite, uncommitOp } from "../lib/staging.ts";
import { verifyStagedOp } from "../lib/verify.ts";
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
        ...GEN_PARAMS,
      },
    },
    async ({ path, instruction, model, provider: pName, num_ctx, ...gen }, extra) => {
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
        ...gen,
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
        "Only works when write_mode is 'write' — do NOT call it in 'propose' mode (it refuses and the " +
        "permission prompt would just show an opaque op_id). `path` and `summary` are REQUIRED because " +
        "the user's approval prompt only shows tool args — make them say exactly what is being written.",
      inputSchema: {
        op_id: z.string(),
        path: z
          .string()
          .describe("REQUIRED: the file this op writes — verified against the staged op so the approval prompt can't lie about the target."),
        summary: z
          .string()
          .min(1)
          .describe("REQUIRED: one-line description of the change, e.g. 'sort list items alphabetically' — the main thing the user sees when approving."),
        force: z.boolean().optional().describe("Commit even if the file changed since staging"),
      },
    },
    async ({ op_id, path, summary, force }) => {
      if (ctx.writeMode !== "write") {
        throw new Error(
          "write_mode is 'propose' — the server won't write to disk. Apply the staged diff with your own " +
            "edit tools (get_diff for the patch / include_content for full content), or call " +
            "set_write_mode('write') to enable server-side commits.",
        );
      }
      const op = getOp(op_id);
      if (!op) throw new Error(`no staged op with id ${op_id} (expired or never existed)`);
      const claimed = ctx.guard.resolve(path);
      if (claimed !== op.path) {
        throw new Error(`path mismatch: op ${op_id} writes ${op.path}, not ${claimed}`);
      }
      const r = await commitOp(ctx.guard, op_id, force ?? false, summary);
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
    "verify_staged",
    {
      description:
        "Run a whitelisted command against a staged write WITHOUT touching the target file: the op's " +
        "content is materialized to a temp file in the same directory (import/path resolution matches " +
        "the real file), '{file}' in argv is replaced by the temp path (appended if absent), and the " +
        "command runs under the command_whitelist. Use it to typecheck/lint a staged op before " +
        "commit_write — running a checker on the original path sees the OLD on-disk content, not the " +
        "stage. restore_paths lists files the command may rewrite (e.g. an auto-updated lint baseline) " +
        "— snapshotted before, restored after. The temp file is always removed.",
      inputSchema: {
        op_id: z.string(),
        argv: z.array(z.string()).describe("Whitelisted command argv; '{file}' is replaced by the materialized temp path"),
        cwd: z.string().optional().describe("Working directory (must be inside allowed roots); defaults to the file's directory"),
        restore_paths: z.array(z.string()).optional().describe("Files to snapshot and restore after the run (e.g. auto-rewritten baseline files)"),
        timeout_s: z.number().int().positive().optional().describe("Command timeout override (default: run_command_timeout_s config)"),
      },
    },
    async ({ op_id, argv, cwd, restore_paths, timeout_s }) => {
      const r = await verifyStagedOp(ctx.guard, ctx.config.command_whitelist, {
        opId: op_id,
        argv,
        cwd,
        restorePaths: restore_paths,
        timeoutMs: (timeout_s ?? ctx.config.limits.run_command_timeout_s) * 1000,
        maxOutputChars: ctx.config.limits.run_command_output_chars,
      });
      return jsonResult({
        ok: r.ok,
        exit_code: r.code,
        timed_out: r.timedOut,
        stdout: r.stdout,
        stderr: r.stderr,
        restored: r.restored,
        note: "Checked the STAGED content via a temp file — the real path was never modified.",
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

  server.registerTool(
    "uncommit_write",
    {
      description:
        "One-call undo of a committed write — restores the pre-commit content atomically " +
        "(deletes files the commit created), no re-staging/re-commit needed. Refuses if the " +
        "file changed since the commit unless force:true. Requires write_mode 'write' — in " +
        "'propose' mode use revert_write + commit_write for the reviewed path.",
      inputSchema: {
        commit_id: z.string(),
        force: z.boolean().optional().describe("Restore even though the file drifted since the commit"),
      },
    },
    async ({ commit_id, force }) => {
      if (ctx.writeMode !== "write") {
        throw new Error(
          "write_mode is 'propose' — the server can't write disk. Use revert_write(commit_id) to stage the undo, then commit_write it.",
        );
      }
      const r = await uncommitOp(ctx.guard, commit_id, force ?? false);
      return jsonResult({
        uncommitted: r.path,
        deleted: r.deleted,
        drifted: r.drifted,
        undo_commit_id: r.commitId,
        note: "The undo is itself a commit — uncommit_write(undo_commit_id) redoes the original write.",
      });
    },
  );
}
