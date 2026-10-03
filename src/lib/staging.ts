import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { FsGuard } from "./fs-guard.ts";

export interface StagedOp {
  id: string;
  path: string;
  newContent: string;
  oldContent: string;
  stagedHash: string;
  diff: string;
  existedBefore: boolean;
  createdAt: number;
  source: string;
  needsReview: boolean;
  reviewNote?: string;
}

export interface CommittedOp {
  id: string;
  path: string;
  oldContent: string;
  committedContent: string;
  committedAt: number;
  summary?: string;
}

const ops = new Map<string, StagedOp>();
const history = new Map<string, CommittedOp>();
const MAX_OPS = 100;
const MAX_HISTORY = 20;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function evictExpired(ttlMs: number): void {
  const now = Date.now();
  for (const [id, op] of ops) {
    if (now - op.createdAt > ttlMs) ops.delete(id);
  }
  if (ops.size > MAX_OPS) {
    const oldest = [...ops.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const op of oldest.slice(0, ops.size - MAX_OPS)) ops.delete(op.id);
  }
}

/** Stage a write. Returns the op including a unified diff for review. Nothing touches disk. */
export function stageWrite(
  guard: FsGuard,
  input: { path: string; content: string; source?: string; needsReview?: boolean; reviewNote?: string },
  ttlMs: number,
): StagedOp {
  evictExpired(ttlMs);
  const p = guard.resolve(input.path);
  const existedBefore = existsSync(p);
  const old = existedBefore ? readFileSync(p, "utf-8") : "";
  const diff = createTwoFilesPatch(
    p + (existedBefore ? "" : " (new file)"),
    p + " (staged)",
    old,
    input.content,
    "current",
    "staged",
    { context: 3 },
  );
  const op: StagedOp = {
    id: randomBytes(8).toString("hex"),
    path: p,
    newContent: input.content,
    oldContent: old,
    stagedHash: sha256(old),
    diff,
    existedBefore,
    createdAt: Date.now(),
    source: input.source ?? "unknown",
    needsReview: input.needsReview ?? false,
    reviewNote: input.reviewNote,
  };
  ops.set(op.id, op);
  return op;
}

export function getOp(id: string): StagedOp | undefined {
  return ops.get(id);
}

export function listOps(): (Omit<StagedOp, "newContent" | "oldContent" | "stagedHash" | "diff"> & { diffLines: number })[] {
  return [...ops.values()].map(({ newContent: _c, oldContent: _o, stagedHash: _h, diff, ...rest }) => ({
    ...rest,
    diffLines: diff.split("\n").length - 1,
  }));
}

export function discardOp(id: string): boolean {
  return ops.delete(id);
}

/**
 * Atomically write the staged content (tmp file in same dir + rename).
 * Refuses if the file changed since staging (drift) unless force=true.
 */
export async function commitOp(
  guard: FsGuard,
  id: string,
  force = false,
  summary?: string,
): Promise<{ path: string; bytes: number; commitId: string; drifted: boolean }> {
  const op = ops.get(id);
  if (!op) throw new Error(`no staged op with id ${id} (expired or never existed)`);
  // Re-validate through the guard at commit time in case config changed.
  const p = guard.resolve(op.path);
  const current = existsSync(p) ? readFileSync(p, "utf-8") : "";
  const drifted = sha256(current) !== op.stagedHash;
  if (drifted && !force) {
    throw new Error(
      `file changed since staging: ${p}. Re-stage or call commit_write with force=true to overwrite anyway.`,
    );
  }
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.openai-mcp-${op.id}.tmp`;
  await writeFile(tmp, op.newContent, "utf-8");
  await rename(tmp, p);
  ops.delete(id);

  const commit: CommittedOp = {
    id: `commit_${op.id}`,
    path: p,
    oldContent: op.oldContent,
    committedContent: op.newContent,
    committedAt: Date.now(),
    summary,
  };
  history.set(commit.id, commit);
  if (history.size > MAX_HISTORY) {
    const oldest = [...history.values()].sort((a, b) => a.committedAt - b.committedAt)[0];
    history.delete(oldest.id);
  }
  return { path: p, bytes: Buffer.byteLength(op.newContent, "utf-8"), commitId: commit.id, drifted };
}

export function listCommits(): Omit<CommittedOp, "oldContent" | "committedContent">[] {
  return [...history.values()]
    .sort((a, b) => b.committedAt - a.committedAt)
    .map(({ oldContent: _o, committedContent: _c, ...rest }) => rest);
}

/**
 * Revert a committed write by staging a NEW op that restores the pre-commit
 * content. Goes through the normal review flow — no silent disk writes.
 */
export function revertCommit(guard: FsGuard, commitId: string, ttlMs: number): StagedOp {
  const commit = history.get(commitId);
  if (!commit) throw new Error(`no committed op ${commitId} (history keeps last ${MAX_HISTORY})`);
  const current = existsSync(commit.path) ? readFileSync(commit.path, "utf-8") : "";
  const drifted = sha256(current) !== sha256(commit.committedContent);
  const op = stageWrite(
    guard,
    {
      path: commit.path,
      content: commit.oldContent,
      source: "revert",
      needsReview: true,
      reviewNote: drifted
        ? "WARNING: file changed after the commit — this revert stages the pre-commit version and may drop later edits."
        : `revert of ${commitId}`,
    },
    ttlMs,
  );
  return op;
}
