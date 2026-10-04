import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../src/providers/ollama.ts";

function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify(handler(url, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

const provider = () =>
  new OllamaProvider("local", { type: "ollama", base_url: "http://localhost:11434" });

test("decide posts to /api/systemone with model, state, questions", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const restore = stubFetch((url, body) => {
    seen = { url, body };
    return {
      model: "clef-flash:9b",
      answers: {
        lang: { type: "choice", choice: "ts", probabilities: { ts: 0.91, py: 0.09 }, confidence: 0.82 },
      },
      usage: { input_tokens: 512, output_tokens: 0 },
    };
  });
  try {
    const res = await provider().decide({
      model: "clef-flash:9b",
      state: "const x: number = 1;",
      questions: {
        lang: { type: "choice", instructions: "Which language?", criteria: { ts: null, py: null } },
      },
    });
    assert.equal(seen!.url, "http://localhost:11434/api/systemone");
    assert.equal(seen!.body.model, "clef-flash:9b");
    assert.equal(seen!.body.state, "const x: number = 1;");
    assert.deepEqual((seen!.body.questions as Record<string, unknown>).lang, {
      type: "choice",
      instructions: "Which language?",
      criteria: { ts: null, py: null },
    });
    assert.equal(res.model, "clef-flash:9b");
    assert.equal((res.answers.lang as { choice: string }).choice, "ts");
    assert.equal(res.usage?.inputTokens, 512);
  } finally {
    restore();
  }
});

test("decide passes structured state through untouched", async () => {
  let seen: Record<string, unknown> | undefined;
  const restore = stubFetch((_url, body) => {
    seen = body;
    return { answers: {} };
  });
  try {
    const state = [{ file: "a.ts", content: "x" }];
    await provider().decide({
      model: "clef-flash:9b",
      state,
      questions: { ok: { type: "noul", instructions: "Is this valid?" } },
    });
    assert.deepEqual(seen!.state, state);
    assert.ok(!("keep_alive" in seen!));
  } finally {
    restore();
  }
});

test("decide sends keep_alive when configured", async () => {
  let seen: Record<string, unknown> | undefined;
  const restore = stubFetch((_url, body) => {
    seen = body;
    return { answers: {} };
  });
  try {
    const p = new OllamaProvider("local", {
      type: "ollama",
      base_url: "http://localhost:11434",
      keep_alive: "10m",
    });
    await p.decide({
      model: "clef-flash:9b",
      state: "x",
      questions: { ok: { type: "noul", instructions: "?" } },
    });
    assert.equal(seen!.keep_alive, "10m");
  } finally {
    restore();
  }
});

test("decide surfaces server errors (non-decision model, oversized request)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "model \"gemma4:e4b\" does not support System One scoring" }), {
      status: 400,
    })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        provider().decide({
          model: "gemma4:e4b",
          state: "x",
          questions: { ok: { type: "noul", instructions: "?" } },
        }),
      /400.*does not support System One scoring/,
    );
  } finally {
    globalThis.fetch = orig;
  }
});
