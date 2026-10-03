import { randomBytes } from "node:crypto";

export interface Job {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  progress: Record<string, unknown>;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, Job>();

export function createJob(kind: string): Job {
  const job: Job = {
    id: randomBytes(6).toString("hex"),
    kind,
    status: "running",
    progress: {},
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(id: string, progress: Record<string, unknown>): void {
  const j = jobs.get(id);
  if (j) j.progress = { ...j.progress, ...progress };
}

export function finishJob(id: string, error?: string): void {
  const j = jobs.get(id);
  if (!j) return;
  j.status = error ? "error" : "done";
  j.error = error;
  j.finishedAt = new Date().toISOString();
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
