import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop, salvageToolCalls, type LocalTool } from "../src/lib/agent-loop.ts";
import type { ChatResult, Provider } from "../src/providers/types.ts";

const echoTool: LocalTool = {
  spec: { name: "echo", description: "echo args back", parameters: { type: "object" } },
  async execute(args) {
    return `echo:${JSON.stringify(args)}`;
  },
};

const tools = new Map([["echo", echoTool]]);

function fakeProvider(results: Partial<ChatResult>[]): Provider {
  let i = 0;
  return {
    name: "fake",
    type: "ollama",
    baseUrl: "http://localhost:9",
    isLocal: true,
    async chat() {
      const r = results[i++] ?? { content: "fallback" };
      return {
        content: "",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        model: "fake",
        ...r,
      };
    },
    async listModels() {
      return [];
    },
  };
}

test("salvageToolCalls parses a bare JSON tool call", () => {
  const out = salvageToolCalls('{"name":"echo","arguments":{"x":1}}', tools);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "echo");
  assert.deepEqual(out[0].arguments, { x: 1 });
});

test("salvageToolCalls handles <tool_call> tags, fences, and OpenAI-style nesting", () => {
  const tagged = salvageToolCalls(
    'Let me check. <tool_call>{"name":"echo","arguments":{"y":2}}</tool_call>',
    tools,
  );
  assert.equal(tagged.length, 1);
  const fenced = salvageToolCalls('```json\n{"name":"echo","arguments":{"z":3}}\n```', tools);
  assert.equal(fenced.length, 1);
  const nested = salvageToolCalls('{"function":{"name":"echo","arguments":{"w":4}}}', tools);
  assert.equal(nested.length, 1);
});

test("salvageToolCalls ignores prose and unknown tool names", () => {
  assert.equal(salvageToolCalls("just a normal answer", tools).length, 0);
  assert.equal(salvageToolCalls('{"name":"not_a_tool","arguments":{}}', tools).length, 0);
  assert.equal(salvageToolCalls('{"answer": "42"}', tools).length, 0);
});

test("agent loop executes a tool call emitted as plain text", async () => {
  const provider = fakeProvider([
    { content: '{"name":"echo","arguments":{"hi":true}}' },
    { content: "The answer is hi." },
  ]);
  const res = await runAgentLoop({
    provider,
    model: "fake",
    system: "sys",
    task: "do thing",
    tools: [echoTool],
    maxSteps: 5,
    timeoutS: 10,
    toolResultChars: 1000,
  });
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].toolCalls[0].name, "echo");
  assert.equal(res.steps[0].toolCalls[0].result, 'echo:{"hi":true}');
  assert.equal(res.finalAnswer, "The answer is hi.");
  assert.equal(res.usage.calls, 2);
});

test("agent loop forwards think/options to provider.chat", async () => {
  let seen: Record<string, unknown> | undefined;
  const provider: Provider = {
    name: "fake",
    type: "ollama",
    baseUrl: "http://localhost:9",
    isLocal: true,
    async chat(req) {
      seen = req as unknown as Record<string, unknown>;
      return {
        content: "done",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        model: "fake",
      };
    },
    async listModels() {
      return [];
    },
  };
  await runAgentLoop({
    provider,
    model: "fake",
    system: "sys",
    task: "x",
    tools: [],
    maxSteps: 1,
    timeoutS: 10,
    toolResultChars: 1000,
    think: false,
    options: { top_k: 20 },
  });
  assert.equal(seen?.think, false);
  assert.deepEqual(seen?.options, { top_k: 20 });
});

test("delegatedBytes accumulates for delegate-flagged tools only", async () => {
  const readTool: LocalTool = {
    spec: { name: "reader", description: "reads a file", parameters: { type: "object" } },
    delegates: true,
    async execute() {
      return "file-content";
    },
  };
  const provider = fakeProvider([
    { toolCalls: [{ id: "c1", name: "reader", arguments: {} }], content: "" },
    { content: "done" },
  ]);
  const res = await runAgentLoop({
    provider,
    model: "fake",
    system: "sys",
    task: "read it",
    tools: [readTool, echoTool],
    maxSteps: 5,
    timeoutS: 10,
    toolResultChars: 1000,
  });
  assert.equal(res.delegatedBytes, "file-content".length);
});
