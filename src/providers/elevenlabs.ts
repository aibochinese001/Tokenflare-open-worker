/**
 * ElevenLabs adapter — passthrough-only (TTS/voice; no OpenAI chat surface).
 *
 * The key pool custodies ElevenLabs keys and proxies their NATIVE API. There is
 * no chat-completions equivalent, so `chatCompletions` returns a clean 400 and
 * `models()` is empty; real traffic goes through `/elevenlabs/*` passthrough.
 * Auth uses the `xi-api-key` header, not Bearer.
 */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";

const BASE = "https://api.elevenlabs.io";

function unsupported(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "elevenlabs is passthrough-only (TTS/voice, no chat completions); call the native API at /elevenlabs/*",
        type: "unsupported_provider",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

const elevenlabs: ProviderAdapter = {
  name: "elevenlabs",

  models(): string[] {
    return [];
  },

  async chatCompletions(_req: OpenAIChatRequest, _key: string): Promise<Response> {
    return unsupported();
  },

  async passthrough(subPath: string, req: Request, key: string): Promise<Response> {
    const url = `${BASE}${subPath}`;
    const headers = new Headers(req.headers);
    headers.set("xi-api-key", key);
    headers.delete("authorization");
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

export default elevenlabs;
