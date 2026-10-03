import type { ProviderConfig } from "../config.ts";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool response messages: name of the tool that produced this */
  name?: string;
  /** tool response messages (openai wire format needs the call id) */
  tool_call_id?: string;
  /** assistant messages: tool calls requested by the model */
  tool_calls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the parameters object */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  num_ctx?: number;
  max_tokens?: number;
  /**
   * Chain-of-thought control. Ollama: `think` bool, or "low"/"medium"/"high"
   * for models with effort levels. OpenAI-compatible: best-effort mapping to
   * `reasoning_effort` (levels) / `chat_template_kwargs.enable_thinking` (false).
   * On thinking models, `think: false` keeps the whole token budget for the answer.
   */
  think?: boolean | "low" | "medium" | "high";
  top_p?: number;
  seed?: number;
  stop?: string[];
  /**
   * Provider-native overrides. Ollama: merged into `options` (e.g. top_k,
   * repeat_penalty, num_predict). OpenAI-compatible: merged into the request
   * body. Wins over the named fields above and provider config `options`.
   */
  options?: Record<string, unknown>;
  /** JSON schema for structured output, or "json" for generic JSON mode */
  response_format?: "json" | Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  finishReason?: string;
  /** Reasoning trace, when the model/provider produces one separately from content. */
  thinking?: string;
}

export interface ModelInfo {
  id: string;
  sizeBytes?: number;
  parameterSize?: string;
  contextLength?: number;
  capabilities?: string[];
  quantization?: string;
  /** ISO timestamp the model blob was last pulled/used (ollama `modified_at`). */
  modifiedAt?: string;
}

export interface LoadedModel {
  id: string;
  sizeBytes: number;
  processor: string;
  contextLength: number;
  expiresAt?: string;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface Provider {
  readonly name: string;
  readonly type: "ollama" | "openai";
  readonly baseUrl: string;
  readonly isLocal: boolean;
  readonly defaultModel?: string;
  readonly defaultNumCtx?: number;
  readonly defaultTemperature?: number;

  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;

  /** Ollama-only management ops; absent on generic openai providers. */
  pull?(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  ps?(): Promise<LoadedModel[]>;
  unload?(model: string): Promise<void>;
  /** Delete a model's blobs (ollama /api/delete). Irreversible — re-pull to restore. */
  delete?(model: string): Promise<void>;
  show?(model: string): Promise<Record<string, unknown>>;
}

export function isLocalUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function apiKeyFor(cfg: ProviderConfig): string | undefined {
  if (cfg.api_key_env) return process.env[cfg.api_key_env];
  return process.env.OPENAI_API_KEY;
}
