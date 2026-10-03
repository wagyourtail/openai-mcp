// Ollama public registry: model search (ollama.com HTML) + tag listing +
// per-tag download size via the Docker-v2 manifest API. Pure parsers are
// exported for testing; fetch functions take an injectable fetcher.

export interface RegistrySearchHit {
  name: string;
  description: string;
  capabilities: string[]; // "tools", "thinking", "vision", ...
  sizes: string[]; // "7b", "30b", ... (parameter-size chips)
  pulls: string; // "45.6M" as displayed, or ""
  updated: string; // "3 weeks ago"-style or ""
}

export interface RegistryTag {
  tag: string; // "e4b" (part after ':')
  fullName: string; // "gemma4:e4b"
  sizeBytes?: number; // summed manifest layers, only when requested
}

export type Fetcher = (url: string, headers?: Record<string, string>) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 15_000;

export const defaultFetcher: Fetcher = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { "user-agent": "openai-mcp", ...headers },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
};

const htmlUnescape = (s: string): string =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");

const stripTags = (s: string): string => htmlUnescape(s.replace(/<[^>]+>/g, "").trim());

// ollama.com/search?q=X[&c=tools] — each hit is an <li> containing
// <a href="/library/<name> ... <h2><span>name</span></h2> <p ...text-neutral-800...>desc</p>
// chips: bg-indigo-50 = capability, bg-[#ddf4ff] = size; pulls/updated at the tail.
export function parseSearchHtml(html: string, limit = 12): RegistrySearchHit[] {
  const hits: RegistrySearchHit[] = [];
  const blocks = html.split(/<li[^>]*border-b[^>]*>/).slice(1);
  for (const block of blocks) {
    const name = block.match(/href="\/library\/([a-z0-9._-]+)"/i)?.[1];
    if (!name || hits.some((h) => h.name === name)) continue;
    const description = stripTags(block.match(/<p[^>]*text-neutral-800[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
    const capabilities = [...block.matchAll(/bg-indigo-50[^>]*>([^<]+)<\/span>/g)].map((m) =>
      stripTags(m[1]),
    );
    const sizes = [...block.matchAll(/bg-\[#ddf4ff\][^>]*>([^<]+)<\/span>/g)].map((m) =>
      stripTags(m[1]).toLowerCase(),
    );
    // pulls: e.g. "45.6M", "1.2K" rendered near a download icon; fall back to ""
    const pulls =
      block.match(/<span[^>]*x-text[^>]*pulls[^<]*<\/span>/i)?.[0]?.replace(/<[^>]+>/g, "").trim() ||
      block.match(/([0-9][0-9.,]*[KMG]?)\s*(?:pulls|Pulls)/)?.[1] ||
      "";
    const updated = stripTags(block.match(/Updated\s*([^<]+?)</)?.[1] ?? "") ||
      block.match(/title="([A-Z][a-z]+ \d+, \d{4}[^"]*)"/)?.[1] ||
      "";
    hits.push({ name, description, capabilities, sizes, pulls, updated });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function searchRegistry(
  query: string,
  opts: { category?: string; limit?: number; fetcher?: Fetcher } = {},
): Promise<RegistrySearchHit[]> {
  const f = opts.fetcher ?? defaultFetcher;
  const url =
    `https://ollama.com/search?q=${encodeURIComponent(query)}` +
    (opts.category ? `&c=${encodeURIComponent(opts.category)}` : "");
  return parseSearchHtml(await f(url), opts.limit ?? 12);
}

// ollama.com/library/<name>/tags — tags appear as "name:tag" link text.
export function parseTagsHtml(html: string, model: string): RegistryTag[] {
  const seen = new Set<string>();
  const out: RegistryTag[] = [];
  const re = new RegExp(`>${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:([a-z0-9._-]+)<`, "gi");
  for (const m of html.matchAll(re)) {
    const tag = m[1];
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, fullName: `${model}:${tag}` });
  }
  return out;
}

// registry.ollama.ai/v2/library/<model>/manifests/<tag> — download size is
// the sum of layer sizes (config excluded, it's a few KB).
export function manifestSizeBytes(manifestJson: string): number {
  try {
    const m = JSON.parse(manifestJson) as { layers?: { size?: number }[] };
    return (m.layers ?? []).reduce((s, l) => s + (l.size ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function registryManifestSize(
  model: string,
  tag: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<number> {
  const body = await fetcher(`https://registry.ollama.ai/v2/library/${model}/manifests/${tag}`, {
    Accept:
      "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json",
  });
  // OCI indexes (multi-variant) wrap manifests; sum nested if so.
  const idx = JSON.parse(body) as { manifests?: { size?: number }[]; layers?: unknown };
  if (idx.manifests && !idx.layers) {
    return idx.manifests.reduce((s, m) => s + (m.size ?? 0), 0);
  }
  return manifestSizeBytes(body);
}

export async function listRegistryTags(
  model: string,
  opts: { includeSizes?: boolean; limit?: number; fetcher?: Fetcher } = {},
): Promise<RegistryTag[]> {
  const f = opts.fetcher ?? defaultFetcher;
  let tags = parseTagsHtml(await f(`https://ollama.com/library/${model}/tags`), model);
  if (opts.limit) tags = tags.slice(0, opts.limit);
  if (opts.includeSizes && tags.length) {
    const sized = await Promise.all(
      tags.map(async (t) => {
        try {
          return { ...t, sizeBytes: (await registryManifestSize(model, t.tag, f)) || undefined };
        } catch {
          return t;
        }
      }),
    );
    return sized;
  }
  return tags;
}
