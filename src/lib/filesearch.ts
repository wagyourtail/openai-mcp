// Content search with a pure-Node fallback when ripgrep isn't installed.
// The fallback approximates rg's defaults: skips hidden entries + .gitignore'd
// paths (patterns read from every .gitignore found during the walk), skips
// binaries and huge files, and emits path:line:content matches.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const execFileP = promisify(execFile);

let rgOk: boolean | undefined;
async function haveRg(): Promise<boolean> {
  if (rgOk === undefined) {
    try {
      await execFileP("rg", ["--version"], { timeout: 3000 });
      rgOk = true;
    } catch {
      rgOk = false;
    }
  }
  return rgOk;
}

/** "rg" when available, "builtin" for the Node fallback. For server_info. */
export async function searchBackend(): Promise<"rg" | "builtin"> {
  return (await haveRg()) ? "rg" : "builtin";
}

/** Glob ("*.ts", "star-star/foo/*.json" style, "src/**") → RegExp over relative paths. */
export function globRe(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:[^/]+/)*"; // **/ = zero or more dirs
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
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

interface IgnoreRule {
  /** Dir the .gitignore lives in, relative to search root ("" = root). */
  base: string;
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/** One .gitignore file's patterns. */
export function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split("\n")) {
    line = line.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const hasSlash = line.includes("/");
    let re: RegExp;
    if (anchored || hasSlash) {
      re = globRe(line); // match against path relative to rule's base
    } else {
      // Bare name: matches basename at any depth under the base dir.
      re = new RegExp(`(?:^|/)${globRe(line).source.slice(1, -1)}$`);
    }
    rules.push({ base, re, negated, dirOnly });
  }
  return rules;
}

/** rel is posix-style path relative to search root. Last matching rule wins. */
function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let result = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && rel !== r.base && !rel.startsWith(`${r.base}/`)) continue;
    const sub = r.base ? rel.slice(r.base.length + 1) : rel;
    if (!sub) continue;
    if (r.re.test(sub)) result = !r.negated;
  }
  return result;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MATCHES = 2000;

async function isBinary(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Pure-Node rg approximation. Returns rg-shaped "path:line:text" output. */
export async function fallbackSearch(opts: {
  pattern: string;
  target: string;
  glob?: string;
}): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern);
  } catch (e) {
    return `error: invalid regex: ${e instanceof Error ? e.message : e}`;
  }
  const include = opts.glob ? globRe(opts.glob) : undefined;
  const root = resolve(opts.target);
  const rules: IgnoreRule[] = [];
  const out: string[] = [];
  let truncated = false;
  let outBytes = 0;

  const searchFile = async (abs: string, rel: string): Promise<void> => {
    if (include && !include.test(rel)) return;
    let st;
    try {
      st = await stat(abs);
    } catch {
      return;
    }
    if (st.size > MAX_FILE_BYTES || (await isBinary(abs))) return;
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const line = `${abs}:${i + 1}:${lines[i]}`;
      outBytes += line.length + 1;
      if (outBytes > MAX_OUTPUT_BYTES || out.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
      out.push(line);
    }
  };

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (truncated || depth > 50) return;
    try {
      rules.push(...parseGitignore(await readFile(join(dir, ".gitignore"), "utf-8"), rel));
    } catch {
      /* no .gitignore here */
    }
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (truncated) return;
      if (e.name.startsWith(".") && e.name !== ".") continue; // rg skips hidden
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (e.isSymbolicLink()) continue; // rg doesn't follow links by default
      if (ignored(rules, r, isDir)) continue;
      if (isDir) await walk(abs, r, depth + 1);
      else if (e.isFile()) await searchFile(abs, r);
    }
  };

  const st = await stat(root).catch(() => undefined);
  if (!st) return "error: path not found";
  if (st.isFile()) await searchFile(root, root.split(sep).pop() ?? root);
  else await walk(root, "", 0);
  if (!out.length) return "(no matches)";
  return out.join("\n") + (truncated ? "\n[truncated — too many matches]" : "");
}

/** rg when present, Node fallback otherwise. Same output shape either way. */
export async function searchFiles(opts: {
  pattern: string;
  target: string;
  glob?: string;
}): Promise<string> {
  if (await haveRg()) {
    const argv = ["--line-number", "--no-heading", "--color=never", "-e", opts.pattern];
    if (opts.glob) argv.push("-g", opts.glob);
    argv.push(opts.target);
    try {
      const { stdout } = await execFileP("rg", argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
      return stdout || "(no matches)";
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      if (err.code === 1) return "(no matches)";
      return `error: ${err.stderr || "search failed"}`;
    }
  }
  return fallbackSearch(opts);
}
