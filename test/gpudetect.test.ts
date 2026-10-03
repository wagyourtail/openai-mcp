import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignCards,
  normPci,
  parseEnvFile,
  parseOllamaJournal,
  parseSizeMB,
  parseSystemdShow,
  resolvePinnedSlots,
  type DrmCard,
  type GpuInfo,
  type InferenceDevice,
} from "../src/lib/sysinfo.ts";

// Host ground truth (from the P100/A380 bug report):
// lspci: 00:02.0=HD630 iGPU, 01:00.0=P100, 04:00.0=A380
// drm:   card0->04:00.0 (A380), card1->00:02.0 (HD630), card2->01:00.0 (P100)
// nvtop order: 0=P100, 1=A380, 2=HD630  (nvtop order != DRM cardN order)
const cards: DrmCard[] = [
  { cardN: 0, pciSlot: "0000:04:00.0", driver: "i915", name: "Intel Corporation DG2 [Arc A380]" },
  { cardN: 1, pciSlot: "0000:00:02.0", driver: "i915", name: "Intel Corporation HD Graphics 630" },
  { cardN: 2, pciSlot: "0000:01:00.0", driver: "nvidia", name: "NVIDIA Corporation GP100GL [Tesla P100 PCIe 16GB]" },
];

test("assignCards binds GPUs to cards by name match, not enumeration order", () => {
  const gpus: GpuInfo[] = [
    { index: 0, name: "Tesla P100", vendor: "nvidia", freeMB: 500 },
    { index: 1, name: "Intel(R) Arc(tm) A380 Graphics (DG2)", vendor: "intel", freeMB: 4900 },
    { index: 2, name: "Intel HD Graphics 630", vendor: "intel", integrated: true },
  ];
  assignCards(gpus, cards);
  assert.equal(gpus[0].pciSlot, "0000:01:00.0"); // P100
  assert.equal(gpus[0].cardN, 2);
  assert.equal(gpus[0].driver, "nvidia");
  assert.equal(gpus[1].pciSlot, "0000:04:00.0"); // A380 — NOT card index 1's pci!
  assert.equal(gpus[1].cardN, 0);
  assert.equal(gpus[1].driver, "i915");
  assert.equal(gpus[2].pciSlot, "0000:00:02.0"); // HD630
  assert.equal(gpus[2].cardN, 1);
});

test("assignCards prefers an exact pciSlot match over name matching", () => {
  const gpus: GpuInfo[] = [
    { index: 0, name: "Some Weird Rename", pciSlot: "00000000:01:00.0", vendor: "nvidia" },
  ];
  assignCards(gpus, cards);
  assert.equal(gpus[0].cardN, 2);
  assert.equal(gpus[0].pciSlot, "0000:01:00.0");
});

test("normPci normalizes domain-prefixed and short bus ids", () => {
  assert.equal(normPci("0000:04:00.0"), "04:00.0");
  assert.equal(normPci("00000000:04:00.0"), "04:00.0");
  assert.equal(normPci("04:00.0"), "04:00.0");
  assert.equal(normPci(undefined), "");
});

test("parseSizeMB handles GiB/MiB/GB/MB", () => {
  assert.equal(parseSizeMB("5.9", "GiB"), 6042);
  assert.equal(parseSizeMB("4.9", "GiB"), 5018);
  assert.equal(parseSizeMB("512", "MiB"), 512);
  assert.equal(parseSizeMB("16", "GB"), 16000);
});

test("parseOllamaJournal extracts env map and inference devices", () => {
  const log = [
    `time=2026-10-03T12:00:00 level=INFO source=server.go msg="server config env=map[GGML_VK_VISIBLE_DEVICES:2 OLLAMA_VULKAN:true OLLAMA_HOST:0.0.0.0:11434 PATH:/usr/bin]"`,
    `level=INFO msg="inference compute" id=0 library=vulkan name=Vulkan0 description="Intel(R) Arc(tm) A380 Graphics (DG2)" pci_id=0000:04:00.0 total="5.9 GiB" available="4.9 GiB"`,
    `level=INFO msg="inference compute" id=1 library=vulkan name=Vulkan1 description="Intel(R) HD Graphics 630" pci_id=0000:00:02.0 total="8.0 GiB" available="7.0 GiB"`,
    `level=INFO msg="unrelated line"`,
  ].join("\n");
  const { env, devices } = parseOllamaJournal(log);
  assert.equal(env.GGML_VK_VISIBLE_DEVICES, "2");
  assert.equal(env.OLLAMA_VULKAN, "true");
  assert.equal(env.PATH, "/usr/bin"); // split at first colon only
  assert.equal(devices.length, 2);
  assert.equal(devices[0].family, "vulkan");
  assert.equal(devices[0].index, 0);
  assert.equal(devices[0].name, "Intel(R) Arc(tm) A380 Graphics (DG2)");
  assert.equal(devices[0].pci, "0000:04:00.0");
  assert.equal(devices[0].availMB, 5018);
});

