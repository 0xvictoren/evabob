/**
 * How outside software reaches an agent wallet.
 *
 * An agent key (`sk_evabob_…`) is not a private key: the wallet's key stays
 * in Circle's MPC and Evabob signs for it, inside the owner's allowance. So
 * an ordinary x402 client cannot use it directly — something has to speak to
 * Evabob. This file is the three ways in, all backed by the same function:
 *
 *   POST /v1/x402/pay            plain HTTP, for scripts and any tool that
 *                                can make a request (routes/api.ts)
 *   POST /v1/agent-api/mcp       Model Context Protocol, for Claude and
 *                                other MCP clients — the tools appear by
 *                                themselves once the server is added
 *   GET  /v1/public/agent-guide  the instructions as text, so a person can
 *                                tell any assistant "read this, then pay"
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { getAuth } from "../middleware/auth.js";
import { store, type AgentWallet } from "../store/db.js";
import type { X402PayResult } from "../services/x402Pay.js";

export const agentGuideRoutes = new Hono();
export const agentMcpRoutes = new Hono();

export const payBody = z.object({
  url: z.string().url().optional(),
  query: z.string().max(200).optional(),
  method: z.string().max(10).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  maxAmountUsdc: z.number().positive().optional(),
  idempotencyKey: z.string().min(16).max(100).optional(),
});

export type PayBody = z.infer<typeof payBody>;

/** The HTTP status a payment result is answered with. */
export function payStatus(result: X402PayResult): 200 | 202 | 400 {
  if (result.ok) return 200;
  if (result.code === "APPROVAL_PENDING" || result.reconciliationRequired) return 202;
  return 400;
}

/** One paid (or free) call for an agent. Every way in ends here. */
export async function runAgentPay(
  agent: AgentWallet,
  body: PayBody,
  idempotencyHeader?: string,
): Promise<X402PayResult> {
  const { x402PayForAgent, x402DiscoverAndPay } = await import("../services/x402Pay.js");
  if (!body.url) {
    return x402DiscoverAndPay({ agent, query: body.query || "" });
  }
  return x402PayForAgent({
    agent,
    url: body.url,
    method: body.method,
    headers: body.headers,
    body: body.body,
    maxAmountUsdc: body.maxAmountUsdc,
    idempotencyKey: idempotencyHeader || body.idempotencyKey,
  });
}

