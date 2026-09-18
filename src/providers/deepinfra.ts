/** DeepInfra adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://api.deepinfra.com/v1/openai";

/**
 * DeepInfra exposes an OpenAI-compatible API rooted at `/v1/openai`, so the
 * chat endpoint lives at `/v1/openai/chat/completions`. The adapter forwards
 * the request body with a Bearer key and returns the upstream Response
 * untouched — success, stream, or error.
 */
const deepinfra: ProviderAdapter = {
  name: "deepinfra",

  models(): string[] {
    return [
      "meta-llama/Meta-Llama-3.1-8B-Instruct",
      "meta-llama/Meta-Llama-3.1-70B-Instruct",
    ];
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

export default deepinfra;
