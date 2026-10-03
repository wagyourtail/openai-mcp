import { test } from "node:test";
import assert from "node:assert/strict";
import { paramBillions, pruneCandidates, rankModels } from "../src/lib/modelpick.ts";
import { parseNvtop } from "../src/lib/sysinfo.ts";
import type { ModelInfo } from "../src/providers/types.ts";

const GB = 1e9;

const models: ModelInfo[] = [
  { id: "big:14b", sizeBytes: 9 * GB, parameterSize: "14.8B", capabilities: ["completion", "tools"], modifiedAt: "2026-09-01" },
  { id: "coder:7b", sizeBytes: 4.7 * GB, parameterSize: "7.6B", capabilities: ["completion", "tools"], modifiedAt: "2026-10-01" },
  { id: "notools:9b", sizeBytes: 5 * GB, parameterSize: "9B", capabilities: ["completion"], modifiedAt: "2026-09-15" },
];

test("paramBillions parses B and M suffixes", () => {
  assert.equal(paramBillions("14.8B"), 14.8);
  assert.equal(paramBillions("350M"), 0.35);
  assert.equal(paramBillions(undefined), 0);
  assert.equal(paramBillions("weird"), 0);
});

test("rankModels prefers fitting tool-capable models, biggest first", () => {
  const ranked = rankModels(models, 7 * GB); // fits coder(5.9) + notools(6.25), not big(11.25)
  assert.equal(ranked[0].id, "coder:7b");
  assert.equal(ranked[1].id, "notools:9b"); // fits but no tools
  assert.equal(ranked[2].id, "big:14b"); // doesn't fit
  assert.equal(ranked[0].fits, true);
  assert.equal(ranked[2].fits, false);
});

test("rankModels with zero budget ranks everything as fitting", () => {
  const ranked = rankModels(models, 0);
  assert.equal(ranked[0].id, "big:14b"); // biggest tool-capable wins
});

test("pruneCandidates keeps default, loaded, keep list, and keep_recent", () => {
  const plan = pruneCandidates(models, {
    defaultModel: "coder:7b",
    loaded: ["big:14b"],
    keep: [],
    keepRecent: 0,
  });
  assert.deepEqual(plan.candidates.map((c) => c.id), ["notools:9b"]);
  assert.equal(plan.kept.find((k) => k.id === "coder:7b")?.reason, "provider default");
  assert.equal(plan.kept.find((k) => k.id === "big:14b")?.reason, "loaded in VRAM");
  assert.equal(plan.wouldFreeBytes, 5 * GB);
});

test("pruneCandidates keep_recent spares newest of the remainder", () => {
  const plan = pruneCandidates(models, { keepRecent: 1 });
  // coder:7b (2026-10-01) is newest → spared; the other two are candidates.
  assert.deepEqual(plan.candidates.map((c) => c.id), ["notools:9b", "big:14b"]);
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.kept[0].id, "coder:7b");
});

test("parseNvtop extracts devices, memory, and processes", () => {
  const gpus = parseNvtop(
    JSON.stringify([
      {
        device_name: "Intel Arc A380",
        mem_total: "6000000000",
        mem_used: "1000000000",
        mem_free: "5000000000",
        processes: [{ pid: "42", cmdline: "/usr/lib/ollama/llama-server", gpu_mem_bytes_alloc: "2000000000" }],
      },
      { device_name: "Tesla P100", mem_total: "17000000000", mem_used: "0", mem_free: "17000000000", processes: [] },
    ]),
  );
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].vendor, "intel");
  assert.equal(gpus[1].vendor, "nvidia");
  assert.equal(gpus[0].processes?.[0].pid, 42);
  assert.equal(gpus[1].freeMB, Math.round(17000000000 / 1024 / 1024));
});
