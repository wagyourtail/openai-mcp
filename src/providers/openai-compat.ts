import type { ProviderConfig } from "../config.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  Provider,
  ToolCall,
  ToolSpec,
} from "./types.ts";
import { apiKeyFor, isLocalUrl } from "./types.ts";

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

function toWire(m: ChatMessage): WireMessage {
  const out: WireMessage = { role: m.role, content: m.content || null };
  if (m.role === "tool") {
    out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
  }
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return out;
}

export class OpenAICompatProvider implements Provider {
  readonly isLocal: boolean;
  readonly type = "openai" as const;
  readonly name: string;
  private cfg: ProviderConfig;
  private apiKey?: string;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    this.cfg = cfg;
    this.isLocal = isLocalUrl(cfg.base_url);
    this.apiKey = apiKeyFor(cfg);
  }

  get baseUrl(): string {
    const base = this.cfg.base_url.replace(/\/+$/, "");
    return /\/v\d+$/.test(base) ? base : base + "/v1";
  }
  get defaultModel(): string | undefined {
    return this.cfg.default_model;
  }
  get defaultNumCtx(): number | undefined {
    return this.cfg.num_ctx;
  }
  get defaultTemperature(): number | undefined {
    return this.cfg.temperature;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWire),
      temperature: req.temperature ?? this.cfg.temperature,
      max_tokens: req.max_tokens,
      top_p: req.top_p,
      seed: req.seed,
      stop: req.stop,
    };
    const think = req.think ?? this.cfg.think;
    if (think === false) {
      // vLLM / llama.cpp convention for disabling a model's reasoning pass.
      body.chat_template_kwargs = { enable_thinking: false };
    } else if (typeof think === "string") {
      body.reasoning_effort = think;
    }
    // Provider-native escape hatches; request-level options win over config.
    Object.assign(body, this.cfg.options, req.options);
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    if (req.tools?.length) {
      body.tools = req.tools.map((t: ToolSpec) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.response_format === "json") {
      body.response_format = { type: "json_object" };
    } else if (req.response_format && typeof req.response_format === "object") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "structured_output", schema: req.response_format },
      };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} chat/completions -> ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      model: string;
      choices: { message: WireMessage; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = data.choices[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = { _raw: tc.function.arguments };
      }
      return { id: tc.id ?? `call_${i}`, name: tc.function.name, arguments: args };
    });
    return {
      content: msg?.content ?? "",
      toolCalls,
      model: data.model,
      finishReason: data.choices[0]?.finish_reason,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} /models -> ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { data: { id: string }[] };
    return data.data.map((m) => ({ id: m.id }));
  }
}
