/**
 * The Evabob Agent's language model — DeepSeek, through its OpenAI-compatible
 * chat completions API.
 *
 * Both callers (the tool-calling loop in agentChat.ts and the JSON intent
 * parser in agentLlm.ts) used to post to Groq separately. Groq's free tier
 * allowed about 8,000 tokens a minute, roughly three questions a minute across
 * every user, which is fine for one person typing and not for a demo. One
 * client here means one place to change the provider, the timeout, and what
 * happens when the model is unreachable.
 *
 * Thinking mode is turned off by default. It is on by default at DeepSeek,
 * and with tools present it requires the model's `reasoning_content` to be
 * sent back on every later request of the turn; it also ignores temperature.
 * A chat bubble wants a fast, steady answer, not a long deliberation. If it is
 * switched on through DEEPSEEK_THINKING, reasoning is carried back as required.
 *
 * DeepSeek caches repeated prompt prefixes automatically, so the long,
 * unchanging system prompts both callers send are billed at the cache rate
 * after the first request rather than in full every turn.
 */

import { config } from "../config.js";

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  /** Thinking-mode reasoning, passed back unchanged when present. */
  reasoning_content?: string;
};

export type LlmReply = {
  content: string | null;
  toolCalls: LlmToolCall[];
  reasoningContent?: string;
};

export function llmConfigured(): boolean {
  return config.features.externalLlm && Boolean(config.llm.apiKey);
}

/** The model name, for health output and logs. Never the key. */
export function llmModel(): string {
  return config.llm.model;
}

/**
 * One chat completion. Returns null when the model could not be reached or
 * refused the request, so every caller can fall back to its deterministic
 * answer instead of showing the user an empty bubble.
 */
export async function chatCompletion(input: {
  messages: LlmMessage[];
  tools?: unknown[];
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
  /** Tag for log lines, e.g. "agent-chat". */
  caller: string;
}): Promise<LlmReply | null> {
  if (!llmConfigured()) return null;

  const thinking = config.llm.thinking;
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages: input.messages,
    thinking: { type: thinking ? "enabled" : "disabled" },
  };
  // Thinking mode rejects temperature, so only send it when thinking is off.
  if (!thinking && input.temperature != null) body.temperature = input.temperature;
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  if (input.json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[${input.caller}] llm`, res.status, text.slice(0, 200));
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: LlmToolCall[];
          reasoning_content?: string;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) return null;
    return {
      content: message.content ?? null,
      toolCalls: message.tool_calls ?? [],
      ...(message.reasoning_content
        ? { reasoningContent: message.reasoning_content }
        : {}),
    };
  } catch (e) {
    console.warn(
      `[${input.caller}] llm unreachable:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
