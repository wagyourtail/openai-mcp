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
  /** Enumeration index in whichever tool reported this GPU. NOT the DRM card number. */
  index: number;
  /** DRM cardN (kernel order) — resolved via PCI match, never assumed == index. */
  cardN?: number;
  name?: string;
  vendor?: string;
  driver?: string;
  /** Canonical GPU identity: PCI bus id, e.g. "0000:04:00.0". */
  pciSlot?: string;
  /** True for iGPUs whose "VRAM" is shared system memory (Ryzen/Intel iGPUs). */
  integrated?: boolean;
  totalMB?: number;
  usedMB?: number;
  freeMB?: number;
  /** Where freeMB came from — "journal-boot" values are startup snapshots, may overstate. */
  freeSource?: string;
  processes?: GpuProcess[];
}

export interface SystemResources {
  ram: { totalMB: number; freeMB: number };
  gpus: GpuInfo[];
  note?: string;
}

/** "0000:04:00.0" | "00000000:04:00.0" | "04:00.0" → "04:00.0" (match key). */
export function normPci(s?: string): string {
  if (!s) return "";
  return (s.trim().toLowerCase().match(/([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/)?.[1]) ?? s.trim().toLowerCase();
}

/** Canonical display form "0000:04:00.0" — pads the domain when missing. */
export function canonPci(s?: string): string {
  const n = normPci(s);
  return /^[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/.test(n) ? `0000:${n}` : (s ?? "");
}

function vendorOf(name?: string): string | undefined {
  if (!name) return undefined;
  if (/nvidia|tesla|geforce|rtx|gtx|quadro/i.test(name)) return "nvidia";
  if (/amd|ati|radeon|instinct|ryzen|navi/i.test(name)) return "amd";
  if (/intel|arc|iris|xe\b|uhd|hd graphics/i.test(name)) return "intel";
  return undefined;
}

/** Integrated GPUs report shared system RAM as memory — flag them so callers don't size against it. */
export function isIntegrated(name?: string): boolean {
  return !!name && /ryzen|graphics|uhd|iris xe|apu|processor|hd \d/i.test(name);
}

export function parseSizeMB(v: string | undefined, unit?: string): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return undefined;
  switch ((unit ?? "").toLowerCase()) {
    case "gib": return Math.round(n * 1024);
    case "gb": return Math.round(n * 1000);
    case "mib": case "mb": return Math.round(n);
    case "kib": case "kb": return Math.round(n / 1024);
    default: return Math.round(n / 1024 / 1024); // raw bytes
  }
}

// ---------------------------------------------------------------------------
// DRM card enumeration + PCI identity (the canonical GPU key — never index).
// ---------------------------------------------------------------------------

export interface DrmCard {
  cardN: number;
  pciSlot: string;
  driver?: string;
  name?: string;
}

async function lspciNames(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const { stdout } = await execFileP("lspci", ["-D", "-nn"], { timeout: 5000 });
    for (const line of stdout.split("\n")) {
      const match = line.match(/^([0-9a-f:]+:[0-9a-f]{2}\.[0-9a-f])\s+\S+[^:]*:\s*(.+?)\s*\[[0-9a-f]{4}:[0-9a-f]{4}\]/i);
      if (match) m.set(normPci(match[1]), match[2].replace(/\s*\(rev.*\)$/, ""));
      else {
        const loose = line.match(/^([0-9a-f:]+:[0-9a-f]{2}\.[0-9a-f])\s+\S+[^:]*:\s*(.+)$/i);
        if (loose) m.set(normPci(loose[1]), loose[2].replace(/\s*\(rev.*\)$/, ""));
      }
    }
  } catch {
    /* no lspci */
  }
  return m;
}

export async function drmCards(): Promise<DrmCard[]> {
  const names = await lspciNames();
  const cards: DrmCard[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir("/sys/class/drm");
  } catch {
    return cards;
  }
  for (const e of entries) {
    const m = e.match(/^card(\d+)$/);
    if (!m) continue;
    try {
      const uevent = await readFile(`/sys/class/drm/${e}/device/uevent`, "utf-8");
      const pci = uevent.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1]?.trim();
      if (!pci) continue;
      cards.push({
        cardN: Number(m[1]),
        pciSlot: pci,
        driver: uevent.match(/^DRIVER=(.+)$/m)?.[1]?.trim(),
        name: names.get(normPci(pci)),
      });
    } catch {
      /* unreadable card */
    }
  }
  return cards;
}