function apiBase(c: Context): string {
  return (config.publicApiUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
}

/** Sellers this agent can pay here, matching some words. */
async function findServices(query: string, limit: number) {
  const { payableServices } = await import("../services/circle-x402.js");
  const { listPublicPaywalls } = await import("../services/paywalls.js");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const paywalls = listPublicPaywalls()
    .filter((p) => matches(`${p.title} ${p.description} ${p.category}`))
    .map((p) => ({
      url: p.resourceUrl,
      method: "GET",
      name: p.title,
      seller: p.seller.handle || p.seller.name,
      description: p.description,
      priceUsdc: p.priceUsdc,
      paysAfterProof: true,
    }));
  let outside: typeof paywalls = [];
  try {
    outside = (await payableServices())
      .filter((s) => matches(`${s.provider} ${s.description} ${s.category} ${s.resource}`))
      .map((s) => ({
        url: s.resource,
        method: s.method,
        name: s.provider,
        seller: new URL(s.origin).hostname,
        description: s.description,
        priceUsdc: s.priceUsdc,
        paysAfterProof: false,
      }));
  } catch {
    /* catalog down: Evabob's own sellers are still listed */
  }
  return [...paywalls, ...outside].slice(0, limit);
}

// ─── The guide ───────────────────────────────────────────────────────────

export function agentGuide(base: string): string {
  return `# Paying with an Evabob agent wallet

You have been given an Evabob agent key (it starts with \`sk_evabob_\`). It lets
you pay for x402 resources — APIs that answer HTTP 402 and ask for a small
USDC payment — from a wallet your owner funded. You never sign anything: you
tell Evabob which URL to call, Evabob pays and returns the seller's answer.

Network: Arc testnet (eip155:${config.arc.chainId}), USDC, Circle Gateway batched payments.
Base URL: ${base}

## Pay for a URL

\`\`\`
POST ${base}/v1/x402/pay
Authorization: Bearer sk_evabob_…
Content-Type: application/json

{"url": "https://seller.example/resource"}
\`\`\`

Optional fields:

- \`method\` — GET (default), POST, PUT, PATCH or DELETE
- \`body\` — what to send the seller (JSON value or string) for non-GET calls
- \`headers\` — headers for the seller, as an object
- \`maxAmountUsdc\` — refuse if the seller asks for more than this
- \`idempotencyKey\` — 16-100 characters. Reuse the same key to retry one
  payment safely; leave it out and one is made and returned to you.

The answer is JSON:

- \`ok\`, \`paid\`, \`costUsdc\` — what happened and what it cost
- \`status\`, \`body\` — the seller's HTTP status and response
- \`error\`, \`code\` — why it was refused, when it was
- \`idempotencyKey\`, \`evidenceId\` — the record of this payment

A URL that is free is simply fetched and returned with \`costUsdc: 0\`.

## Codes

- \`APPROVAL_PENDING\` (HTTP 202) — above the owner's limit. They have been
  asked on their phone. Wait, then send the same request with the same
  \`idempotencyKey\`.
- \`APPROVAL_DECLINED\` — the owner said no. Do not retry.
- \`OVER_ALLOWANCE\` — the allowance for this period is used up.
- \`NOT_ON_LIST\` — this kind of seller is outside what the owner allowed.
- \`NEEDS_PROOF\` — the owner only allows sellers that are paid after delivery.
- \`AGENT_PAUSED\`, \`LOOP_BREAKER\` — stopped; only the owner can resume. Stop
  calling and tell them.
- \`AGENT_NOT_READY\` — the wallet has no money ready yet. Ask the owner to
  top it up in the Evabob app.
- \`NOT_CHARGED\` — the response failed its check and nothing was taken.
- \`PAID_NOT_DELIVERED\` — the seller took payment and returned nothing
  usable. The owner has been told.

Do not call one endpoint more than 5 times a minute unless it costs $0.001
or less per call (then up to 60): the wallet pauses itself.

## Other calls (same Authorization header)

- \`GET  ${base}/v1/agent-api/me\` — balance, allowance, what is left, paused or not
- \`GET  ${base}/v1/agent-api/services?query=words\` — sellers you can pay here
- \`GET  ${base}/v1/agent-api/approvals/:id\` — has the owner answered
- \`POST ${base}/v1/agent-api/tasks\` — hire a person (see the owner's docs)

## Examples

curl:

\`\`\`
curl -X POST ${base}/v1/x402/pay \\
  -H "Authorization: Bearer $EVABOB_AGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://seller.example/resource"}'
\`\`\`

JavaScript:

\`\`\`js
const res = await fetch("${base}/v1/x402/pay", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.EVABOB_AGENT_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ url: "https://seller.example/resource" }),
});
const result = await res.json();
\`\`\`

Python:

\`\`\`python
import os, requests
result = requests.post(
    "${base}/v1/x402/pay",
    headers={"Authorization": f"Bearer {os.environ['EVABOB_AGENT_KEY']}"},
    json={"url": "https://seller.example/resource"},
    timeout=90,
).json()
\`\`\`

## Claude and other MCP clients

The same wallet is an MCP server (streamable HTTP):

\`\`\`
claude mcp add --transport http evabob ${base}/v1/agent-api/mcp \\
  --header "Authorization: Bearer sk_evabob_…"
\`\`\`

Tools: \`evabob_pay\`, \`evabob_wallet\`, \`evabob_find_services\`.

Give the request up to 90 seconds: a paid call is two requests to the seller
and a signature.
`;
}

agentGuideRoutes.get("/public/agent-guide", (c) =>
  c.body(agentGuide(apiBase(c)), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  }));

// ─── MCP (streamable HTTP, stateless) ────────────────────────────────────

const MCP_PROTOCOL = "2025-06-18";

