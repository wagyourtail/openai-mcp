import { stripFences } from "../tools/helpers.ts";
import type { LocalTool } from "./agent-loop.ts";
import type { FsGuard } from "./fs-guard.ts";
import { stageWrite } from "./staging.ts";
import { checkCommand, runWhitelisted, type CommandWhitelist } from "./whitelist.ts";
import { verifyStagedOp } from "./verify.ts";
import { searchFiles } from "./filesearch.ts";
import { executeDynamicTool, getDynamicTool, listDynamicTools } from "./dynamic-tools.ts";
import { applyEdits, parseEditBlocks } from "./edits.ts";

const OBJ = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export interface LocalToolDeps {
  guard: FsGuard;
  whitelist: CommandWhitelist;
  runCommandEnabled: boolean;
  stageTtlMs: number;
  runCommandTimeoutS: number;
  runCommandOutputChars: number;
  searchOutputChars: number;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s;
}

/** Built-in tools available to the LOCAL model during run_local_agent. */
export function buildLocalTools(deps: LocalToolDeps): LocalTool[] {
  const { guard } = deps;
  const tools: LocalTool[] = [
    {
      spec: {
        name: "read_file",
        description: "Read a UTF-8 text file. Returns file contents (truncated if very large).",
        parameters: OBJ({ path: { type: "string", description: "Path to the file" } }, ["path"]),
      },
      delegates: true,
      async execute(args) {
        const { content, truncated, bytes } = await guard.readFile(String(args.path));
        return (truncated ? `[file truncated at ${bytes} bytes]\n` : "") + content;
      },
    },
    {
      spec: {
        name: "list_dir",
        description: "List entries of a directory.",
        parameters: OBJ({ path: { type: "string" } }, ["path"]),
      },
      async execute(args) {
        const { entries } = await guard.listDir(String(args.path));
        return entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.name}`).join("\n") || "(empty)";
      },
    },
    {
      spec: {
        name: "search_files",
        description:
          "Search file contents (regex — uses ripgrep when installed, built-in " +
          "fallback otherwise). Returns matching lines with path:line.",
        parameters: OBJ(
          {
            pattern: { type: "string", description: "Regex pattern" },
            path: { type: "string", description: "Directory or file to search (default: first allowed root)" },
            glob: { type: "string", description: "Optional file glob, e.g. '*.ts'" },
          },
          ["pattern"],
        ),
      },
      delegates: true,
      async execute(args) {
        const target = args.path ? guard.resolve(String(args.path)) : guard.rootList[0];
        const out = await searchFiles({
          pattern: String(args.pattern),
          target,
          glob: args.glob ? String(args.glob) : undefined,
        });
        return truncate(out, deps.searchOutputChars);
      },
    },
    {
      spec: {
        name: "stage_write",
        description:
          "Stage a file write for human/agent review. NOTHING is written to disk — the change is " +
          "reviewed as a diff and must be committed separately. Use for any file creation or modification.",
        parameters: OBJ(
          {
            path: { type: "string" },
            content: { type: "string", description: "Complete new file content" },
            reason: { type: "string", description: "One-line rationale for this change" },
          },
          ["path", "content"],
        ),
      },
      async execute(args) {
        const op = stageWrite(
          guard,
          { path: String(args.path), content: stripFences(String(args.content)), source: "local_agent", reviewNote: args.reason ? String(args.reason) : undefined },
          deps.stageTtlMs,
        );
        return `staged op ${op.id} (${op.existedBefore ? "modify" : "create"} ${op.path}). ` +
          `Pending review — do NOT assume it is on disk.`;
      },
    },
    {
      spec: {
        name: "stage_edit",
        description:
          "Edit an EXISTING file via SEARCH/REPLACE hunks — prefer this over stage_write for " +
          "changes to files you don't need to fully rewrite. Emit one or more blocks:\n" +
          "<<<<<<< SEARCH\n<lines verbatim from file>\n=======\n<replacement>\n>>>>>>> REPLACE\n" +
          "SEARCH must match the file exactly (indentation counts). Empty SEARCH appends at EOF. " +
          "NOTHING is written to disk — the result is staged as a reviewable op.",
        parameters: OBJ(
          {
            path: { type: "string", description: "Existing file to edit" },
            edits: { type: "string", description: "The SEARCH/REPLACE block text" },
            reason: { type: "string", description: "One-line rationale for this change" },
          },
          ["path", "edits"],
        ),
      },
      async execute(args) {
        const p = guard.resolve(String(args.path));
        const content = (await guard.readFile(p)).content;
        const blocks = parseEditBlocks(String(args.edits));
        if (!blocks.length) {
          return `error: no SEARCH/REPLACE blocks found — use exactly the "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" format`;
        }
        const res = applyEdits(content, blocks);
        if (!res.ok) return `error on block ${res.block}: ${res.reason}`;
        const op = stageWrite(
          guard,
          { path: p, content: res.content, source: "local_agent", reviewNote: args.reason ? String(args.reason) : undefined },
          deps.stageTtlMs,
        );
        return `staged op ${op.id} (edit ${op.path}, ${res.applied} hunk${res.applied === 1 ? "" : "s"}` +
          `${res.fuzzy.length ? ` — hunk(s) ${res.fuzzy.join(",")} matched loosely` : ""}). Pending review — do NOT assume it is on disk.`;
      },
    },
  ];

  if (deps.runCommandEnabled) {
    tools.push({
      spec: {
        name: "run_command",
        description:
          "Run a whitelisted command (no shell — argv only: no pipes, redirects, or glob " +
          "expansion; use list_dir/search_files instead of `ls *` patterns). " +
          `Whitelist: ${Object.keys(deps.whitelist.commands).join(", ")}`,
        parameters: OBJ(
          {
            argv: {
              type: "array",
              items: { type: "string" },
              description: "Command argv array, e.g. [\"rg\", \"-l\", \"foo\"]",
            },
            cwd: { type: "string", description: "Working directory (must be inside allowed roots)" },
          },
          ["argv"],
        ),
      },
      async execute(args) {
        const argv = (args.argv as unknown[]).map(String);
        const check = checkCommand(argv, deps.whitelist);
        if (!check.ok) return `error: ${check.reason}`;
        const cwd = args.cwd ? guard.resolve(String(args.cwd)) : guard.rootList[0];
        const r = await runWhitelisted(argv, {
          cwd,
          timeoutMs: deps.runCommandTimeoutS * 1000,
          maxOutputChars: deps.runCommandOutputChars,
        });
        return (
          (r.timedOut ? `[timed out after ${deps.runCommandTimeoutS}s]\n` : "") +
          (r.stdout || "") +
          (r.stderr ? `\n[stderr]\n${r.stderr}` : "") +
          (r.ok ? "" : `\n[exit ${r.code}]`)
        ).trim() || "(no output)";
      },
    });

    tools.push({
      spec: {
        name: "verify_staged",
        description:
          "Check a staged write op WITHOUT touching the real file: the op's content is written to a " +
          "temp file in the same directory (so imports/paths resolve identically), '{file}' in argv is " +
          "replaced by that temp path (appended if absent), and the whitelisted command runs on it. " +
          "Use after stage_write to lint/typecheck your staged draft — run_command on the original path " +
          "sees the OLD on-disk content, not your stage. restore_paths lists files the command may " +
          "rewrite (e.g. auto-updated baselines) — they are snapshotted and restored afterwards.",
        parameters: OBJ(
          {
            op_id: { type: "string", description: "Staged op id from stage_write" },
            argv: {
              type: "array",
              items: { type: "string" },
              description: "Whitelisted command argv; '{file}' is replaced by the materialized temp path",
            },
            cwd: { type: "string", description: "Working directory (must be inside allowed roots)" },
            restore_paths: {
              type: "array",
              items: { type: "string" },
              description: "Files to snapshot and restore after the run (e.g. auto-rewritten baseline files)",
            },
          },
          ["op_id", "argv"],
        ),
      },
      async execute(args) {
        try {
          const r = await verifyStagedOp(guard, deps.whitelist, {
            opId: String(args.op_id),
            argv: (args.argv as unknown[]).map(String),
            cwd: args.cwd ? String(args.cwd) : undefined,
            restorePaths: Array.isArray(args.restore_paths)
              ? (args.restore_paths as unknown[]).map(String)
              : undefined,
            timeoutMs: deps.runCommandTimeoutS * 1000,
            maxOutputChars: deps.runCommandOutputChars,
          });
          return (
            (r.timedOut ? `[timed out after ${deps.runCommandTimeoutS}s]\n` : "") +
            (r.stdout || "") +
            (r.stderr ? `\n[stderr]\n${r.stderr}` : "") +
            (r.ok ? "" : `\n[exit ${r.code}]`)
          ).trim() || "(no output)";
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
  }

  // Runtime-registered dynamic tools become available to the local model too.
  for (const dt of listDynamicTools()) {
    tools.push({
      spec: {
        name: dt.name,
        description: `[dynamic/${dt.kind}] ${dt.description}`,
        parameters: dt.input_schema,
      },
      async execute(args) {
        const t = getDynamicTool(dt.name);
        if (!t) return `error: dynamic tool ${dt.name} was unregistered`;
        return executeDynamicTool(t, args, guard);
      },
    });
  }

  return tools;
}