const NAME_STOPWORDS = new Set(
  "intel amd ati nvidia corporation inc advanced micro devices device graphics vga compatible controller 3d display co ltd tm r radeon geforce"
    .split(" "),
);

function nameTokens(name?: string): Set<string> {
  return new Set(
    (name ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((t) => !NAME_STOPWORDS.has(t)) ?? [],
  );
}

/** Shared distinctive tokens between two device names. */
export function nameMatchScore(a?: string, b?: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  let score = 0;
  for (const t of ta) if (tb.has(t) && t.length >= 3) score++;
  return score;
}

/**
 * Bind each tool-reported GPU to a DRM card. Never matches by enumeration
 * order: exact PCI bus id first, then device-name token score, then a
 * single-candidate same-vendor fallback. Also fills sysfs VRAM for i915/xe/amdgpu.
 */
export function assignCards(gpus: GpuInfo[], cards: DrmCard[]): void {
  const byPci = new Map(cards.map((c) => [normPci(c.pciSlot), c]));
  const taken = new Set<number>();
  // Exact PCI match (nvidia-smi --query-gpu=pci.bus_id, journal pci_id, …).
  for (const g of gpus) {
    const c = g.pciSlot ? byPci.get(normPci(g.pciSlot)) : undefined;
    if (c) {
      g.cardN = c.cardN;
      g.pciSlot = c.pciSlot;
      g.driver ??= c.driver;
      g.name ??= c.name;
      taken.add(c.cardN);
    }
  }
  // Name-match the rest against remaining cards.
  for (const g of gpus) {
    if (g.cardN !== undefined) continue;
    let best: DrmCard | undefined;
    let bestScore = 0;
    for (const c of cards) {
      if (taken.has(c.cardN)) continue;
      const s = nameMatchScore(g.name, c.name);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best && bestScore >= 1) {
      g.cardN = best.cardN;
      g.pciSlot = best.pciSlot;
      g.driver ??= best.driver;
      g.name ??= best.name;
      taken.add(best.cardN);
    }
  }
  // Single-candidate same-vendor fallback.
  for (const g of gpus) {
    if (g.cardN !== undefined || !g.vendor) continue;
    const candidates = cards.filter((c) => !taken.has(c.cardN) && vendorOf(c.name) === g.vendor);
    if (candidates.length === 1) {
      const c = candidates[0];
      g.cardN = c.cardN;
      g.pciSlot = c.pciSlot;
      g.driver ??= c.driver;
      g.name ??= c.name;
      taken.add(c.cardN);
    }
  }
  for (const g of gpus) {
    g.vendor ??= vendorOf(g.name);
    g.integrated ??= isIntegrated(g.name) || undefined;
  }
}

async function sysfsVramMB(cardN: number): Promise<{ totalMB?: number; usedMB?: number; freeMB?: number }> {
  const read = async (f: string): Promise<number | undefined> => {
    try {
      const v = parseInt(await readFile(`/sys/class/drm/card${cardN}/device/${f}`, "utf-8"), 10);
      return Number.isFinite(v) ? Math.round(v / 1024 / 1024) : undefined;
    } catch {
      return undefined;
    }
  };
  // amdgpu + xe expose mem_info_vram_*; i915 dGPUs (DG2/Arc) expose lmem_*.
  const totalMB = (await read("mem_info_vram_total")) ?? (await read("lmem_total_bytes"));
  const usedMB = await read("mem_info_vram_used");
  const freeMB = await read("lmem_avail_bytes");
  return { totalMB, usedMB, freeMB };
}

// ---------------------------------------------------------------------------
// GPU probes (ordered: nvtop covers all vendors + processes).
// ---------------------------------------------------------------------------

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
  return parseNvtop(stdout);
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const { stdout } = await execFileP(
    "nvidia-smi",
    ["--query-gpu=index,name,memory.total,memory.used,pci.bus_id", "--format=csv,noheader,nounits"],
    { timeout: 5000 },
  );
  const gpus: GpuInfo[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used, bus] = line.split(",").map((s) => s.trim());
      const t = Number(total);
      const u = Number(used);
      return {
        index: Number(index),
        name,
        vendor: "nvidia" as const,
        totalMB: t,
        usedMB: u,
        freeMB: Number.isFinite(t) && Number.isFinite(u) ? t - u : undefined,
        pciSlot: bus || undefined,
      };
    });
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
  const gpus: GpuInfo[] = lines
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
  // PCI bus per card, for identity.
  try {
    const { stdout: bus } = await execFileP("rocm-smi", ["--showbus", "--csv"], { timeout: 5000 });
    const blines = bus.trim().split("\n");
    const bhead = blines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
    const biDev = bhead.findIndex((h) => h.includes("device"));
    const biBus = bhead.findIndex((h) => h.includes("pci bus"));
    if (biDev >= 0 && biBus >= 0) {
      for (const line of blines.slice(1).filter(Boolean)) {
        const cols = line.split(",");
        const g = gpus.find((x) => x.index === Number(cols[biDev]));
        if (g) g.pciSlot = cols[biBus]?.trim() || undefined;
      }
    }
  } catch {
    /* rocm-smi without --showbus */
  }
  return gpus;
}