test("parseSystemdShow extracts Environment and EnvironmentFiles", () => {
  const { env, envFiles } = parseSystemdShow(
    "Environment=OLLAMA_HOST=0.0.0.0:11434 OLLAMA_VULKAN=true\nEnvironmentFiles=/etc/ollama.conf (ignore_errors=no)\n",
  );
  assert.equal(env.OLLAMA_VULKAN, "true");
  assert.deepEqual(envFiles, ["/etc/ollama.conf"]);
});

test("parseEnvFile handles comments, quotes, and equals-in-value", () => {
  const env = parseEnvFile(
    "# comment\nGGML_VK_VISIBLE_DEVICES=2\nQUOTED=\"a b c\"\nSINGLE='x'\nWITH_EQUALS=k=v=w\n",
  );
  assert.equal(env.GGML_VK_VISIBLE_DEVICES, "2");
  assert.equal(env.QUOTED, "a b c");
  assert.equal(env.SINGLE, "x");
  assert.equal(env.WITH_EQUALS, "k=v=w"); // split at first '=' only
});

test("parseOllamaJournal prefers filter_id over name/id ordinals", () => {
  // Under GGML_VK_VISIBLE_DEVICES=2 the survivor logs id=0 name=Vulkan0 but
  // filter_id=2 — the pre-filter ordinal the env var actually indexes.
  const log = `env=map[GGML_VK_VISIBLE_DEVICES:2 OLLAMA_VULKAN:true]
level=INFO msg="inference compute" id=0 library=vulkan filter_id=2 name=Vulkan0 description="Intel(R) Arc(tm) A380 Graphics (DG2)" pci_id=0000:04:00.0 total="5.9 GiB" available="4.9 GiB"`;
  const { devices } = parseOllamaJournal(log);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].index, 2); // filter_id, not name suffix or id
  assert.equal(devices[0].id, 0);
});

test("parseOllamaJournal scopes devices/env to the last boot", () => {
  const log = [
    // boot 1: unpinned, all three devices discovered
    `env=map[OLLAMA_VULKAN:true OLLAMA_HOST:0.0.0.0:11434]`,
    `inference compute id=0 library=vulkan filter_id=0 name=Vulkan0 description="HD 630" pci_id=0000:00:02.0 total="8.0 GiB" available="7.0 GiB"`,
    `inference compute id=1 library=vulkan filter_id=1 name=Vulkan1 description="Tesla P100" pci_id=0000:01:00.0 total="16.0 GiB" available="15.0 GiB"`,
    `inference compute id=2 library=vulkan filter_id=2 name=Vulkan2 description="Arc A380" pci_id=0000:04:00.0 total="5.9 GiB" available="4.9 GiB"`,
    // boot 2: pinned to A380 — new env map + only the survivor
    `env=map[GGML_VK_VISIBLE_DEVICES:2 OLLAMA_VULKAN:true]`,
    `inference compute id=0 library=vulkan filter_id=2 name=Vulkan0 description="Arc A380" pci_id=0000:04:00.0 total="5.9 GiB" available="4.9 GiB"`,
  ].join("\n");
  const { env, devices } = parseOllamaJournal(log);
  assert.equal(env.GGML_VK_VISIBLE_DEVICES, "2"); // last boot's map wins
  assert.equal(env.OLLAMA_HOST, undefined); // stale-boot key dropped
  assert.equal(devices.length, 1);
  assert.equal(devices[0].pci, "0000:04:00.0");
});

test("filter_id lets pinned env resolve to the survivor's pci", () => {
  const log = `env=map[GGML_VK_VISIBLE_DEVICES:2]
inference compute id=0 library=vulkan filter_id=2 name=Vulkan0 description="Arc A380" pci_id=0000:04:00.0 total="5.9 GiB" available="4.9 GiB"`;
  const { env, devices } = parseOllamaJournal(log);
  const r = resolvePinnedSlots(env, devices, []);
  assert.deepEqual(r.slots, ["04:00.0"]);
});

test("resolvePinnedSlots maps GGML_VK index through journal vulkan devices", () => {
  const devices: InferenceDevice[] = [
    { index: 0, family: "vulkan", name: "HD 630", pci: "0000:00:02.0", totalMB: 0, availMB: 0 },
    { index: 1, family: "vulkan", name: "Tesla P100", pci: "0000:01:00.0", totalMB: 0, availMB: 0 },
    { index: 2, family: "vulkan", name: "Arc A380", pci: "0000:04:00.0", totalMB: 6042, availMB: 5018 },
  ];
  const r = resolvePinnedSlots({ GGML_VK_VISIBLE_DEVICES: "2" }, devices, []);
  assert.deepEqual(r.indices, [2]);
  assert.deepEqual(r.slots, ["04:00.0"]);
});

test("resolvePinnedSlots falls back to vendor-sorted gpu list", () => {
  const gpus: GpuInfo[] = [
    { index: 0, vendor: "nvidia", pciSlot: "0000:01:00.0" },
    { index: 1, vendor: "intel", pciSlot: "0000:04:00.0" },
  ];
  const r = resolvePinnedSlots({ CUDA_VISIBLE_DEVICES: "0" }, [], gpus);
  assert.deepEqual(r.slots, ["01:00.0"]);
});
