import type { ModelInfo } from "../providers/index.ts";

export interface RankedModel extends ModelInfo {
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
    const est = (m.sizeBytes ?? 0) * 1.25;
    const fits = budgetBytes <= 0 ? true : est <= budgetBytes;
    const hasTools = (m.capabilities ?? []).includes("tools");
    const gb = Math.round((est / 1e9) * 10) / 10;
    const reason = [
      hasTools ? "tool-calling" : "no tool-calling",
      fits ? `~${gb}GB fits budget` : `~${gb}GB exceeds budget`,
      m.parameterSize ? `${m.parameterSize} params` : "size unknown",
    ].join("; ");
    return { ...m, fits, estFootprintGB: gb, hasTools, reason };
  });
  ranked.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
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
 */
export function pruneCandidates(
  models: ModelInfo[],
  opts: {
    keep?: string[];
    keepRecent?: number;
    defaultModel?: string;
    loaded?: string[];
  },
): PrunePlan {
  const keep = new Set(opts.keep ?? []);
  const loaded = new Set(opts.loaded ?? []);
  const def = opts.defaultModel;
  const keepRecent = opts.keepRecent ?? 0;

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

  const candidates: PruneCandidate[] = byAge
    .filter((m) => !spared.has(m.id))
    .map((m) => ({ id: m.id, sizeBytes: m.sizeBytes, modifiedAt: m.modifiedAt, reason: "not default, not loaded, not kept" }));

  return {
    candidates,
    kept,
    wouldFreeBytes: candidates.reduce((s, c) => s + (c.sizeBytes ?? 0), 0),
  };
}