/** RAM + GPU memory. Best-effort: missing GPU tools yield an empty gpu list, not an error. */
export async function systemResources(): Promise<SystemResources> {
  const res: SystemResources = {
    ram: { totalMB: Math.round(totalmem() / 1024 / 1024), freeMB: Math.round(freemem() / 1024 / 1024) },
    gpus: [],
  };
  const probes: { name: string; fn: () => Promise<GpuInfo[]> }[] = [
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
        for (const g of gpus) if (g.freeMB !== undefined) g.freeSource = p.name;
        res.gpus = gpus;
        break;
      }
    } catch {
      /* probe unavailable — try next */
    }
  }
  if (!res.gpus.length) {
    res.note = `no GPU info found (tried: ${tried.join(", ")})`;
    return res;
  }
  // Bind to DRM cards by PCI identity, then fill sysfs VRAM gaps (i915/xe/amdgpu).
  const cards = await drmCards();
  assignCards(res.gpus, cards);
  const byCard = new Map(cards.map((c) => [c.cardN, c]));
  await Promise.all(
    res.gpus.map(async (g) => {
      if (g.cardN === undefined || !byCard.has(g.cardN)) return;
      const v = await sysfsVramMB(g.cardN);
      g.totalMB ??= v.totalMB;
      g.usedMB ??= v.usedMB;
      g.freeMB ??= v.freeMB;
      if (g.freeMB === undefined && g.totalMB !== undefined && g.usedMB !== undefined) {
        g.freeMB = g.totalMB - g.usedMB;
      }
      if (g.freeMB !== undefined) g.freeSource ??= "sysfs";
    }),
  );
  return res;
}

// ---------------------------------------------------------------------------
// Ollama GPU placement: env pinning + runner device-fd attribution.
// ---------------------------------------------------------------------------

/** Env vars that decide which GPU(s) ollama lands on, per vendor/backend. */
const GPU_ENV_VARS = [
  "CUDA_VISIBLE_DEVICES", // nvidia
  "GGML_CUDA_VISIBLE_DEVICES", // llama.cpp cuda backend
  "HIP_VISIBLE_DEVICES", // amd rocm
  "ROCR_VISIBLE_DEVICES", // amd rocm
  "GGML_VK_VISIBLE_DEVICES", // llama.cpp vulkan backend (Intel Arc path)
  "ONEAPI_DEVICE_SELECTOR", // intel (e.g. level_zero:0)
  "ZE_AFFINITY_MASK", // intel level-zero
  "GPU_DEVICE_ORDINAL", // amd
  "VK_DEVICE_SELECT", // mesa vulkan selector
  "VK_ICD_FILENAMES", // forces a specific vulkan ICD/driver
  "DRI_PRIME", // mesa prime offloading
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
    if (/pgrep|grep .*ollama/.test(cmdline)) continue;
    out.push({
      pid: Number(pid),
      cmdline,
      isServer: /ollama serve|ollama\.serve/i.test(cmdline) || /^\/\S*ollama serve/.test(cmdline),
    });
  }
  return out;
}

