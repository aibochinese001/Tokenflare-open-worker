/** AI21 (Jamba) adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://api.ai21.com/studio/v1";

/**
 * AI21 exposes an OpenAI-compatible chat API rooted at `/studio/v1`, so the
 * chat endpoint lives at `/studio/v1/chat/completions`. The adapter forwards
 * the request body with a Bearer key and returns the upstream Response.
 */
const ai21: ProviderAdapter = {
  name: "ai21",

  models(): string[] {
    return ["jamba-mini", "jamba-large"];
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

export default ai21;