const MCP_TOOLS = [
  {
    name: "evabob_pay",
    description:
      "Call a URL and pay for it from the Evabob agent wallet if it asks for an x402 payment (HTTP 402, USDC on Arc). " +
      "Returns the seller's response, what it cost, and a code when the payment was refused. Free URLs are just fetched. " +
      "Use evabob_find_services first if you do not have a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The HTTPS resource to call and pay for." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Default GET." },
        body: { description: "Body for non-GET calls: a JSON value or a string." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Headers for the seller." },
        maxAmountUsdc: { type: "number", description: "Refuse if the seller asks for more than this many USDC." },
        idempotencyKey: {
          type: "string",
          description: "16-100 characters. Reuse to retry the same payment (for example after APPROVAL_PENDING).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "evabob_wallet",
    description:
      "The agent wallet's balance, its allowance, what is left this period, and whether it is paused. Call this before spending or when a payment is refused.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evabob_find_services",
    description:
      "Search for paid services this wallet can pay: Evabob paywalls and Circle's x402 catalog on this network. Returns URLs, methods and prices to use with evabob_pay.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match, e.g. \"rpc\", \"weather\", \"search\". Empty lists everything." },
        limit: { type: "number", description: "At most this many (default 20, up to 50)." },
      },
    },
  },
] as const;

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function rpcError(id: RpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function callTool(agent: AgentWallet, name: string, args: Record<string, unknown>) {
  if (name === "evabob_pay") {
    const parsed = payBody.extend({ url: z.string().url() }).safeParse(args);
    if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`, true);
    const result = await runAgentPay(agent, parsed.data);
    return toolText(result, !result.ok && result.code !== "APPROVAL_PENDING");
  }
  if (name === "evabob_wallet") {
    const { allowanceView } = await import("../services/agentControls.js");
    const view = allowanceView(agent);
    return toolText({
      label: agent.label,
      handle: agent.handle ? `@${agent.handle}` : null,
      balanceUsdc: agent.balanceUsdc,
      network: `eip155:${config.arc.chainId}`,
      allowance: view.allowance,
      meter: view.meter,
      paused: view.paused,
      pauseDetail: view.pauseDetail,
    });
  }
  if (name === "evabob_find_services") {
    const query = typeof args.query === "string" ? args.query : "";
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const items = await findServices(query, limit);
    return toolText(items.length ? { items } : { items, note: "Nothing matched on this network. Any other x402 URL can still be tried with evabob_pay." });
  }
  return toolText(`Unknown tool: ${name}`, true);
}

async function handleRpc(agent: AgentWallet, msg: RpcMessage): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : MCP_PROTOCOL;
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: asked,
          capabilities: { tools: {} },
          serverInfo: { name: "evabob-agent-wallet", title: "Evabob agent wallet", version: "1.0.0" },
          instructions:
            `This is the Evabob agent wallet "${agent.label}". Use evabob_pay to call paid (x402) URLs; ` +
            "the owner's allowance applies. If a payment answers APPROVAL_PENDING, the owner is being asked on their phone: " +
            "wait and retry with the same idempotencyKey. If it answers AGENT_PAUSED or LOOP_BREAKER, stop and tell the user.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments && typeof msg.params.arguments === "object"
        ? msg.params.arguments
        : {}) as Record<string, unknown>;
      try {
        return { jsonrpc: "2.0", id: msg.id, result: await callTool(agent, name, args) };
      } catch (error) {
        return { jsonrpc: "2.0", id: msg.id, result: toolText(error instanceof Error ? error.message : "The call failed", true) };
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized and the like
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

agentMcpRoutes.post("/mcp", async (c) => {
  const auth = getAuth(c);
  const agent = auth.principal === "agent" && auth.agentId ? store.getAgentById(auth.agentId) : undefined;
  if (!agent) {
    return c.json(rpcError(null, -32001, "Send the agent key as: Authorization: Bearer sk_evabob_…"), 401);
  }
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  const { flushPrimaryStore } = await import("../services/primary-store.js");
  if (Array.isArray(payload)) {
    const answers: object[] = [];
    for (const msg of payload.slice(0, 20)) {
      const answer = await handleRpc(agent, msg as RpcMessage);
      if (answer) answers.push(answer);
    }
    await flushPrimaryStore();
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handleRpc(agent, payload as RpcMessage);
  await flushPrimaryStore();
  return answer ? c.json(answer) : c.body(null, 202);
});

// No server-initiated stream: this server only answers requests.
agentMcpRoutes.get("/mcp", (c) => c.json(rpcError(null, -32000, "Method not allowed"), 405, { Allow: "POST" }));
agentMcpRoutes.delete("/mcp", (c) => c.body(null, 204));

/** Sellers this agent can pay, for agents that speak plain HTTP. */
agentMcpRoutes.get("/services", async (c) => {
  const auth = getAuth(c);
  if (auth.principal !== "agent" || !auth.agentId) {
    return c.json({ error: "API key required", code: "API_KEY_REQUIRED", hint: "Authorization: Bearer sk_evabob_…" }, 401);
  }
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  return c.json({ items: await findServices(c.req.query("query") ?? "", limit) });
});
