/**
 * Channel protocol adapters. The public gateway API stays OpenAI-shaped; a
 * channel may speak OpenAI, Anthropic (Claude), or OpenAI-with-custom-auth.
 * This module converts requests to the channel's dialect and converts
 * responses (JSON and SSE) back to the OpenAI shape for the client.
 */

import type { OpenAIChatRequest } from "./providers/types";

export type ChannelProtocol = "openai" | "anthropic" | "zai" | "custom";
export type ChannelAuth = "bearer" | "x_api_key" | "custom_header";

export interface ChannelProtoMeta {
  protocol: string;
  provider: string;
  auth_type: string;
  auth_header: string | null;
}

/** Upstream endpoint for a channel's protocol + provider. */
export function channelEndpoint(baseUrl: string, protocol: string, provider?: string): string {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (protocol === "anthropic") {
    if (base.includes("/messages")) return base;
    if (/\/v1$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (protocol === "zai" || protocol === "zai_coding" || provider === "gemini") {
    // Z.ai / 智谱 GLM (incl. Coding Plan) and Google Gemini OpenAI-compat
    // endpoints have NO /v1 prefix — `<base>/chat/completions`.
    if (base.includes("/chat/completions")) return base;
    return `${base}/chat/completions`;
  }
  // openai / custom / azure / deepseek / ... — OpenAI-compatible completions.
  if (base.includes("/chat/completions")) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Headers for a channel, driven by protocol + provider + auth type. */
export function channelHeaders(meta: ChannelProtoMeta, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (meta.protocol === "anthropic") {
    h["x-api-key"] = apiKey;
    h["anthropic-version"] = "2023-06-01";
    return h;
  }
  if (meta.provider === "gemini") {
    // Google Gemini OpenAI-compat endpoint authenticates with x-goog-api-key.
    h["x-goog-api-key"] = apiKey;
    return h;
  }
  if (meta.provider === "azure") {
    h["api-key"] = apiKey;
    return h;
  }
  if (meta.auth_type === "x_api_key") {
    h["x-api-key"] = apiKey;
  } else if (meta.auth_type === "custom_header") {
    const name = (meta.auth_header || "").trim();
    h[name || "x-api-key"] = apiKey;
  } else {
    h["authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

/** Build the wire payload for the channel's protocol. */
export function channelPayload(protocol: string, body: OpenAIChatRequest): unknown {
  if (protocol === "anthropic") return anthropicPayload(body);
  return body;
}

// ---------------- Anthropic (Claude) ----------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const x = p as { type?: unknown; text?: unknown };
        return typeof x.text === "string" ? x.text : "";
      })
      .join("");
  }
  return "";
}

function anthropicPayload(body: OpenAIChatRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (const m of body.messages || []) {
    if (m.role === "system") {
      messages.push({ role: "user", content: textOf(m.content) });
      continue;
    }
    if (m.role === "tool") {
      // OpenAI tool result → Anthropic tool_result user message.
      const t = m as unknown as {
        tool_call_id?: unknown;
        content?: unknown;
      };
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(t.tool_call_id ?? "tool_use"),
            content: textOf(t.content),
          },
        ],
      });
      continue;
    }
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) });
  }
  const p: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens:
      typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : 4096,
  };
  if (typeof body.temperature === "number") p.temperature = body.temperature;
  if (typeof body.top_p === "number") p.top_p = body.top_p;
  if (typeof body.stop === "string" || Array.isArray(body.stop)) {
    p.stop_sequences = typeof body.stop === "string" ? [body.stop] : body.stop;
  }
  if (body.stream === true) p.stream = true;
  const tools = (body as { tools?: unknown }).tools;
  if (Array.isArray(tools) && tools.length > 0) {
    p.tools = tools.map((t) => {
      const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })
        .function;
      if (fn) {
        return {
          name: String(fn.name ?? "tool"),
          description: typeof fn.description === "string" ? fn.description : undefined,
          input_schema: (fn.parameters as Record<string, unknown>) ?? { type: "object" },
        };
      }
      return t;
    });
  }
  return p;
}

/** Convert a non-streaming Anthropic response into an OpenAI-shaped JSON body. */
export function adaptJsonResponse(
  protocol: string,
  body: OpenAIChatRequest,
  json: unknown
): unknown {
  if (protocol !== "anthropic") return json;
  const j = json as {
    id?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
    stop_reason?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  } | null;
  const text = (j?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  const u = j?.usage ?? {};
  const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const cached = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const stopMap: Record<string, string> = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
  };
  return {
    id: typeof j?.id === "string" ? j.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || null },
        finish_reason:
          typeof j?.stop_reason === "string" ? (stopMap[j.stop_reason] ?? "stop") : "stop",
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: cached > 0 ? { cached_tokens: cached } : undefined,
    },
  };
}

/**
 * Transform an Anthropic SSE byte stream into OpenAI chat-completion SSE.
 * Usage from message_start (input_tokens + cache_read) and message_delta
 * (output_tokens) is folded into a final chunk so clients see token counts.
 */
export function adaptStream(protocol: string, model: string): TransformStream<Uint8Array, Uint8Array> | null {
  if (protocol !== "anthropic") return null;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now()}`;
  let buf = "";
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let startSent = false;

  const frame = (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: payload.choices, usage: payload.usage })}\n\n`;

  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev: {
          type?: string;
          message?: { role?: string; usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown } };
          delta?: { type?: string; text?: string; stop_reason?: string };
          usage?: { output_tokens?: unknown };
        };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (!ev.type) continue;
        if (ev.type === "message_start" && ev.message) {
          const u = ev.message.usage;
          if (u && typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (u && typeof u.cache_read_input_tokens === "number") cachedTokens = u.cache_read_input_tokens;
          if (!startSent) {
            startSent = true;
            ctrl.enqueue(
              enc.encode(
                frame({ choices: [{ index: 0, delta: { role: ev.message.role || "assistant" }, finish_reason: null }] })
              )
            );
          }
        } else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          ctrl.enqueue(
            enc.encode(
              frame({
                choices: [{ index: 0, delta: { content: ev.delta.text || "" }, finish_reason: null }],
              })
            )
          );
        } else if (ev.type === "message_delta") {
          if (ev.usage && typeof ev.usage.output_tokens === "number") outputTokens = ev.usage.output_tokens;
          const stopMap: Record<string, string> = {
            end_turn: "stop",
            stop_sequence: "stop",
            max_tokens: "length",
            tool_use: "tool_calls",
          };
          const fr = ev.delta?.stop_reason ? (stopMap[ev.delta.stop_reason] ?? "stop") : "stop";
          ctrl.enqueue(
            enc.encode(
              frame({
                choices: [{ index: 0, delta: {}, finish_reason: fr }],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                  prompt_tokens_details: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
                },
              })
            )
          );
        } else if (ev.type === "message_stop") {
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
        }
      }
    },
    flush(ctrl) {
      if (buf.trim()) {
        // drop trailing garbage (should be empty)
      }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  });
}
