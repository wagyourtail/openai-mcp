import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { readdir, readFile, readlink } from "node:fs/promises";

const execFileP = promisify(execFile);

export interface GpuProcess {
  pid: number;
  cmdline: string;
  memBytes?: number;
}

export interface GpuInfo {
  index: number;
  name?: string;
  vendor?: string;
  driver?: string;
  pciSlot?: string;
  /** True for iGPUs whose "VRAM" is shared system memory (Ryzen/Intel iGPUs). */
  integrated?: boolean;
  totalMB?: number;
  usedMB?: number;
  freeMB?: number;
  /** Processes holding this GPU (when the reporting tool exposes them). */
  processes?: GpuProcess[];
}

export interface SystemResources {
  ram: { totalMB: number; freeMB: number };
  gpus: GpuInfo[];
  note?: string;
}

function vendorOf(name?: string): string | undefined {
  if (!name) return undefined;
  if (/nvidia|tesla|geforce|rtx|gtx|quadro/i.test(name)) return "nvidia";
  if (/amd|radeon|instinct|ryzen/i.test(name)) return "amd";
  if (/intel|arc|iris|xe\b|uhd/i.test(name)) return "intel";
  return undefined;
}

/** Integrated GPUs report shared system RAM as memory — flag them so callers don't size against it. */
export function isIntegrated(name?: string): boolean {
  return !!name && /ryzen|graphics|uhd|iris xe|apu|processor/i.test(name);
}

/** Best-effort PCI slot + driver for a DRM card index (Linux). */
async function drmDeviceInfo(index: number): Promise<{ pciSlot?: string; driver?: string }> {
  try {
    const uevent = await readFile(`/sys/class/drm/card${index}/device/uevent`, "utf-8");
    const pci = uevent.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
    const driver = uevent.match(/^DRIVER=(.+)$/m)?.[1];
    return { pciSlot: pci, driver };
  } catch {
    return {};
  }
}

async function enrichDrm(gpus: GpuInfo[]): Promise<void> {
  await Promise.all(
    gpus.map(async (g) => {
      const info = await drmDeviceInfo(g.index);
      g.pciSlot ??= info.pciSlot;
      g.driver ??= info.driver;
    }),
  );
}

interface NvtopDevice {
  device_name?: string;
  mem_total?: string;
  mem_used?: string;
  mem_free?: string;
  processes?: {
    pid?: string;
    cmdline?: string;
    gpu_mem_bytes_alloc?: string | null;
  }[];
}

export function parseNvtop(json: string): GpuInfo[] {
  const devices = JSON.parse(json) as NvtopDevice[];
  return devices.map((d, i) => ({
    index: i,
    name: d.device_name,
    vendor: vendorOf(d.device_name),
    integrated: isIntegrated(d.device_name) || undefined,
    totalMB: d.mem_total ? Math.round(Number(d.mem_total) / 1024 / 1024) : undefined,
    usedMB: d.mem_used ? Math.round(Number(d.mem_used) / 1024 / 1024) : undefined,
    freeMB: d.mem_free ? Math.round(Number(d.mem_free) / 1024 / 1024) : undefined,
    processes: (d.processes ?? [])
      .filter((p) => p.pid)
      .map((p) => ({
        pid: Number(p.pid),
        cmdline: p.cmdline ?? "",
        memBytes: p.gpu_mem_bytes_alloc ? Number(p.gpu_mem_bytes_alloc) : undefined,
      })),
  }));
}

async function nvtopGpus(): Promise<GpuInfo[]> {
  const { stdout } = await execFileP("nvtop", ["-s"], { timeout: 8000 });
  const gpus = parseNvtop(stdout);
  await enrichDrm(gpus);
  return gpus;
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const { stdout } = await execFileP(
    "nvidia-smi",
    ["--query-gpu=index,name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { timeout: 5000 },
  );
  const gpus: GpuInfo[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used] = line.split(",").map((s) => s.trim());
      const t = Number(total);
      const u = Number(used);
      return {
        index: Number(index),
        name,
        vendor: "nvidia" as const,
        totalMB: t,
        usedMB: u,
        freeMB: Number.isFinite(t) && Number.isFinite(u) ? t - u : undefined,
      };
    });
  // Per-process attribution: nvidia-smi reports compute apps with gpu uuid/index.
  try {
    const { stdout: apps } = await execFileP(
      "nvidia-smi",
      ["--query-compute-apps=pid,process_name,gpu_index,used_memory", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
    );
    for (const line of apps.trim().split("\n").filter(Boolean)) {
      const [pid, proc, gpuIdx, mem] = line.split(",").map((s) => s.trim());
      const g = gpus.find((x) => x.index === Number(gpuIdx));
      if (!g) continue;
      (g.processes ??= []).push({
        pid: Number(pid),
        cmdline: proc,
        memBytes: Number.isFinite(Number(mem)) ? Number(mem) * 1024 * 1024 : undefined,
      });
    }
  } catch {
    /* older drivers lack --query-compute-apps */
  }
  return gpus;
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
  const gpus = lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(",");
      const t = Number(cols[iTotal]) / 1024 / 1024;
      const u = Number(cols[iUsed]) / 1024 / 1024;
      return {
        index: Number(cols[iDevice]),
        vendor: "amd" as const,
        totalMB: Math.round(t),
        usedMB: Math.round(u),
        freeMB: Math.round(t - u),
      };
    });
  await enrichDrm(gpus);
  return gpus;
}

