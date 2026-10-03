import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listRegistryTags,
  manifestSizeBytes,
  parseSearchHtml,
  parseTagsHtml,
} from "../src/lib/registry.ts";

// Fixture shaped like the real ollama.com/search result block.
const SEARCH_HTML = `
<ul>
<li  class="flex items-baseline border-b border-neutral-200 py-8">
  <a href="/library/qwen3-coder" class="group w-full">
    <div class="flex flex-col mb-2" title="qwen3-coder">
      <h2 class="truncate text-xl font-medium"><span >qwen3-coder</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Alibaba&#39;s performant long context models for agentic and coding tasks.</p>
    </div>
    <div class="flex flex-col">
      <div class="flex flex-wrap space-x-2">
        <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">30b</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">480b</span>
      </div>
    </div>
  </a>
</li>
<li  class="flex items-baseline border-b border-neutral-200 py-8">
  <a href="/library/qwen2.5-coder" class="group w-full">
    <div class="flex flex-col mb-2" title="qwen2.5-coder">
      <h2><span >qwen2.5-coder</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Code-specific model.</p>
    </div>
    <div class="flex flex-wrap space-x-2">
      <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
      <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600 sm:text-[13px]">thinking</span>
      <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">7b</span>
    </div>
  </a>
</li>
</ul>`;

test("parseSearchHtml extracts name, description, capabilities, sizes", () => {
  const hits = parseSearchHtml(SEARCH_HTML);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].name, "qwen3-coder");
  assert.equal(hits[0].description, "Alibaba's performant long context models for agentic and coding tasks.");
  assert.deepEqual(hits[0].capabilities, ["tools"]);
  assert.deepEqual(hits[0].sizes, ["30b", "480b"]);
  assert.equal(hits[1].name, "qwen2.5-coder");
  assert.deepEqual(hits[1].capabilities, ["tools", "thinking"]);
  assert.deepEqual(hits[1].sizes, ["7b"]);
});

test("parseTagsHtml extracts unique tags for the model only", () => {
  const html = `
    <a href="/library/gemma4:e4b" class="x">gemma4:e4b</a>
    <a>gemma4:e4b</a>
    <a href="/library/gemma4:12b">gemma4:12b</a>
    <a href="/library/gemma4:26b-a4b-it-q4_K_M">gemma4:26b-a4b-it-q4_K_M</a>
    <a href="/library/othermodel:7b">othermodel:7b</a>`;
  const tags = parseTagsHtml(html, "gemma4");
  assert.deepEqual(tags.map((t) => t.tag), ["e4b", "12b", "26b-a4b-it-q4_K_M"]);
  assert.equal(tags[0].fullName, "gemma4:e4b");
});

test("manifestSizeBytes sums layer sizes", () => {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    layers: [{ size: 5493439296 }, { size: 991552256 }, { size: 98653280 }, { size: 13 }],
  });
  assert.equal(manifestSizeBytes(manifest), 5493439296 + 991552256 + 98653280 + 13);
  assert.equal(manifestSizeBytes("not json"), 0);
});

test("listRegistryTags attaches sizes from manifests when requested", async () => {
  const manifest = JSON.stringify({ layers: [{ size: 100 }, { size: 200 }] });
  const fetcher = async (url: string): Promise<string> => {
    if (url.includes("/tags")) return '<a href="/library/m:x">m:x</a><a>m:y</a>';
    return manifest;
  };
  const tags = await listRegistryTags("m", { includeSizes: true, fetcher });
  assert.deepEqual(tags.map((t) => t.tag), ["x", "y"]);
  assert.equal(tags[0].sizeBytes, 300);
});
