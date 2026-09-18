/**
 * Anthropic Messages API <-> OpenAI Chat Completions translation, so
 * Anthropic-native clients (Claude Code, cc-haha, the Anthropic SDK) can use the
 * gateway at POST /v1/messages. Requests are translated to OpenAI, dispatched
 * through the shared pool, and the OpenAI response (JSON or SSE) is translated
 * back into the Anthropic shape.
 */

import type { OpenAIChatRequest } from "./providers/types";

// ---------- request: Anthropic -> OpenAI ----------

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicImageBlock {
  type: "image";
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | { type: string; [k: string]: unknown };

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | AnthropicBlock[];
  messages: Array<{ role: string; content: string | AnthropicBlock[] }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

function blocksToOpenAIContent(content: string | AnthropicBlock[]): OpenAIChatRequest["messages"][number]["content"] {
  if (typeof content === "string") return content;
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  for (const b of content) {
    if (b && (b as AnthropicTextBlock).type === "text") {
      parts.push({ type: "text", text: String((b as AnthropicTextBlock).text ?? "") });
    } else if (b && (b as AnthropicImageBlock).type === "image") {
      const s = (b as AnthropicImageBlock).source;
      if (s?.url) parts.push({ type: "image_url", image_url: { url: s.url } });
      else if (s?.data && s?.media_type) {
        parts.push({ type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } });
      }
    }
    // tool_use / tool_result blocks are dropped (best-effort text bridge).
  }
  // If every part is text, collapse to a plain string for max provider compatibility.
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as { text: string }).text).join("");
  }
  return parts as unknown as OpenAIChatRequest["messages"][number]["content"];
}

function systemToText(system: string | AnthropicBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((b) => (b as AnthropicTextBlock).type === "text")
    .map((b) => (b as AnthropicTextBlock).text)
    .join("\n");
}

/** Build an OpenAI chat request from an Anthropic Messages request. */
export function anthropicToOpenAI(a: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIChatRequest["messages"] = [];
  const sys = systemToText(a.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of a.messages) {
    messages.push({ role: m.role, content: blocksToOpenAIContent(m.content) });
  }
  const out: OpenAIChatRequest = {
    model: a.model,
    messages,
    stream: a.stream === true ? true : undefined,
    max_tokens: typeof a.max_tokens === "number" ? a.max_tokens : undefined,
    temperature: typeof a.temperature === "number" ? a.temperature : undefined,
    top_p: typeof a.top_p === "number" ? a.top_p : undefined,
    stop: Array.isArray(a.stop_sequences) ? a.stop_sequences : undefined,
  };
  return out;
}

// ---------- response: OpenAI -> Anthropic ----------

function mapStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "content_filter": return "stop_sequence";
    default: return "end_turn"; // "stop" / null
  }
}

function msgId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  let hex = "";
  for (const b of a) hex += b.toString(16).padStart(2, "0");
  return "msg_" + hex;
}

interface OpenAICompletion {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Translate a non-streaming OpenAI completion JSON into an Anthropic message. */
export function openAIToAnthropic(oai: OpenAICompletion, model: string): unknown {
  const choice = oai.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- streaming: OpenAI SSE -> Anthropic SSE ----------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Wrap an OpenAI SSE stream (chat.completion.chunk frames + `data: [DONE]`) into
 * an Anthropic Messages SSE stream (message_start → content_block_delta* →
 * message_delta → message_stop).
 */
export function openAIStreamToAnthropic(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const id = msgId();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let started = false;
  let stopReason = "end_turn";
  let outTokens = 0;
  let inTokens = 0;
  const reader = upstream.getReader();

  function startEvents(controller: ReadableStreamDefaultController<Uint8Array>) {
    controller.enqueue(enc.encode(sse("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 0 } },
    })));
    controller.enqueue(enc.encode(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
    started = true;
  }

  function handleLine(line: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let obj: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try { obj = JSON.parse(data); } catch { return; }
    if (obj.usage) {
      if (typeof obj.usage.prompt_tokens === "number") inTokens = obj.usage.prompt_tokens;
      if (typeof obj.usage.completion_tokens === "number") outTokens = obj.usage.completion_tokens;
    }
    const ch = obj.choices?.[0];
    if (!started) startEvents(controller);
    const piece = ch?.delta?.content;
    if (typeof piece === "string" && piece.length) {
      controller.enqueue(enc.encode(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } })));
    }
    if (ch?.finish_reason) stopReason = mapStopReason(ch.finish_reason);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n");
            buf = parts.pop() ?? "";
            for (const line of parts) handleLine(line, controller);
          }
          if (buf.trim()) handleLine(buf, controller);
        } catch {
          // fall through to always emit the terminating events
        }
        try {
          if (!started) startEvents(controller);
          controller.enqueue(enc.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })));
          controller.enqueue(enc.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTokens } })));
          controller.enqueue(enc.encode(sse("message_stop", { type: "message_stop" })));
          controller.close();
        } catch {
          /* already closed */
        }
      })();
    },
  });
}
