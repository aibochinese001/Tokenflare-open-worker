/** Groq adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://api.groq.com/openai";

/**
 * Groq exposes an OpenAI-compatible API rooted at `/openai`, so the chat
 * endpoint lives at `/openai/v1/chat/completions`. The adapter forwards the
 * request body with a Bearer key and returns the upstream Response untouched —
 * success, stream, or error.
 */
const groq: ProviderAdapter = {
  name: "groq",

  models(): string[] {
    return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
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

export default groq;
