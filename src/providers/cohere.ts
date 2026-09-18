/** Cohere adapter — OpenAI-compatible (Compatibility API) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

// Cohere's OpenAI-compatible "Compatibility API" is rooted at
// `/compatibility/v1`; the chat endpoint is `/compatibility/v1/chat/completions`.
const BASE = "https://api.cohere.ai/compatibility/v1";

const cohere: ProviderAdapter = {
  name: "cohere",

  models(): string[] {
    return ["command-r-plus", "command-r"];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    const body: OpenAIChatRequest = {
      ...req,
      model: stripProviderPrefix(req.model),
    };
    return fetch(`${BASE}/chat/completions`, {
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

export default cohere;
