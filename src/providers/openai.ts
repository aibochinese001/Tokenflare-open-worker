/** OpenAI adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://api.openai.com";

/**
 * OpenAI is the reference Chat Completions API, so the adapter just forwards the
 * request body to `/v1/chat/completions` with a Bearer key and returns the
 * upstream Response untouched — success, stream, or error. The model is
 * normalized via `stripProviderPrefix` so a routed id like "openai:gpt-4o"
 * reaches the upstream as "gpt-4o".
 */
const openai: ProviderAdapter = {
  name: "openai",

  models(): string[] {
    return ["gpt-4o", "gpt-4o-mini", "o3-mini"];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    const body: OpenAIChatRequest = {
      ...req,
      model: stripProviderPrefix(req.model),
    };
    return fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  },

  async passthrough(subPath: string, req: Request, key: string): Promise<Response> {
    const url = `${BASE}${subPath}`;
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${key}`);
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

export default openai;