/** RAM + GPU memory. Best-effort: missing GPU tools yield an empty gpu list, not an error. */
export async function systemResources(): Promise<SystemResources> {
  const res: SystemResources = {
    ram: { totalMB: Math.round(totalmem() / 1024 / 1024), freeMB: Math.round(freemem() / 1024 / 1024) },
    gpus: [],
  };
  const probes: { name: string; fn: () => Promise<GpuInfo[]> }[] = [
    // nvtop covers NVIDIA + AMD + Intel uniformly and reports per-process usage.
    { name: "nvtop", fn: nvtopGpus },
    { name: "nvidia-smi", fn: nvidiaGpus },
    { name: "rocm-smi", fn: rocmGpus },
  ];
  const tried: string[] = [];
  for (const p of probes) {
    tried.push(p.name);
    try {
      const gpus = await p.fn();
      if (gpus.length) {
        res.gpus = gpus;
        return res;
      }
    } catch {
      /* probe unavailable — try next */
    }
  }
  res.note = `no GPU info found (tried: ${tried.join(", ")})`;
  return res;
}

// ---------------------------------------------------------------------------
// Ollama GPU placement: which GPU(s) the server is pinned to / using.
// ---------------------------------------------------------------------------

/** Env vars that decide which GPU(s) ollama lands on, per vendor. */
const GPU_ENV_VARS = [
  "CUDA_VISIBLE_DEVICES", // nvidia
  "HIP_VISIBLE_DEVICES", // amd
  "ROCR_VISIBLE_DEVICES", // amd
  "ONEAPI_DEVICE_SELECTOR", // intel (e.g. level_zero:0)
  "ZE_AFFINITY_MASK", // intel level-zero
  "GPU_DEVICE_ORDINAL", // amd
];

const OLLAMA_PROC_RE = /ollama|llama-server|llama\.cpp/i;

interface ProcEntry {
  pid: number;
  cmdline: string;
  isServer: boolean;
}

async function readProcFile(pid: number, name: string): Promise<string> {
  return readFile(`/proc/${pid}/${name}`, "utf-8").catch(() => "");
}

async function findOllamaProcs(): Promise<ProcEntry[]> {
  const out: ProcEntry[] = [];
  let pids: string[] = [];
  try {
    pids = await readdir("/proc");
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = (await readProcFile(Number(pid), "cmdline")).replace(/\0/g, " ").trim();
    if (!cmdline || !OLLAMA_PROC_RE.test(cmdline)) continue;
    if (/^npm |^node |^bash |^sh -c|pgrep/.test(cmdline) && !/ollama (serve|runner)|llama-server/.test(cmdline)) continue;
    out.push({
      pid: Number(pid),
      cmdline,
      isServer: /ollama serve|ollama\.serve/i.test(cmdline) || /^\/\S*ollama serve/.test(cmdline),
    });
  }
  return out;
}

/** GPU-pinning env vars set on a process. */
async function gpuEnvOf(pid: number): Promise<Record<string, string>> {
  const raw = await readProcFile(pid, "environ");
  const out: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    const k = kv.slice(0, i);
    if (GPU_ENV_VARS.includes(k) || /^OLLAMA_/i.test(k)) out[k] = kv.slice(i + 1);
  }
  return out;
}

/**
 * Which GPUs a pid actually holds, via device fds. NVIDIA: /dev/nvidiaN gives
 * the index directly. DRM: /dev/dri/cardN or renderDN (resolved via sysfs to
 * its cardN). Best-effort — empty means "unknown", not "none".
 */
