/** Qwen (Alibaba DashScope, OpenAI-compatible mode) adapter. */

import type { OpenAIChatRequest, ProviderAdapter } from "./types";
import { stripProviderPrefix } from "./types";

const BASE = "https://dashscope.aliyuncs.com/compatible-mode";

const qwen: ProviderAdapter = {
  name: "qwen",

  models(): string[] {
    // qwen2.5-72b-instruct removed: upstream returns "Access denied" for these
    // keys (no permission). Re-add if a key gains access to the open models.
    return ["qwen-plus", "qwen-turbo", "qwen-max"];
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

export default qwen;