/** GPU-pinning env vars set on a process (empty object when /proc is denied). */
async function gpuEnvOf(pid: number): Promise<{ env: Record<string, string>; readable: boolean }> {
  let raw = "";
  try {
    raw = await readFile(`/proc/${pid}/environ`, "utf-8");
  } catch {
    return { env: {}, readable: false };
  }
  const out: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    const k = kv.slice(0, i);
    if (GPU_ENV_VARS.includes(k) || /^OLLAMA_/i.test(k) || /^GGML_/i.test(k)) {
      out[k] = kv.slice(i + 1);
    }
  }
  return { env: out, readable: raw.length > 0 };
}

// --- systemd / journal fallbacks (ollama under systemd as another user) ---

/** Parse `KEY=value` lines (systemd EnvironmentFile format). */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Parse `systemctl show ollama` output → unit env + EnvironmentFile paths. */
export function parseSystemdShow(text: string): { env: Record<string, string>; envFiles: string[] } {
  const env: Record<string, string> = {};
  const envFiles: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Environment=")) {
      for (const pair of line.slice("Environment=".length).trim().split(/\s+/)) {
        const i = pair.indexOf("=");
        if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
      }
    } else if (line.startsWith("EnvironmentFiles=")) {
      for (const tok of line.slice("EnvironmentFiles=".length).trim().split(/\s+/)) {
        if (tok.startsWith("/")) envFiles.push(tok);
        else if (tok.startsWith("-/")) envFiles.push(tok.slice(1));
      }
    }
  }
  return { env, envFiles };
}

export interface InferenceDevice {
  /** Selector ordinal VISIBLE_DEVICES-style env vars index into (filter_id when logged). */
  index: number;
  /** Post-filter log id (informational only — NOT the selector ordinal). */
  id?: number;
  family: string;
  name: string;
  pci: string;
  totalMB: number;
  /** Boot-time reading — journal only emits discovery lines at server start. */
  availMB: number;
  asOf?: "startup";
}

/**
 * Parse ollama journal: `env=map[...]` plus `inference compute` device lines.
 * Journal may span multiple boots — env vars come from the LAST env=map line
 * (the current boot's full map), and device lines that precede it belong to
 * older boots and are dropped (devices after it are the current survivors,
 * which under a visible-devices pin is exactly the pinned set).
 * Device index prefers `filter_id=` (the pre-filter backend ordinal that
 * GGML_VK_VISIBLE_DEVICES/CUDA_VISIBLE_DEVICES select), then the trailing
 * digits of `name=VulkanN`/`cudaN`, then the `id=` field — the latter two
 * renumber per boot under a pin, so they're last resort.
 */
export function parseOllamaJournal(text: string): { env: Record<string, string>; devices: InferenceDevice[] } {
  const lines = text.split("\n");
  let lastEnvIdx = -1;
  let env: Record<string, string> = {};
  const parsed: { lineIdx: number; dev: InferenceDevice }[] = [];
  for (const [lineIdx, line] of lines.entries()) {
    const envMatch = line.match(/env=map\[([^\]]+)\]/);
    if (envMatch) {
      lastEnvIdx = lineIdx;
      env = {};
      for (const entry of envMatch[1].split(/\s+/).filter(Boolean)) {
        const i = entry.indexOf(":");
        if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
      }
      continue;
    }
    if (!/inference compute/.test(line)) continue;
    const nameM = line.match(/\bname=(\S+)/);
    const descM = line.match(/\bdescription="([^"]+)"/) ?? line.match(/\bdescription=(\S+)/);
    const pciM = line.match(/\bpci_id=(\S+)/);
    const totalM = line.match(/\btotal="?([\d.]+)\s*(GiB|MiB|GB|MB|KiB|KB)"?/i);
    const availM = line.match(/\bavailable="?([\d.]+)\s*(GiB|MiB|GB|MB|KiB|KB)"?/i);
    const filterM = line.match(/\bfilter_id=(\d+)/);
    const idM = line.match(/\bid=(\d+)/);
    const nameTok = nameM?.[1] ?? "";
    const idxM = nameTok.match(/(\d+)$/);
    const index = filterM ? Number(filterM[1]) : idxM ? Number(idxM[1]) : idM ? Number(idM[1]) : 0;
    parsed.push({
      lineIdx,
      dev: {
        index,
        id: idM ? Number(idM[1]) : undefined,
        family: (idxM ? nameTok.slice(0, nameTok.length - idxM[1].length) : nameTok).toLowerCase(),
        name: descM?.[1] ?? nameTok,
        pci: pciM?.[1] ?? "",
        totalMB: totalM ? (parseSizeMB(totalM[1], totalM[2]) ?? 0) : 0,
        availMB: availM ? (parseSizeMB(availM[1], availM[2]) ?? 0) : 0,
        asOf: "startup",
      },
    });
  }
  // Prefer current-boot devices (after the last env=map). If that leaves none —
  // e.g. a boot that logged devices but no env map — fall back to all of them.
  const pool = lastEnvIdx >= 0 ? parsed.filter((p) => p.lineIdx > lastEnvIdx) : parsed;
  const candidates = pool.length ? pool : parsed;
  const byKey = new Map<string, InferenceDevice>();
  for (const { dev } of candidates) {
    byKey.set(dev.pci ? `pci:${normPci(dev.pci)}` : `${dev.family}:${dev.index}`, dev); // last wins
  }
  return { env, devices: [...byKey.values()] };
}