async function gpuFdsOf(pid: number, renderToCard: Map<number, number>): Promise<number[]> {
  const cards = new Set<number>();
  let fds: string[] = [];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const nvidia = target.match(/^\/dev\/nvidia(\d+)$/);
    if (nvidia) {
      cards.add(Number(nvidia[1]));
      continue;
    }
    const card = target.match(/^\/dev\/dri\/card(\d+)$/);
    if (card) {
      cards.add(Number(card[1]));
      continue;
    }
    const render = target.match(/^\/dev\/dri\/renderD(\d+)$/);
    if (render) {
      const c = renderToCard.get(Number(render[1]));
      if (c !== undefined) cards.add(c);
    }
  }
  return [...cards].sort();
}

/** Map /dev/dri/renderDN -> cardN via sysfs symlinks. */
async function renderToCardMap(): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  let entries: string[] = [];
  try {
    entries = await readdir("/sys/class/drm");
  } catch {
    return m;
  }
  for (const e of entries) {
    const r = e.match(/^renderD(\d+)$/);
    if (!r) continue;
    try {
      const link = await readlink(`/sys/class/drm/${e}/device`);
      const card = link.match(/card(\d+)/)?.[1];
      if (card !== undefined) m.set(Number(r[1]), Number(card));
    } catch {
      /* skip */
    }
  }
  return m;
}

export interface OllamaGpuPlacement {
  server_pids: number[];
  /** GPU-selection env vars found on the `ollama serve` process(es). */
  env: Record<string, string>;
  /** GPU indices parsed from the pinning env (numeric selectors only). */
  pinned_indices: number[];
  runners: { pid: number; cmdline: string; gpu_indices: number[]; env: Record<string, string> }[];
  /** Union of GPU indices observed in use by any ollama process. */
  gpus_in_use: number[];
  note?: string;
}

/**
 * Best-effort parse of pinning env values into GPU indices. Handles numeric
 * lists ("0,2"), level-zero selectors ("level_zero:1"), and affinity masks;
 * skips values that aren't numeric selectors (e.g. GPU UUIDs).
 */
export function pinnedGpuIndices(env: Record<string, string>): number[] {
  const out = new Set<number>();
  for (const [k, v] of Object.entries(env)) {
    if (/VISIBLE_DEVICES|ORDINAL|AFFINITY/.test(k)) {
      for (const part of v.split(",")) {
        if (/^\d+$/.test(part.trim())) out.add(Number(part.trim()));
      }
    } else if (/ONEAPI_DEVICE_SELECTOR|ZE_AFFINITY/.test(k)) {
      // "level_zero:0" or "level_zero:0,1" — take trailing digit runs.
      for (const m of v.matchAll(/:(\d+)/g)) out.add(Number(m[1]));
      if (/^\d+$/.test(v.trim())) out.add(Number(v.trim()));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Where ollama is (or will be) running: env pinning + observed runner GPUs. */
export async function ollamaGpuPlacement(gpus: GpuInfo[]): Promise<OllamaGpuPlacement> {
  const out: OllamaGpuPlacement = { server_pids: [], env: {}, pinned_indices: [], runners: [], gpus_in_use: [] };
  const procs = await findOllamaProcs();
  if (!procs.length) {
    out.note = "no ollama processes found on this host";
    return out;
  }
  const renderMap = await renderToCardMap();
  const inUse = new Set<number>();
  for (const p of procs) {
    const env = await gpuEnvOf(p.pid);
    const idx = await gpuFdsOf(p.pid, renderMap);
    if (p.isServer) {
      out.server_pids.push(p.pid);
      Object.assign(out.env, env);
    } else {
      out.runners.push({
        pid: p.pid,
        cmdline: p.cmdline.slice(0, 200),
        gpu_indices: idx,
        env,
      });
    }
    for (const i of idx) inUse.add(i);
  }
  // Fall back to the GPU tool's process list when /proc fd scan found nothing
  // (e.g. nvtop attributes a runner to a device we can't see in /proc).
  if (!inUse.size) {
    for (const g of gpus) {
      for (const proc of g.processes ?? []) {
        if (OLLAMA_PROC_RE.test(proc.cmdline)) inUse.add(g.index);
      }
    }
  }
  out.gpus_in_use = [...inUse].sort((a, b) => a - b);
  out.pinned_indices = pinnedGpuIndices(out.env);
  if (!Object.keys(out.env).length && !out.gpus_in_use.length) {
    out.note =
      "no GPU pinning env on the ollama server and no runner observed on a specific GPU " +
      "(idle servers hold no GPU). Ollama will auto-select; pin it with CUDA_VISIBLE_DEVICES " +
      "(NVIDIA), HIP_VISIBLE_DEVICES/ROCR_VISIBLE_DEVICES (AMD), or ONEAPI_DEVICE_SELECTOR " +
      "e.g. level_zero:0 (Intel) on the `ollama serve` process.";
  }
  return out;
}
