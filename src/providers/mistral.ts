/** Mistral adapter. Mistral's API is OpenAI-compatible, so this is thin. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";

const BASE_URL = "https://api.mistral.ai";

const MODELS: string[] = [
  "mistral-large-latest",
  "mistral-small-latest",
  "open-mistral-nemo",
  "codestral-latest",
];

const mistralAdapter: ProviderAdapter = {
  name: "mistral",

  models(): string[] {
    return [...MODELS];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    // Mistral's /v1/chat/completions is OpenAI-compatible: forward the body
    // mostly as-is. Streaming (text/event-stream) passes through untouched.
    return fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: req.stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(req),
    });
  },

  async passthrough(subPath: string, req: Request, key: string): Promise<Response> {
    const url = `${BASE_URL}${subPath}`;

    // Clone incoming headers but force our own bearer key; drop hop-by-hop /
    // host headers so the upstream sees a clean request.
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${key}`);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cookie");
    headers.delete("x-goog-api-key");

    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    return fetch(url, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
    });
  },
};

export default mistralAdapter;
