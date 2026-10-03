import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { GEN_PARAMS, jsonResult, trackedChat } from "./helpers.ts";

const COMMON = {
  model: z.string().optional().describe("Model to use (default: provider/config default). Use list_models to see options."),
  provider: z.string().optional().describe("Provider name from server config (default: default_provider)."),
  temperature: z.number().optional().describe("Sampling temperature (default ~0.2)."),
  max_tokens: z.number().int().optional().describe("Max tokens to generate. On thinking models, thinking consumes this budget — pass think:false for short mechanical answers."),
  num_ctx: z.number().int().optional().describe("Context window size (ollama providers only; bounded for VRAM)."),
  ...GEN_PARAMS,
};

export function registerCompletionTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "chat",
    {
      description:
        "Send a chat-completion request to the cheap/local model and get the response. " +
        "Use for low-complexity work (rewrites, formatting, simple Q&A) instead of reasoning about it yourself.",
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            }),
          )
          .describe("OpenAI-style message list"),
        response_format: z
          .union([z.literal("json"), z.record(z.string(), z.unknown())])
          .optional()
          .describe('"json" for JSON mode, or a JSON schema for structured output'),
        ...COMMON,
      },
    },
    async ({ messages, response_format, model, provider: pName, temperature, max_tokens, num_ctx, think, top_p, seed, stop, options }) => {
      const { provider, model: m } = pickModel(ctx, pName, model);
      const { res, usage } = await trackedChat("chat", provider, {
        model: m,
        messages,
        temperature,
        max_tokens,
        num_ctx,
        think,
        top_p,
        seed,
        stop,
        options,
        response_format,
      });
      return jsonResult({
        content: res.content,
        ...(res.thinking ? { thinking: res.thinking } : {}),
        finish_reason: res.finishReason,
        usage,
      });
    },
  );

  server.registerTool(
    "complete",
    {
      description:
        "Single-shot completion: one prompt in, one response out. Cheapest way to offload a small mechanical task.",
      inputSchema: {
        prompt: z.string().describe("The prompt/instruction for the local model"),
        system: z.string().optional().describe("Optional system prompt"),
        response_format: z
          .union([z.literal("json"), z.record(z.string(), z.unknown())])
          .optional(),
        ...COMMON,
      },
    },
    async ({ prompt, system, response_format, model, provider: pName, temperature, max_tokens, num_ctx, think, top_p, seed, stop, options }) => {
      const { provider, model: m } = pickModel(ctx, pName, model);
      const messages = [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: prompt },
      ];
      const { res, usage } = await trackedChat("complete", provider, {
        model: m,
        messages,
        temperature,
        max_tokens,
        num_ctx,
        think,
        top_p,
        seed,
        stop,
        options,
        response_format,
      });
      return jsonResult({ text: res.content, ...(res.thinking ? { thinking: res.thinking } : {}), usage });
    },
  );
}