/** ActiveEnterTimestamp of the ollama unit — confines journal queries to the current boot. */
async function ollamaActiveSince(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(
      "systemctl",
      ["show", "ollama", "-p", "ActiveEnterTimestamp"],
      { timeout: 5000 },
    );
    const ts = stdout.trim().split("=")[1]?.trim();
    return ts || undefined;
  } catch {
    return undefined;
  }
}

async function ollamaJournal(): Promise<{ env: Record<string, string>; devices: InferenceDevice[] }> {
  const since = await ollamaActiveSince();
  const sinceArgs = since ? ["--since", since] : [];
  try {
    // Pattern query, not recency: startup lines (env map, device discovery) age
    // out of any -n window on a long-running server.
    const { stdout } = await execFileP(
      "journalctl",
      ["-u", "ollama", "--no-pager", "-o", "cat", ...sinceArgs, "-g", "inference compute|env=map"],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = parseOllamaJournal(stdout);
    if (Object.keys(parsed.env).length || parsed.devices.length) return parsed;
  } catch {
    /* -g unsupported (old systemd) or journalctl unavailable — fall through */
  }
  try {
    const { stdout } = await execFileP(
      "journalctl",
      ["-u", "ollama", "-n", "5000", "--no-pager", "-o", "cat", ...sinceArgs],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseOllamaJournal(stdout);
  } catch {
    return { env: {}, devices: [] };
  }
}

/** ollama's env from the systemd unit (Environment= + EnvironmentFiles contents). */
async function systemdOllamaEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const unit of ["ollama", "ollama.service"]) {
    try {
      const { stdout } = await execFileP(
        "systemctl",
        ["show", unit, "-p", "Environment", "-p", "EnvironmentFiles"],
        { timeout: 5000 },
      );
      const { env, envFiles } = parseSystemdShow(stdout);
      // EnvironmentFile content first, unit Environment= overrides it.
      for (const f of envFiles) {
        try {
          Object.assign(out, parseEnvFile(await readFile(f, "utf-8")));
        } catch {
          /* file unreadable (perm or missing) */
        }
      }
      Object.assign(out, env);
      if (Object.keys(out).length) return out;
    } catch {
      /* unit missing or systemctl unavailable */
    }
  }
  return out;
}

/**
 * Which GPUs a pid actually holds, via device fds. NVIDIA: /dev/nvidiaN gives
 * the index directly. DRM: /dev/dri/cardN or renderDN (resolved via sysfs to
 * its cardN). Returns DRM card numbers — callers map them to pciSlot.
 */
