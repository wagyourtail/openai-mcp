import { randomBytes } from "node:crypto";

export interface JobControl {
  paused: boolean;
  cancelled: boolean;
  /** Operator messages the agent loop should consume between steps. */
  mailbox: string[];
}

export interface Job {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  progress: Record<string, unknown>;
  result?: unknown;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  control: JobControl;
  /** Optional hard-abort (kill child process / abort fetch). */
  abort?: () => void;
}

const jobs = new Map<string, Job>();

export function createJob(kind: string): Job {
  const job: Job = {
    id: randomBytes(6).toString("hex"),
    kind,
    status: "running",
    progress: {},
    createdAt: new Date().toISOString(),
    control: { paused: false, cancelled: false, mailbox: [] },
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(id: string, progress: Record<string, unknown>): void {
  const j = jobs.get(id);
  if (j) j.progress = { ...j.progress, ...progress };
}

export function finishJob(id: string, error?: string, result?: unknown): void {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return;
  j.status = error ? "error" : "done";
  j.error = error;
  if (result !== undefined) j.result = result;
  j.finishedAt = new Date().toISOString();
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type JobAction = "pause" | "resume" | "cancel" | "inject";

export function controlJob(
  id: string,
  action: JobAction,
  message?: string,
): { ok: true; control: JobControl } | { ok: false; reason: string } {
  const j = jobs.get(id);
  if (!j) return { ok: false, reason: `no job ${id}` };
  if (j.status !== "running") {
    return { ok: false, reason: `job ${id} is already ${j.status}` };
  }
  switch (action) {
    case "pause":
      j.control.paused = true;
      break;
    case "resume":
      j.control.paused = false;
      break;
    case "cancel":
      j.control.cancelled = true;
      j.abort?.();
      finishJob(id, "cancelled by operator");
      break;
    case "inject":
      if (!message?.trim()) return { ok: false, reason: "inject requires a non-empty message" };
      j.control.mailbox.push(message);
      break;
  }
  return { ok: true, control: j.control };
}
