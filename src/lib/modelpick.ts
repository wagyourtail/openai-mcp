import type { ModelInfo } from "../providers/index.ts";

export interface RankedModel extends ModelInfo {
  /** "yes": blob + ~25% headroom fits. "marginal": blob fits, headroom doesn't. "no": blob alone exceeds. */
  fit: "yes" | "marginal" | "no";
  /** fit !== "no" — marginal models still count (ollama mmap+offload often manages). */
  fits: boolean;
  /** Rough GB needed: model blob + ~25% headroom for KV cache/activations. */
  estFootprintGB: number;
  hasTools: boolean;
  reason: string;
}

/** "11.9B" -> 11.9, "350M" -> 0.35. Returns 0 when unparseable. */
export function paramBillions(parameterSize?: string): number {
  const m = parameterSize?.match(/([\d.]+)\s*([BM])/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2].toUpperCase() === "B" ? n : n / 1000;
}

/**
 * Rank installed models for use as the server's default.
 * budgetBytes = usable memory (target GPU's free VRAM, or free RAM fallback).
 * Order: tool-capable models that fit, biggest params first; then fittable
 * non-tool models; non-fitting models last (marked, not excluded — CPU offload
 * is slow but works).
 */
export function rankModels(models: ModelInfo[], budgetBytes: number): RankedModel[] {
  const ranked = models.map((m) => {
    const size = m.sizeBytes ?? 0;
    const est = size * 1.25;
    const fit: RankedModel["fit"] =
      budgetBytes <= 0 || est <= budgetBytes ? "yes" : size <= budgetBytes ? "marginal" : "no";
    const fits = fit !== "no";
    const hasTools = (m.capabilities ?? []).includes("tools");
    const gb = Math.round((est / 1e9) * 10) / 10;
    const reason = [
      hasTools ? "tool-calling" : "no tool-calling",
      fit === "yes"
        ? `~${gb}GB fits budget`
        : fit === "marginal"
          ? `~${gb}GB marginal — blob fits, headroom tight`
          : `~${gb}GB exceeds budget`,
      m.parameterSize ? `${m.parameterSize} params` : "size unknown",
    ].join("; ");
    return { ...m, fit, fits, estFootprintGB: gb, hasTools, reason };
  });
  const fitRank = { yes: 0, marginal: 1, no: 2 } as const;
  ranked.sort((a, b) => {
    if (fitRank[a.fit] !== fitRank[b.fit]) return fitRank[a.fit] - fitRank[b.fit];
    if (a.hasTools !== b.hasTools) return a.hasTools ? -1 : 1;
    return paramBillions(b.parameterSize) - paramBillions(a.parameterSize);
  });
  return ranked;
}

export interface PruneCandidate {
  id: string;
  sizeBytes?: number;
  modifiedAt?: string;
  reason: string;
}

export interface PrunePlan {
  candidates: PruneCandidate[];
  kept: { id: string; reason: string }[];
  wouldFreeBytes: number;
}

/**
 * Which installed models are safe to delete. Always kept: the keep[] list,
 * the provider's default model, anything currently loaded in VRAM, and the
 * `keepRecent` most recently modified others.
 * `maxAgeDays` additionally spares models modified within N days (pull date);
 * `unusedDays` spares models with a recorded inference within N days — models
 * with NO usage record are treated as used (unknown ≠ unused, the ledger only
 * exists since the feature shipped).
 */
export function pruneCandidates(
  models: ModelInfo[],
  opts: {
    keep?: string[];
    keepRecent?: number;
    maxAgeDays?: number;
    unusedDays?: number;
    lastUsed?: Record<string, string>;
    defaultModel?: string;
    loaded?: string[];
  },
): PrunePlan {
  const keep = new Set(opts.keep ?? []);
  const loaded = new Set(opts.loaded ?? []);
  const def = opts.defaultModel;
  const keepRecent = opts.keepRecent ?? 0;
  const lastUsed = opts.lastUsed ?? {};

  const kept: { id: string; reason: string }[] = [];
  const rest: ModelInfo[] = [];
  for (const m of models) {
    if (keep.has(m.id)) kept.push({ id: m.id, reason: "in keep list" });
    else if (m.id === def) kept.push({ id: m.id, reason: "provider default" });
    else if (loaded.has(m.id)) kept.push({ id: m.id, reason: "loaded in VRAM" });
    else rest.push(m);
  }

  // keepRecent: preserve the N most recently modified of the remainder.
  const byAge = [...rest].sort((a, b) =>
    (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""),
  );
  const spared = new Set(byAge.slice(0, keepRecent).map((m) => m.id));
  for (const m of byAge.slice(0, keepRecent)) {
    kept.push({ id: m.id, reason: `among ${keepRecent} most recent` });
  }

  // Age-based spares.
  const ageCutoff = opts.maxAgeDays !== undefined ? Date.now() - opts.maxAgeDays * 86400_000 : undefined;
  const useCutoff = opts.unusedDays !== undefined ? Date.now() - opts.unusedDays * 86400_000 : undefined;
  for (const m of rest) {
    if (spared.has(m.id)) continue;
    const modMs = m.modifiedAt ? Date.parse(m.modifiedAt) : NaN;
    if (ageCutoff !== undefined && (!Number.isFinite(modMs) || modMs >= ageCutoff)) {
      spared.add(m.id);
      kept.push({ id: m.id, reason: `modified within ${opts.maxAgeDays}d` });
      continue;
    }
    if (useCutoff !== undefined) {
      const lu = lastUsed[m.id];
      const luMs = lu ? Date.parse(lu) : NaN;
      if (!lu || !Number.isFinite(luMs)) {
        spared.add(m.id);
        kept.push({ id: m.id, reason: "no recorded usage — treating as used (ledger is recent)" });
      } else if (luMs >= useCutoff) {
        spared.add(m.id);
        kept.push({ id: m.id, reason: `used within ${opts.unusedDays}d` });
      }
    }
  }

  const candidates: PruneCandidate[] = byAge
    .filter((m) => !spared.has(m.id))
    .map((m) => ({ id: m.id, sizeBytes: m.sizeBytes, modifiedAt: m.modifiedAt, reason: "not default, not loaded, not kept" }));

  return {
    candidates,
    kept,
    wouldFreeBytes: candidates.reduce((s, c) => s + (c.sizeBytes ?? 0), 0),
  };
}