async function gpuCardsOf(pid: number, renderToCard: Map<number, number>): Promise<number[]> {
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
  /** GPU/ollama env vars discovered (see env_source for where they came from). */
  env: Record<string, string>;
  env_source: "proc" | "systemd" | "journal" | "none";
  env_note?: string;
  /** Raw numeric selectors parsed from pinning env (index space varies per backend). */
  pinned_indices: number[];
  /** PCI slots the pinning env resolves to, where resolvable. */
  pinned_slots: string[];
  runners: {
    pid: number;
    cmdline: string;
    gpu_cards: number[];
    gpu_slots: string[];
    env: Record<string, string>;
  }[];
  /** PCI slots observed in use by any ollama process. */
  gpus_in_use: string[];
  /** Devices ollama itself discovered (journal `inference compute` lines). */
  inference_devices: InferenceDevice[];
  note?: string;
}

/**
 * GPU slots ollama processes appear on in a GPU tool's process list.
 * <256MB allocations are backend probe contexts, not placement — a
 * Vulkan-pinned llama-server still grabs ~3MB of CUDA context at startup.
 */
const PROBE_CONTEXT_BYTES = 256 * 1024 * 1024;
export function procListGpuSlots(gpus: GpuInfo[]): string[] {
  const slots = new Set<string>();
  for (const g of gpus) {
    for (const proc of g.processes ?? []) {
      if (!OLLAMA_PROC_RE.test(proc.cmdline) || !g.pciSlot) continue;
      if (proc.memBytes !== undefined && proc.memBytes < PROBE_CONTEXT_BYTES) continue;
      slots.add(canonPci(g.pciSlot));
    }
  }
  return [...slots].sort();
}

function envPins(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (GPU_ENV_VARS.includes(k)) out[k] = v;
  return out;
}

/**
 * Resolve numeric pinning selectors to PCI slots, best-effort.
 * GGML_VK_* → journal "vulkan" family devices (authoritative, since llama.cpp's
 * Vulkan ordinal is what the journal enumerates). CUDA_* → "cuda" devices or
 * the Nth nvidia GPU. HIP/ROCR → "rocm"/amd devices or Nth amd GPU.
 * ONEAPI level_zero:N → Nth intel GPU.
 */
export function resolvePinnedSlots(
  env: Record<string, string>,
  devices: InferenceDevice[],
  gpus: GpuInfo[],
): { indices: number[]; slots: string[] } {
  const indices = new Set<number>();
  const slots = new Set<string>();
  const pciOf = (family: string, idx: number, vendor: string): string | undefined => {
    const d = devices.find((x) => x.family === family && x.index === idx);
    if (d?.pci) return canonPci(d.pci);
    const vg = gpus.filter((g) => g.vendor === vendor && g.pciSlot).sort((a, b) => a.index - b.index);
    return vg[idx] ? canonPci(vg[idx].pciSlot) : undefined;
  };
  for (const [k, v] of Object.entries(env)) {
    const nums: number[] = [];
    if (/VISIBLE_DEVICES|ORDINAL|AFFINITY/.test(k)) {
      for (const p of v.split(",")) if (/^\d+$/.test(p.trim())) nums.push(Number(p.trim()));
    } else if (/ONEAPI_DEVICE_SELECTOR|ZE_AFFINITY/.test(k)) {
      for (const m of v.matchAll(/:(\d+)/g)) nums.push(Number(m[1]));
      if (/^\d+$/.test(v.trim())) nums.push(Number(v.trim()));
    }
    for (const n of nums) {
      indices.add(n);
      const slot =
        /VK|VULKAN/.test(k) ? pciOf("vulkan", n, "intel")
        : /CUDA/.test(k) ? pciOf("cuda", n, "nvidia")
        : /HIP|ROCR|ORDINAL/.test(k) ? pciOf("rocm", n, "amd")
        : /ONEAPI|ZE_/.test(k) ? pciOf("sycl", n, "intel") ?? pciOf("level_zero", n, "intel")
        : undefined;
      if (slot) slots.add(slot);
    }
  }
  return { indices: [...indices].sort((a, b) => a - b), slots: [...slots].sort() };
}

