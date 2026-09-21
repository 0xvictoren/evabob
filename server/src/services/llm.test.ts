/**
 * The DeepSeek client both assistant paths share.
 *
 * Pinned against a stubbed fetch: the request must turn thinking mode off
 * (it is on by default at DeepSeek and would otherwise ignore temperature and
 * demand its reasoning back every round), and every failure must come back
 * as null so the assistant falls back to its deterministic answer instead of
 * an empty bubble.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.DEEPSEEK_API_KEY = "sk-test";
process.env.FEATURE_EXTERNAL_LLM = "true";
process.env.DEEPSEEK_MODEL = "deepseek-flash";
process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.test/";
delete process.env.DEEPSEEK_THINKING;

const { chatCompletion, llmConfigured } = await import("./llm.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(
  respond: (url: string, body: Record<string, unknown>) => Response,
): { calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> } {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body, auth: headers.Authorization! });
    return respond(url, body);
  }) as typeof fetch;
  return { calls };
}

const ok = (message: Record<string, unknown>) =>
  new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });

describe("DeepSeek client", () => {
  it("requires both the API key and the explicit privacy feature gate", () => {
    assert.equal(llmConfigured(), true);
  });

  it("posts an OpenAI-shaped request with thinking off and temperature kept", async () => {
    const { calls } = stub(() => ok({ content: "hi" }));
    const reply = await chatCompletion({
      caller: "test",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
      tools: [{ type: "function", function: { name: "get_balance" } }],
    });
    assert.equal(reply?.content, "hi");
    const [call] = calls;
    assert.equal(call!.url, "https://api.deepseek.test/chat/completions");
    assert.equal(call!.auth, "Bearer sk-test");
    assert.equal(call!.body.model, "deepseek-flash");
    assert.deepEqual(call!.body.thinking, { type: "disabled" });
    assert.equal(call!.body.temperature, 0.3);
    assert.equal(call!.body.tool_choice, "auto");
    assert.equal(call!.body.response_format, undefined);
  });

  it("asks for JSON only when the caller does", async () => {
    const { calls } = stub(() => ok({ content: "{}" }));
    await chatCompletion({ caller: "test", messages: [], json: true });
    assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
    assert.equal(calls[0]!.body.tools, undefined);
  });

  it("returns tool calls and any reasoning so the loop can pass it back", async () => {
    stub(() =>
      ok({
        content: null,
        reasoning_content: "check the balance first",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "get_balance", arguments: "{}" } },
        ],
      }),
    );
    const reply = await chatCompletion({ caller: "test", messages: [] });
    assert.equal(reply?.toolCalls.length, 1);
    assert.equal(reply?.reasoningContent, "check the balance first");
  });

  it("returns null on an error status so the caller falls back", async () => {
    stub(() => new Response("rate limited", { status: 429 }));
    assert.equal(await chatCompletion({ caller: "test", messages: [] }), null);
  });

  it("returns null when the network fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    assert.equal(await chatCompletion({ caller: "test", messages: [] }), null);
  });
});
