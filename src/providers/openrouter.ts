/** OpenRouter adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";

const BASE = "https://openrouter.ai/api";
const REFERER = "https://keypool.local";
const TITLE = "keypool-gateway";

/**
 * OpenRouter speaks the OpenAI Chat Completions API natively, so the adapter
 * just forwards the request body to `/v1/chat/completions` with a Bearer key
 * (plus OpenRouter's recommended attribution headers) and returns the upstream
 * Response untouched — success, stream, or error.
 */
const openrouter: ProviderAdapter = {
  name: "openrouter",

  models(): string[] {
    return [
      "openrouter/auto",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
    ];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    return fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": REFERER,
        "X-Title": TITLE,
      },
      body: JSON.stringify(req),
    });
  },

  async passthrough(subPath: string, req: Request, key: string): Promise<Response> {
    const url = `${BASE}${subPath}`;
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${key}`);
    headers.set("HTTP-Referer", REFERER);
    headers.set("X-Title", TITLE);
    // Strip hop-by-host headers so the upstream origin resolves correctly.
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cookie");
    headers.delete("x-goog-api-key");

    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    return fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
    });
  },
};

export default openrouter;
