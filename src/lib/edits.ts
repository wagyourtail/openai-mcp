// Search/replace patch application — lets small models emit only changed hunks
// instead of regurgitating whole files. Format is the Aider-style block:
//
//   <<<<<<< SEARCH
//   exact lines from the file
//   =======
//   replacement lines
//   >>>>>>> REPLACE
//
// An empty SEARCH section appends the replacement at EOF.

export interface EditBlock {
  search: string;
  replace: string;
}

/** Parse SEARCH/REPLACE blocks, tolerating stray whitespace. */
export function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!/^<{7}\s*SEARCH\s*$/.test(lines[i])) {
      i++;
      continue;
    }
    i++;
    const searchLines: string[] = [];
    while (i < lines.length && !/^={7}\s*$/.test(lines[i])) searchLines.push(lines[i++]);
    if (i >= lines.length) break; // unterminated SEARCH — drop it
    i++; // skip =======
    const replaceLines: string[] = [];
    while (i < lines.length && !/^>{7}\s*REPLACE\s*$/.test(lines[i])) replaceLines.push(lines[i++]);
    if (i >= lines.length) break; // unterminated REPLACE — drop it
    i++; // skip >>>>>>>
    blocks.push({ search: searchLines.join("\n"), replace: replaceLines.join("\n") });
  }
  return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + 1);
  }
  return n;
}

/** Per-line rstrip — small models mangle trailing whitespace reliably enough to matter. */
const rstripLines = (s: string): string => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");

export interface ApplyResult {
  ok: true;
  content: string;
  applied: number;
  fuzzy: number[]; // block indexes that only matched whitespace-insensitively
}

export type ApplyOutcome =
  | ApplyResult
  | { ok: false; block: number; reason: string };

/**
 * Apply blocks in order. Empty search = append at EOF. On failure reports the
 * 1-based block index so the caller can feed it back to the model to retry.
 */
export function applyEdits(content: string, blocks: EditBlock[]): ApplyOutcome {
  let out = content;
  const fuzzy: number[] = [];
  for (const [i, b] of blocks.entries()) {
    if (b.search === "") {
      out += (out.endsWith("\n") || out === "" ? "" : "\n") + b.replace;
      continue;
    }
    let search = b.search;
    const n = countOccurrences(out, search);
    if (n === 1) {
      out = out.replace(search, () => b.replace);
      continue;
    }
    if (n > 1) {
      return { ok: false, block: i + 1, reason: `search text occurs ${n} times — include more context lines` };
    }
    // Fuzzy pass: match on whitespace-normalized lines.
    const normOut = rstripLines(out);
    const normSearch = rstripLines(search);
    const fn = countOccurrences(normOut, normSearch);
    if (fn === 1) {
      // Locate the fuzzy match position in the ORIGINAL text line-by-line.
      const outLines = out.split("\n");
      const sLines = normSearch.split("\n");
      outer: for (let s = 0; s + sLines.length <= outLines.length; s++) {
        for (let k = 0; k < sLines.length; k++) {
          if (outLines[s + k].replace(/\s+$/, "") !== sLines[k]) continue outer;
        }
        out = [...outLines.slice(0, s), ...b.replace.split("\n"), ...outLines.slice(s + sLines.length)].join("\n");
        fuzzy.push(i + 1);
        break;
      }
      continue;
    }
    return {
      ok: false,
      block: i + 1,
      reason: `search text not found (even whitespace-insensitively) — check indentation and that the lines are verbatim from the file`,
    };
  }
  return { ok: true, content: out, applied: blocks.length, fuzzy };
}
