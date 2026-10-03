import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import vm from "node:vm";
import type { FsGuard } from "./fs-guard.ts";
import { safeEnv } from "./whitelist.ts";

export interface DynamicTool {
  name: string;
  description: string;
  /** JSON Schema for the parameters object */
  input_schema: Record<string, unknown>;
  kind: "shell" | "js";
  /** shell: executable path/name */
  command?: string;
  /** shell: argv template; each element may contain ${param} placeholders */
  args_template?: string[];
  /** js: function source, evaluated as `(${body})(args)` */
  body?: string;
  created_at: string;
  persist?: boolean;
}

export const dynamicEnabled = (): boolean => process.env.LOCAL_LLM_DYNAMIC_TOOLS === "1";

const registry = new Map<string, DynamicTool>();
const RESERVED = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "stage_write",
  "run_command",
  "done",
]);

export function validateDynamicTool(
  spec: Partial<DynamicTool>,
): { ok: true } | { ok: false; reason: string } {
  if (!dynamicEnabled()) {
    return { ok: false, reason: "dynamic tools are disabled — set LOCAL_LLM_DYNAMIC_TOOLS=1 in the server's env" };
  }
  if (!spec.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)) {
    return { ok: false, reason: "name must match ^[a-zA-Z0-9_-]{1,64}$" };
  }
  if (RESERVED.has(spec.name)) {
    return { ok: false, reason: `"${spec.name}" collides with a built-in local tool` };
  }
  if (!spec.description || spec.description.length < 5) {
    return { ok: false, reason: "description required (the local model relies on it to use the tool)" };
  }
  if (spec.kind === "shell") {
    if (!spec.command) return { ok: false, reason: "shell tools require `command`" };
  } else if (spec.kind === "js") {
    if (!spec.body) return { ok: false, reason: "js tools require `body` (a function source evaluated as (body)(args))" };
  } else {
    return { ok: false, reason: `kind must be "shell" or "js", got ${JSON.stringify(spec.kind)}` };
  }
  return { ok: true };
}

export function registerDynamicTool(spec: DynamicTool): void {
  registry.set(spec.name, spec);
}

export function unregisterDynamicTool(name: string): boolean {
  return registry.delete(name);
}

export function listDynamicTools(): DynamicTool[] {
  return [...registry.values()];
}

export function getDynamicTool(name: string): DynamicTool | undefined {
  return registry.get(name);
}

const SUB = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

async function executeShell(t: DynamicTool, args: Record<string, unknown>, cwd: string): Promise<string> {
  const argv = (t.args_template ?? []).map((part) =>
    part.replace(SUB, (_, key: string) => {
      const v = args[key];
      if (v === undefined) throw new Error(`missing argument ${key} for ${t.name}`);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    }),
  );
  return new Promise((resolve) => {
    execFile(t.command!, argv, { cwd, timeout: 30_000, maxBuffer: 256 * 1024, env: safeEnv() }, (err, stdout, stderr) => {
      if (err) {
        resolve(`error (code ${(err as { code?: number }).code ?? "?"}): ${stderr || err.message}\n${stdout}`.trim());
      } else {
        resolve(stdout || "(no output)");
      }
    });
  });
}

async function executeJs(t: DynamicTool, args: Record<string, unknown>): Promise<string> {
  // node:vm is a convenience boundary, not a security one — treat js tools as
  // trusted code. That's why registration is env-gated + permission-asked.
  const sandbox = { args, result: undefined as unknown, error: undefined as unknown };
  const wrapped = `
    Promise.resolve()
      .then(() => (${t.body})(args))
      .then((r) => { result = r; })
      .catch((e) => { error = String(e && e.stack || e); });
  `;
  const script = new vm.Script(wrapped);
  const context = vm.createContext(sandbox);
  script.runInContext(context, { timeout: 5000 });
  // Drain microtasks; a runaway async body is bounded by the caller's timeout.
  const deadline = Date.now() + 5000;
  while (sandbox.result === undefined && sandbox.error === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (sandbox.error !== undefined) return `error: ${sandbox.error}`;
  if (sandbox.result === undefined) return "error: js tool timed out";
  const out = typeof sandbox.result === "string" ? sandbox.result : JSON.stringify(sandbox.result, null, 2);
  return out ?? "(no output)";
}

export async function executeDynamicTool(
  t: DynamicTool,
  args: Record<string, unknown>,
  guard: FsGuard,
): Promise<string> {
  const cwd = guard.configured ? guard.rootList[0] : process.cwd();
  if (t.kind === "shell") return executeShell(t, args, cwd);
  return executeJs(t, args);
}

export function loadPersistedTools(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const list = JSON.parse(readFileSync(path, "utf-8")) as DynamicTool[];
    for (const t of list) {
      if (t?.name && !RESERVED.has(t.name)) registry.set(t.name, t);
    }
    return list.length;
  } catch {
    return 0;
  }
}

export async function persistTools(path: string): Promise<void> {
  const list = [...registry.values()].filter((t) => t.persist);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(list, null, 2) + "\n", "utf-8");
}
