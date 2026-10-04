import type { ProviderConfig } from "../config.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  DecideRequest,
  DecideResult,
  LoadedModel,
  ModelInfo,
  Provider,
  PullProgress,
  ToolCall,
  ToolSpec,
} from "./types.ts";
import { isLocalUrl } from "./types.ts";

interface OllamaMessage {
  role: string;
  content: string;
  name?: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

function toWire(m: ChatMessage): OllamaMessage {
  const out: OllamaMessage = { role: m.role, content: m.content };
  if (m.role === "tool" && m.name) out.name = m.name;
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return out;
}

function wireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OllamaProvider implements Provider {
  readonly isLocal: boolean;
  readonly type = "ollama" as const;
  readonly name: string;
  private cfg: ProviderConfig;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    this.cfg = cfg;
    this.isLocal = isLocalUrl(cfg.base_url);
  }

  get baseUrl(): string {
    return this.cfg.base_url.replace(/\/+$/, "");
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

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.baseUrl + path, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama ${path} -> ${res.status}: ${body.slice(0, 500)}`);
    }
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const options: Record<string, unknown> = {
      ...this.cfg.options,
      num_ctx: req.num_ctx ?? this.cfg.num_ctx,
      temperature: req.temperature ?? this.cfg.temperature,
      num_predict: req.max_tokens,
      top_p: req.top_p,
      seed: req.seed,
      stop: req.stop,
      ...req.options,
    };
    for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWire),
      stream: false,
      options,
    };
    const think = req.think ?? this.cfg.think;
    if (think !== undefined) body.think = think;
    if (this.cfg.keep_alive) body.keep_alive = this.cfg.keep_alive;
    if (req.tools?.length) body.tools = wireTools(req.tools);
    if (req.response_format === "json") body.format = "json";
    else if (req.response_format && typeof req.response_format === "object") {
      body.format = req.response_format;
    }

    const res = await this.req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
    const data = (await res.json()) as {
      model: string;
      message: OllamaMessage;
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    const toolCalls: ToolCall[] = (data.message.tool_calls ?? []).map((tc, i) => ({
      id: `call_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments ?? {},
    }));

    return {
      content: data.message.content ?? "",
      toolCalls,
      model: data.model,
      finishReason: data.done_reason,
      thinking: data.message.thinking || undefined,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.req("/api/tags");
    const data = (await res.json()) as {
      models: {
        name: string;
        size: number;
        details?: {
          parameter_size?: string;
          quantization_level?: string;
          context_length?: number;
        };
        capabilities?: string[];
        modified_at?: string;
      }[];
    };
    return data.models.map((m) => ({
      id: m.name,
      sizeBytes: m.size,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      contextLength: m.details?.context_length,
      capabilities: m.capabilities,
      modifiedAt: m.modified_at,
    }));
  }

  async pull(
    model: string,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.req("/api/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal: signal ?? null,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const p = JSON.parse(line) as PullProgress & { error?: string };
        if (p.error) throw new Error(`pull failed: ${p.error}`);
        onProgress(p);
      }
    }
  }

  async ps(): Promise<LoadedModel[]> {
    const res = await this.req("/api/ps");
    const data = (await res.json()) as {
      models: {
        name: string;
        size: number;
        size_vram?: number;
        expires_at?: string;
        processor?: string;
        context_length?: number;
      }[];
    };
    return data.models.map((m) => ({
      id: m.name,
      sizeBytes: m.size_vram ?? m.size,
      processor: m.processor ?? (m.size_vram && m.size_vram < m.size ? "CPU/GPU" : "GPU"),
      contextLength: m.context_length ?? 0,
      expiresAt: m.expires_at,
    }));
  }

  async unload(model: string): Promise<void> {
    await this.req("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
    });
  }

  async delete(model: string): Promise<void> {
    // `name` is the legacy field, `model` the current one — send both so every
    // ollama version accepts the request.
    await this.req("/api/delete", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, model }),
    });
  }

  async show(model: string): Promise<Record<string, unknown>> {
    const res = await this.req("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      state: req.state,
      questions: req.questions,
    };
    if (this.cfg.keep_alive) body.keep_alive = this.cfg.keep_alive;
    const res = await this.req("/api/systemone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
    const data = (await res.json()) as {
      model?: string;
      answers?: Record<string, unknown>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      model: data.model ?? req.model,
      answers: data.answers ?? {},
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      },
    };
  }
}