/** Where ollama is (or will be) running: env pinning + observed runner GPUs. */
export async function ollamaGpuPlacement(gpus: GpuInfo[]): Promise<OllamaGpuPlacement> {
  const out: OllamaGpuPlacement = {
    server_pids: [],
    env: {},
    env_source: "none",
    pinned_indices: [],
    pinned_slots: [],
    runners: [],
    gpus_in_use: [],
    inference_devices: [],
  };
  const procs = await findOllamaProcs();
  const cards = await drmCards();
  const cardToPci = new Map(cards.map((c) => [c.cardN, canonPci(c.pciSlot)]));
  const renderMap = await renderToCardMap();
  const inUseSlots = new Set<string>();
  const envNotes: string[] = [];

  let serverEnvReadable = true;
  for (const p of procs) {
    const { env, readable } = await gpuEnvOf(p.pid);
    const fdCards = await gpuCardsOf(p.pid, renderMap);
    const fdSlots = fdCards.map((c) => cardToPci.get(c)).filter((s): s is string => !!s);
    if (p.isServer) {
      out.server_pids.push(p.pid);
      if (readable) {
        Object.assign(out.env, env);
        if (Object.keys(env).length || Object.keys(out.env).length) out.env_source = "proc";
      } else {
        serverEnvReadable = false;
      }
    } else {
      out.runners.push({
        pid: p.pid,
        cmdline: p.cmdline.slice(0, 200),
        gpu_cards: fdCards,
        gpu_slots: fdSlots,
        env,
      });
    }
    for (const s of fdSlots) inUseSlots.add(s);
  }

  // Fallback env discovery: systemd unit (env + EnvironmentFiles), then journal.
  if (!serverEnvReadable && out.server_pids.length) {
    envNotes.push("cross-user /proc/<pid>/environ denied — reading env from systemd/journal instead");
  }
  if (out.env_source === "none") {
    const sd = await systemdOllamaEnv();
    const pins = envPins(sd);
    if (Object.keys(pins).length || Object.keys(sd).length) {
      out.env = { ...sd, ...out.env };
      out.env_source = "systemd";
    }
  }
  const journal = await ollamaJournal();
  out.inference_devices = journal.devices;
  if (out.env_source === "none" && Object.keys(journal.env).length) {
    out.env = journal.env;
    out.env_source = "journal";
  } else if (Object.keys(journal.env).length) {
    // Journal's map[] is the server's full effective env — fill any gaps.
    for (const [k, v] of Object.entries(journal.env)) out.env[k] ??= v;
  }
  if (envNotes.length) out.env_note = envNotes.join("; ");

  // Observed usage: runner fds first, then the GPU tool's process list.
  if (!inUseSlots.size) {
    for (const s of procListGpuSlots(gpus)) inUseSlots.add(s);
  }

  const pins = envPins(out.env);
  const resolved = resolvePinnedSlots(pins, out.inference_devices, gpus);
  out.pinned_indices = resolved.indices;
  out.pinned_slots = resolved.slots;

  // Probe-context floor + pinning inference: a llama-server under
  // GGML_VK_VISIBLE_DEVICES still grabs a few MB of CUDA context during
  // backend probing — tiny allocations are probes, not placement. And when
  // nothing was observed at all (cross-user /proc fd denial), the pin env is
  // the best placement evidence there is.
  if (!inUseSlots.size && out.pinned_slots.length) {
    for (const s of out.pinned_slots) inUseSlots.add(s);
    out.note = out.note
      ? `${out.note} gpus_in_use inferred from pinning (no process attribution available).`
      : "gpus_in_use inferred from env pinning — no ollama process could be attributed to a GPU (cross-user /proc or idle).";
  }
  out.gpus_in_use = [...inUseSlots].sort();

  if (!Object.keys(pins).length && !out.gpus_in_use.length) {
    out.note =
      "no GPU pinning env found for ollama and no runner observed on a specific GPU " +
      "(idle servers hold no GPU). Ollama will auto-select; pin it with the backend-appropriate " +
      "var on `ollama serve`: CUDA_VISIBLE_DEVICES (NVIDIA), HIP_VISIBLE_DEVICES/" +
      "ROCR_VISIBLE_DEVICES (AMD), ONEAPI_DEVICE_SELECTOR=level_zero:N (Intel SYCL), or " +
      "GGML_VK_VISIBLE_DEVICES=N (Vulkan).";
  }
  if (!procs.length) {
    out.note = out.note ? `no ollama processes found. ${out.note}` : "no ollama processes found on this host";
  }
  return out;
}
