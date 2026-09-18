/** Gemini provider adapter: OpenAI<->Gemini translation (incl. streaming) + native passthrough. */

import type { ProviderAdapter, OpenAIChatRequest } from "./types";

const BASE = "https://generativelanguage.googleapis.com";

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
}

/** Coerce OpenAI message content (string | array of parts) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        out.push(part);
      } else if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") out.push(p.text);
      }
    }
    return out.join("");
  }
  if (content == null) return "";
  return String(content);
}

/** Build the Gemini request body from an OpenAI chat request. */
function toGeminiBody(req: OpenAIChatRequest): GeminiRequestBody {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];

  for (const msg of req.messages || []) {
    const text = contentToText(msg.content);
    if (msg.role === "system") {
      if (text) systemTexts.push(text);
      continue;
    }
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }

  const body: GeminiRequestBody = { contents };

  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join("\n") }] };
  }

  const generationConfig: GeminiGenerationConfig = {};
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.stop === "string") {
    generationConfig.stopSequences = [req.stop];
  } else if (Array.isArray(req.stop)) {
    generationConfig.stopSequences = req.stop.filter((s): s is string => typeof s === "string");
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}

/** Extract the concatenated text from a single Gemini response chunk/object. */
function extractText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  const candidates = o.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = candidates[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return "";
  const content = first.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") return "";
  const parts = content.parts;
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (part && typeof part === "object") {
      const t = (part as Record<string, unknown>).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}

/** Extract the finishReason of the first candidate, if any. */
function extractFinishReason(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const candidates = o.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;
  const fr = first.finishReason;
  return typeof fr === "string" ? fr : null;
}

function mapFinishReason(reason: string | null): string | null {
  if (reason == null) return null;
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "stop";
  }
}

function genId(): string {
  return "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
}

const jsonHeaders = { "content-type": "application/json" };

/** Translate a non-stream Gemini response into an OpenAI chat.completion. */
function toOpenAICompletion(gem: unknown, model: string): unknown {
  const text = extractText(gem);
  const finish = mapFinishReason(extractFinishReason(gem)) ?? "stop";

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  if (gem && typeof gem === "object") {
    const usage = (gem as Record<string, unknown>).usageMetadata;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      if (typeof u.promptTokenCount === "number") promptTokens = u.promptTokenCount;
      if (typeof u.candidatesTokenCount === "number") completionTokens = u.candidatesTokenCount;
      if (typeof u.totalTokenCount === "number") totalTokens = u.totalTokenCount;
    }
  }

  return {
    id: genId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finish,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens || promptTokens + completionTokens,
    },
  };
}

const encoder = new TextEncoder();

/** Build an OpenAI chat.completion.chunk SSE stream from a Gemini SSE stream. */
function streamToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const id = genId();
  const created = Math.floor(Date.now() / 1000);
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = "";
  let sentRole = false;

  function chunkFrame(delta: Record<string, unknown>, finishReason: string | null): Uint8Array {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function handleData(jsonText: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    const trimmed = jsonText.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    const text = extractText(obj);
    if (!sentRole) {
      controller.enqueue(chunkFrame({ role: "assistant", content: "" }, null));
      sentRole = true;
    }
    if (text) {
      controller.enqueue(chunkFrame({ content: text }, null));
    }
    const finish = mapFinishReason(extractFinishReason(obj));
    if (finish) {
      controller.enqueue(chunkFrame({}, finish));
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining buffered SSE lines.
          buffer += decoder.decode();
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.startsWith("data:")) handleData(line.slice(5), controller);
          }
          if (!sentRole) {
            controller.enqueue(chunkFrame({ role: "assistant", content: "" }, null));
            sentRole = true;
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // Process complete lines, keep the trailing partial in the buffer.
        const newlineIdx = buffer.lastIndexOf("\n");
        if (newlineIdx === -1) return;
        const complete = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        for (const line of complete.split("\n")) {
          if (line.startsWith("data:")) handleData(line.slice(5), controller);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

const gemini: ProviderAdapter = {
  name: "gemini",

  models(): string[] {
    return ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro"];
  },

  async chatCompletions(req: OpenAIChatRequest, key: string): Promise<Response> {
    const model = req.model;
    const stream = req.stream === true;
    const method = stream ? "streamGenerateContent" : "generateContent";
    const url = `${BASE}/v1beta/models/${encodeURIComponent(model)}:${method}${
      stream ? "?alt=sse" : ""
    }`;

    const body = toGeminiBody(req);

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(body),
    });

    // Mirror non-2xx upstream errors verbatim so the pool can classify the key.
    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
      });
    }

    if (stream) {
      const src = upstream.body;
      if (!src) {
        return new Response(JSON.stringify({ error: { message: "empty upstream stream", type: "upstream_error" } }), {
          status: 502,
          headers: jsonHeaders,
        });
      }
      return new Response(streamToOpenAI(src, model), {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const gem = await upstream.json();
    const openai = toOpenAICompletion(gem, model);
    return new Response(JSON.stringify(openai), { status: 200, headers: jsonHeaders });
  },

  async passthrough(subPath: string, req: Request, key: string): Promise<Response> {
    const path = subPath.startsWith("/") ? subPath : `/${subPath}`;
    const url = `${BASE}${path}`;

    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("host");
    headers.set("x-goog-api-key", key);

    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error - duplex is required by the Workers runtime when streaming a request body.
      duplex: hasBody ? "half" : undefined,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};

export default gemini;
