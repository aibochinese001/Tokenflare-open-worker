/** Provider adapter contract — authoritative. Do not change signatures. */

import type { Provider } from "../types";

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; name?: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  [k: string]: unknown;
}

export interface ProviderAdapter {
  name: Provider;

  /** OpenAI model ids this provider exposes for GET /v1/models. */
  models(): string[];

  /**
   * Perform an OpenAI-style chat completion using `key`.
   *
   * Contract:
   *  - On upstream SUCCESS: return a 200 Response with an OpenAI-shaped body.
   *    When `req.stream` is true, return `text/event-stream` translated into
   *    OpenAI `chat.completion.chunk` SSE frames terminated by `data: [DONE]`.
   *  - On upstream FAILURE: return a Response whose `status` mirrors the
   *    upstream status (e.g. 401/403/429/5xx) and whose body is the upstream
   *    error text. The pool inspects `status` to classify the key's health,
   *    so failures MUST NOT be swallowed into a 200.
   */
  chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response>;

  /**
   * Native passthrough. `subPath` is everything after `/<provider>` including
   * a leading `/` and the original query string (e.g.
   * `/v1beta/models/gemini-2.0-flash:generateContent?alt=sse`). Inject `key`
   * the way the provider expects and proxy upstream, returning the upstream
   * Response (status + body) unchanged.
   */
  passthrough(subPath: string, req: Request, key: string): Promise<Response>;
}

const PROVIDER_PREFIXES: Provider[] = [
  "gemini",
  "mistral",
  "openrouter",
  "openai",
  "deepseek",
  "groq",
  "moonshot",
  "glm",
  "qwen",
  "deepinfra",
  "fireworks",
  "cerebras",
  "ai21",
  "cohere",
  "elevenlabs",
  "stability",
];

/** Map an OpenAI `model` string to the provider that should serve it. */
export function routeModelToProvider(model: string): Provider {
  const raw = model || "";
  // Explicit "provider:model" prefix wins (e.g. "groq:llama-3.3-70b-versatile").
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const p = raw.slice(0, colon).toLowerCase();
    if ((PROVIDER_PREFIXES as string[]).includes(p)) return p as Provider;
  }
  const m = raw.toLowerCase();
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt")) {
    return "openai";
  }
  if (m.startsWith("deepseek-")) return "deepseek";
  if (m.startsWith("moonshot") || m.startsWith("kimi")) return "moonshot";
  if (m.startsWith("glm-")) return "glm";
  if (m.startsWith("qwen") || m.startsWith("qwq") || m.startsWith("qvq")) return "qwen";
  if (
    m.startsWith("mistral") ||
    m.startsWith("open-mistral") ||
    m.startsWith("open-mixtral") ||
    m.startsWith("codestral") ||
    m.startsWith("ministral") ||
    m.startsWith("magistral") ||
    m.startsWith("pixtral") ||
    m.startsWith("devstral")
  ) {
    return "mistral";
  }
  if (m.startsWith("jamba")) return "ai21";
  if (m.startsWith("command")) return "cohere";
  // deepinfra / fireworks / cerebras share generic llama-style slugs that
  // collide with the openrouter catch-all, so they route only via an explicit
  // "provider:model" prefix (handled above).
  // OpenRouter uses "vendor/model" slugs and serves as the catch-all.
  return "openrouter";
}

/**
 * Cheapest reliable model per provider, used when FALLING BACK (the user's
 * chosen model is unavailable) so we don't substitute an expensive flagship
 * (e.g. mistral-large) and burn balance. Falls back to the adapter's first
 * model if a provider isn't listed.
 */
export const FALLBACK_MODEL: Record<Provider, string> = {
  gemini: "gemini-1.5-flash",
  mistral: "mistral-small-latest",
  openrouter: "meta-llama/llama-3.3-70b-instruct",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  groq: "llama-3.1-8b-instant",
  moonshot: "moonshot-v1-8k",
  glm: "glm-4-flash",
  qwen: "qwen-turbo",
  deepinfra: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  fireworks: "accounts/fireworks/models/llama-v3p1-8b-instruct",
  cerebras: "llama3.1-8b",
  ai21: "jamba-mini",
  cohere: "command-r",
  // passthrough-only providers: no chat model, never used as a chat fallback.
  elevenlabs: "",
  stability: "",
  // channel is routed manually (base_url + api_key), never a fallback target.
  channel: "",
};

/**
 * Per-provider max output tokens. Upstreams reject (or, on a streaming request,
 * silently emit an empty/error stream for) a `max_tokens` above their cap — so
 * we clamp before forwarding. Conservative; raise per provider if needed.
 * (qwen-max caps at 8192; GLM-4 at 4095; etc.)
 */
export const MAX_OUTPUT_TOKENS: Record<Provider, number> = {
  qwen: 8192,
  gemini: 8192,
  glm: 4095,
  mistral: 8192,
  moonshot: 8192,
  openai: 16384,
  deepseek: 8192,
  groq: 8192,
  openrouter: 8192,
  deepinfra: 8192,
  fireworks: 8192,
  cerebras: 8192,
  ai21: 4096,
  cohere: 4096,
  elevenlabs: 4096,
  stability: 4096,
  channel: 16384,
};

/** Clamp a requested max_tokens to a provider's cap (no-op if unset/≤0). */
export function clampMaxTokens(provider: Provider, maxTokens: number | undefined): number | undefined {
  if (typeof maxTokens !== "number" || maxTokens <= 0) return maxTokens;
  return Math.min(maxTokens, MAX_OUTPUT_TOKENS[provider]);
}

/** Strip a leading "provider:" routing prefix before sending upstream. */
export function stripProviderPrefix(model: string): string {
  const colon = (model || "").indexOf(":");
  if (colon > 0) {
    const p = model.slice(0, colon).toLowerCase();
    if ((PROVIDER_PREFIXES as string[]).includes(p)) return model.slice(colon + 1);
  }
  return model;
}
