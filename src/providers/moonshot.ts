/** Moonshot (Kimi) adapter — OpenAI-compatible (thin) + native passthrough. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://api.moonshot.cn";

const moonshot: ProviderAdapter = {
  name: "moonshot",

  models(): string[] {
    // kimi-k2-0711-preview removed: upstream returns "Not found the model" for
    // these keys (name retired / no permission). Re-add if a key gains access.
    return ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    const body: OpenAIChatRequest = { ...req, model: stripProviderPrefix(req.model) };
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
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${key}`);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cookie");
    headers.delete("x-goog-api-key");
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    return fetch(`${BASE}${subPath}`, { method: req.method, headers, body: hasBody ? req.body : undefined });
  },
};

export default moonshot;
