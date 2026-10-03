import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { FsGuard } from "./fs-guard.ts";
import { getOp } from "./staging.ts";
import { checkCommand, runWhitelisted, type CommandWhitelist, type RunResult } from "./whitelist.ts";

export interface VerifyStagedResult extends RunResult {
  /** Temp file the staged content was materialized to (already cleaned up). */
  tmpPath: string;
  /** restore_paths entries that were snapshotted and restored after the run. */
  restored: string[];
}

/**
 * Check a staged write WITHOUT touching its target: the op's newContent is
 * materialized to a temp sibling file (same directory, so path/import
 * resolution matches the real file), `{file}` placeholders in argv are
 * replaced with the temp path (appended when absent), and the whitelisted
 * command runs against it. `restorePaths` are snapshotted before and restored
 * after — for tools that rewrite side files on every run (e.g. an
 * auto-updating lint/typecheck baseline). The temp file is always removed.
 */
export async function verifyStagedOp(
  guard: FsGuard,
  whitelist: CommandWhitelist,
  input: {
    opId: string;
    argv: string[];
    cwd?: string;
    restorePaths?: string[];
    timeoutMs: number;
    maxOutputChars: number;
  },
): Promise<VerifyStagedResult> {
  const op = getOp(input.opId);
  if (!op) throw new Error(`no staged op ${input.opId} (expired or never existed)`);
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new Error("argv must be a non-empty array");
  }

  const dir = dirname(op.path);
  const ext = extname(op.path);
  const tmp = join(dir, `.${basename(op.path, ext)}.verify-${op.id}${ext}`);
  const tmpPath = guard.resolve(tmp);
  const cwd = input.cwd ? guard.resolve(input.cwd) : dir;

  const snapshots = (input.restorePaths ?? []).map((p) => {
    const abs = guard.resolve(p);
    return { abs, content: existsSync(abs) ? readFileSync(abs, "utf-8") : null };
  });

  const hasPlaceholder = input.argv.some((a) => a.includes("{file}"));
  const argv = input.argv.map((a) => a.replaceAll("{file}", tmpPath));
  if (!hasPlaceholder) argv.push(tmpPath);

  const check = checkCommand(argv, whitelist);
  if (!check.ok) {
    return { ok: false, stdout: "", stderr: check.reason, code: null, timedOut: false, tmpPath, restored: [] };
  }

  await writeFile(tmpPath, op.newContent, "utf-8");
  try {
    const r = await runWhitelisted(argv, {
      cwd,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars,
    });
    return { ...r, tmpPath, restored: snapshots.map((s) => s.abs) };
  } finally {
    for (const s of snapshots) {
      try {
        if (s.content === null) {
          if (existsSync(s.abs)) await rm(s.abs);
        } else {
          await writeFile(s.abs, s.content, "utf-8");
        }
      } catch {
        // best effort — a failed restore is reported via restored[] listing
      }
    }
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
