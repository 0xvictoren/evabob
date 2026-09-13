/**
 * Groq LLM fallback for the Evabob Agent.
 * Only used when the deterministic parser is unsure.
 * Never executes transfers — returns structured JSON only.
 */

import { config } from "../config.js";
import {
  type AgentIntent,
  type ThreadContext,
  helpText,
  mergeFollowUp,
  parseAgentIntent,
  pendingIntentFromHistory,
  shouldMergeFollowUp,
} from "./intentParser.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM = `You are the evabob Agent (tagline: bob me!). Talk like a helpful payments assistant.

Parse the user's chat message. Return JSON only.

Supported intents: send, bridge, buy, swap, deposit, escrow, invoice, invoices, balance, activity, help, clarification_needed, chat.
Assets: USDC, EURC, CBTC. Chains: Arc, Base, Ethereum. Default chain is Arc. Default asset is USDC. "$150" means 150 USDC.
Payees are @username, email, or 0x only — never phone, never display name.
If no recipient is given for send/invoice/escrow in the agent thread, to=null and toType=null (ask who).
toType: address | email | handle | thread | null.
Money intents MUST set needsConfirmation=true. Never claim funds moved.
Never guess a bridge destination — if they said "bridge 50" without Base/Ethereum, intent=clarification_needed.
Never treat "send to Base" as a bridge unless they said bridge.
If this is a follow-up (short answer like "@john" or "Ethereum") to your last question, fill the missing field and keep the previous intent.
Always set reply: 1–3 short sentences explaining what you understood, in plain language. For help/chat, actually answer.

Return ONLY a JSON object with:
intent, amount (number or null), asset, chain, to, toType, tokenIn, tokenOut, fromChain, toChain, description, confidence (0-1), needsConfirmation, clarification, reply`;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function mergeLlm(base: AgentIntent, parsed: Record<string, unknown>): AgentIntent {
  const intent = String(parsed.intent || base.intent) as AgentIntent["intent"];
  const allowed: AgentIntent["intent"][] = [
    "send",
    "bridge",
    "buy",
    "swap",
    "deposit",
    "escrow",
    "invoice",
    "balance",
    "activity",
    "help",
    "invoices",
    "clarification_needed",
    "chat",
  ];
  const safeIntent = allowed.includes(intent) ? intent : "clarification_needed";
  const money = ["send", "bridge", "buy", "swap", "deposit", "escrow", "invoice"].includes(
    safeIntent,
  );
  return {
    ...base,
    intent: safeIntent,
    amount: asNumber(parsed.amount) ?? base.amount,
    asset: (parsed.asset as AgentIntent["asset"]) || base.asset,
    chain: (parsed.chain as AgentIntent["chain"]) || base.chain,
    to: (parsed.to as string | null) ?? base.to,
    toType: (parsed.toType as AgentIntent["toType"]) ?? base.toType,
    tokenIn: (parsed.tokenIn as AgentIntent["tokenIn"]) || base.tokenIn,
    tokenOut: (parsed.tokenOut as AgentIntent["tokenOut"]) || base.tokenOut,
    fromChain: (parsed.fromChain as AgentIntent["fromChain"]) || base.fromChain,
    toChain: (parsed.toChain as AgentIntent["toChain"]) || base.toChain,
    recipients: Array.isArray(parsed.recipients)
      ? (parsed.recipients as string[])
      : base.recipients,
    description:
      typeof parsed.description === "string"
        ? parsed.description
        : base.description,
    confidence: Math.min(
      0.93,
      Math.max(
        0,
        typeof parsed.confidence === "number" ? parsed.confidence : base.confidence,
      ),
    ),
    needsConfirmation: money ? true : Boolean(parsed.needsConfirmation),
    clarification:
      typeof parsed.clarification === "string"
        ? parsed.clarification
        : base.clarification,
    reply:
      typeof parsed.reply === "string"
        ? parsed.reply
        : safeIntent === "help"
          ? helpText()
          : base.reply,
  };
}

export function groqConfigured(): boolean {
  return Boolean(config.groq.apiKey);
}

function templateReply(intent: AgentIntent): string {
  if (intent.reply) return intent.reply;
  if (intent.clarification) return intent.clarification;
  const amt =
    intent.amount != null ? `${intent.amount} ${intent.asset}` : intent.asset;
  switch (intent.intent) {
    case "send":
      return intent.to
        ? `I'll send ${amt} on ${intent.chain} to ${intent.to}. Confirm and I'll ask for your PIN.`
        : `I can send ${amt} on ${intent.chain}. Who should receive it (@username, email, or 0x)?`;
    case "bridge":
      return intent.toChain
        ? `I'll bridge ${amt} from ${intent.fromChain || intent.chain} to ${intent.toChain}. Confirm before PIN.`
        : "Bridge to Base or Ethereum? I won't pick a chain for you.";
    case "buy":
    case "swap":
      return `${intent.intent === "buy" ? "Buy" : "Swap"} ${amt} (${intent.tokenIn || "USDC"} → ${intent.tokenOut || "EURC"}) on Arc. Confirm to continue.`;
    case "deposit":
      return `Deposit ${amt} into unified balance from ${intent.chain}. Confirm to continue.`;
    case "escrow":
    case "invoice":
      return `${intent.intent === "invoice" ? "Invoice" : "Escrow"} for ${amt}. Confirm to continue.`;
    case "balance":
      return "I'll pull your balances.";
    case "activity":
      return "I'll pull your recent transactions.";
    case "invoices":
      return "I'll check your invoices.";
    case "help":
      return helpText();
    default:
      return helpText();
  }
}

export async function refineAgentIntent(
  message: string,
  threadContext?: ThreadContext,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<AgentIntent> {
  let deterministic = parseAgentIntent(message, threadContext);
  const pending = pendingIntentFromHistory(history, message, threadContext);
  if (pending && shouldMergeFollowUp(message, deterministic, pending)) {
    deterministic = mergeFollowUp(pending, message);
  }
  const locked =
    deterministic.confidence >= 0.75 &&
    deterministic.intent !== "clarification_needed";

  if (!config.groq.apiKey) {
    return { ...deterministic, reply: templateReply(deterministic) };
  }

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groq.apiKey}`,
      },
      body: JSON.stringify({
        model: config.groq.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          ...(history || []).slice(-8),
          {
            role: "user",
            content: JSON.stringify({
              message,
              threadContext: threadContext || {},
              deterministicHint: deterministic,
            }),
          },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[agent-llm] groq", res.status, errText.slice(0, 180));
      return { ...deterministic, reply: templateReply(deterministic) };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = mergeLlm(deterministic, parsed);
    if (locked) {
      return {
        ...deterministic,
        reply:
          typeof parsed.reply === "string" && parsed.reply.trim()
            ? parsed.reply.trim()
            : templateReply(deterministic),
        clarification: deterministic.clarification,
      };
    }
    return { ...merged, reply: merged.reply || templateReply(merged) };
  } catch (e) {
    console.warn(
      "[agent-llm] fallback deterministic:",
      e instanceof Error ? e.message : e,
    );
    return { ...deterministic, reply: templateReply(deterministic) };
  }
}
