import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripFences } from "../tools/helpers.ts";
import type { LocalTool } from "./agent-loop.ts";
import type { FsGuard } from "./fs-guard.ts";
import { stageWrite } from "./staging.ts";
import { checkCommand, runWhitelisted, type CommandWhitelist } from "./whitelist.ts";
import { executeDynamicTool, getDynamicTool, listDynamicTools } from "./dynamic-tools.ts";

const execFileP = promisify(execFile);
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
          "Search file contents with ripgrep (regex). Returns matching lines with path:line.",
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
        const argv = ["--line-number", "--no-heading", "--color=never", "-e", String(args.pattern)];
        if (args.glob) argv.push("-g", String(args.glob));
        argv.push(target);
        try {
          const { stdout } = await execFileP("rg", argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
          return truncate(stdout || "(no matches)", deps.searchOutputChars);
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string };
          if (err.code === 1) return "(no matches)";
          return `error: ${err.stderr || "search failed"}`;
        }
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
  ];

  if (deps.runCommandEnabled) {
    tools.push({
      spec: {
        name: "run_command",
        description:
          "Run a whitelisted command (no shell — argv only, no pipes/redirects). " +
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
