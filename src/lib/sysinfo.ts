import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GpuInfo {
  index: number;
  name?: string;
  totalMB?: number;
  usedMB?: number;
}

export interface SystemResources {
  ram: { totalMB: number; freeMB: number };
  gpus: GpuInfo[];
  note?: string;
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const { stdout } = await execFileP(
    "nvidia-smi",
    ["--query-gpu=index,name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { timeout: 5000 },
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used] = line.split(",").map((s) => s.trim());
      return { index: Number(index), name, totalMB: Number(total), usedMB: Number(used) };
    });
}

async function rocmGpus(): Promise<GpuInfo[]> {
  // rocm-smi CSV mode is more parse-friendly than the default table.
  const { stdout } = await execFileP(
    "rocm-smi",
    ["--showmeminfo", "vram", "--csv"],
    { timeout: 5000 },
  );
  const lines = stdout.trim().split("\n");
  const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
  const iDevice = header.findIndex((h) => h.includes("device"));
  const iTotal = header.findIndex((h) => h.includes("total memory"));
  const iUsed = header.findIndex((h) => h.includes("total used"));
  if (iDevice < 0 || iTotal < 0 || iUsed < 0) throw new Error("unexpected rocm-smi csv format");
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(",");
      return {
        index: Number(cols[iDevice]),
        totalMB: Math.round(Number(cols[iTotal]) / 1024 / 1024),
        usedMB: Math.round(Number(cols[iUsed]) / 1024 / 1024),
      };
    });
}

/** RAM + GPU memory. Best-effort: missing GPU tools yield an empty gpu list, not an error. */
export async function systemResources(): Promise<SystemResources> {
  const res: SystemResources = {
    ram: { totalMB: Math.round(totalmem() / 1024 / 1024), freeMB: Math.round(freemem() / 1024 / 1024) },
    gpus: [],
  };
  try {
    res.gpus = await nvidiaGpus();
    return res;
  } catch {
    /* no nvidia-smi */
  }
  try {
    res.gpus = await rocmGpus();
    return res;
  } catch {
    res.note = "no supported GPU tool found (nvidia-smi / rocm-smi)";
  }
  return res;
}
