/**
 * Stability AI adapter — passthrough-only (image generation; no OpenAI chat).
 *
 * The key pool custodies Stability keys and proxies their NATIVE API. There is
 * no chat-completions equivalent, so `chatCompletions` returns a clean 400 and
 * `models()` is empty; real traffic goes through `/stability/*` passthrough.
 * Auth uses a Bearer token.
 */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";

const BASE = "https://api.stability.ai";

function unsupported(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "stability is passthrough-only (image generation, no chat completions); call the native API at /stability/*",
        type: "unsupported_provider",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

const stability: ProviderAdapter = {
  name: "stability",

  models(): string[] {
    return [];
  },

  async chatCompletions(_req: OpenAIChatRequest, _key: string): Promise<Response> {
    return unsupported();
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

export default stability;
