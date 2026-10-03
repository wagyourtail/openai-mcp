import { realpathSync, existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep, isAbsolute, dirname } from "node:path";

/** Convert a simple glob (`**`, `*`, `?`) to a RegExp. No braces/extglob. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of leading segments (or none)
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(path));
}

export type RootSource = "config" | "mcp-roots" | "cwd";

/**
 * Filesystem guard. Every path used by file tools flows through resolve().
 * Roots come from three sources, all unioned:
 *   - "config": explicit allowed_roots in the server config file
 *   - "mcp-roots": workspace roots advertised by the MCP client (roots capability)
 *   - "cwd": the directory the server was spawned from (the project dir)
 * deny_globs always win even inside a root.
 */
export class FsGuard {
  private roots = new Map<string, RootSource>();
  private denyRe: RegExp[];
  private maxReadBytes: number;

  constructor(roots: string[], denyGlobs: string[], maxReadBytes: number) {
    this.maxReadBytes = maxReadBytes;
    this.denyRe = denyGlobs.map(globToRegExp);
    for (const r of roots) this.addRoot(r, "config");
  }

  /** Add a root. Missing/unresolvable paths are kept as-resolved (may become valid later). */
  addRoot(path: string, source: RootSource): void {
    const abs = resolve(expandHome(path));
    let real = abs;
    try {
      if (existsSync(abs)) real = realpathSync(abs);
    } catch {
      /* keep unresolved */
    }
    this.roots.set(real, source);
  }

  /** Replace all roots from one source (e.g. when the client sends roots/list_changed). */
  setRootsForSource(source: RootSource, paths: string[]): void {
    for (const [p, s] of this.roots) if (s === source) this.roots.delete(p);
    for (const p of paths) this.addRoot(p, source);
  }

  get configured(): boolean {
    return this.roots.size > 0;
  }

  get rootList(): string[] {
    return [...this.roots.keys()];
  }

  get rootDetails(): { path: string; source: RootSource }[] {
    return [...this.roots.entries()].map(([path, source]) => ({ path, source }));
  }

  /** Resolve `input` to an absolute path that is inside an allowed root and not deny-globbed. */
  resolve(input: string, opts: { mustExist?: boolean } = {}): string {
    if (!this.configured) {
      throw new Error(
        "filesystem access is disabled: no roots available (no `allowed_roots` in config, " +
          "no MCP client roots advertised, and cwd trust is off). Add absolute directories to " +
          "`allowed_roots` in " +
          (process.env.LOCAL_LLM_CONFIG ?? "~/.config/openai-mcp/config.json"),
      );
    }
    const abs = resolve(expandHome(input));
    let real = abs;
    if (existsSync(abs)) {
      real = realpathSync(abs);
    } else if (opts.mustExist) {
      throw new Error(`path does not exist: ${input}`);
    } else {
      // For writes to new files, anchor on the deepest existing ancestor.
      let dir = dirname(abs);
      while (!existsSync(dir)) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`no existing ancestor for: ${input}`);
        dir = parent;
      }
      real = realpathSync(dir) + abs.slice(dir.length);
    }
    const inside = [...this.roots.keys()].some((r) => real === r || real.startsWith(r + sep));
    if (!inside) {
      throw new Error(
        `path outside allowed_roots: ${input} (resolves to ${real}; roots: ${this.rootList.join(", ")})`,
      );
    }
    if (matchesAny(real, this.denyRe)) {
      throw new Error(`path matches a deny_globs pattern: ${input}`);
    }
    return real;
  }

  async readFile(input: string): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
    const p = this.resolve(input, { mustExist: true });
    const st = await stat(p);
    if (!st.isFile()) throw new Error(`not a regular file: ${input}`);
    const truncated = st.size > this.maxReadBytes;
    const fh = await readFile(p);
    const head = fh.subarray(0, Math.min(fh.length, 8192));
    if (looksBinary(head)) {
      throw new Error(`refusing to read binary file as text: ${input} (${st.size} bytes)`);
    }
    const content = truncated ? fh.subarray(0, this.maxReadBytes).toString("utf-8") : fh.toString("utf-8");
    return { path: p, content, bytes: st.size, truncated };
  }

  async listDir(input: string): Promise<{ path: string; entries: { name: string; type: string }[] }> {
    const p = this.resolve(input, { mustExist: true });
    const entries = await readdir(p, { withFileTypes: true });
    return {
      path: p,
      entries: entries
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Expand `**`-aware glob over the allowed roots. Returns absolute paths. */
  async glob(pattern: string, maxMatches: number): Promise<string[]> {
    if (!this.configured) {
      throw new Error(
        "filesystem access is disabled: no roots available (config/MCP-roots/cwd all empty).",
      );
    }
    const re = globToRegExp(expandHome(pattern));
    const out: string[] = [];
    for (const root of this.roots.keys()) {
      if (out.length >= maxMatches) break;
      await walk(root, re, out, maxMatches);
    }
    const filtered = out.filter((p) => !matchesAny(p, this.denyRe));
    return filtered.slice(0, maxMatches);
  }
}

async function walk(dir: string, re: RegExp, out: string[], max: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    const full = dir + sep + e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walk(full, re, out, max);
    } else if (e.isFile() && re.test(full)) {
      out.push(full);
    }
  }
}

/** Cheap binary sniff: NUL byte or >30% non-printable bytes in the first chunk. */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let weird = 0;
  for (const b of buf) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) weird++;
  }
  return weird / buf.length > 0.3;
}

export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1);
  return p;
}

export function fileSizeOk(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
