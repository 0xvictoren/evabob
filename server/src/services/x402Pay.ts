import { createHash } from "node:crypto";
import { config } from "../config.js";
import { store, type AgentWallet } from "../store/db.js";
import { flushPrimaryStore } from "./primary-store.js";
import { safeAgentGet } from "./safe-agent-http.js";

export type X402PayResult = {
  ok: boolean;
  status?: number;
  costUsdc: number;
  paid: boolean;
  body?: unknown;
  error?: string;
  payment?: { payTo?: string; amountUsdc?: number; network?: string; rail?: string };
  agentId?: string;
  reconciliationRequired?: boolean;
};

export function findAgentByApiKey(rawKey: string): AgentWallet | undefined {
  const key = rawKey.trim();
  if (!key.startsWith("sk_evabob_") && !key.startsWith("sk_sendit_")) return undefined;
  const hash = createHash("sha256").update(key).digest("hex");
  return store.findAgentByApiKeyHash(hash);
}

function allowedOrigins(): string[] {
  return [...config.agents.resourceOrigins];
}

function paidReady(agent: AgentWallet): string | null {
  if (agent.revokedAt) return "Agent key revoked";
  if (agent.custodyMode !== "circle-eoa" || !agent.circleWalletId || !agent.custodyAddress) {
    return "This legacy agent needs migration to a dedicated Circle EOA";
  }
  if (!agent.gatewayDeposits?.some((row) => row.status === "ready")) {
    return "Fund and finalize this agent's Gateway deposit before paying";
  }
  return null;
}

export async function x402PayForAgent(input: {
  agent: AgentWallet;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  maxAmountUsdc?: number;
  idempotencyKey?: string;
}): Promise<X402PayResult> {
  const base = { costUsdc: 0, paid: false, agentId: input.agent.id };
  if (input.agent.revokedAt) return { ...base, ok: false, error: "Agent key revoked" };
  if ((input.method || "GET").toUpperCase() !== "GET" || input.body != null ||
      Object.keys(input.headers || {}).length) {
    return { ...base, ok: false, error: "Agent resources currently support GET without caller-supplied headers" };
  }

  const origins = allowedOrigins();
  const readiness = paidReady(input.agent);
  if (readiness) {
    try {
      const response = await safeAgentGet(input.url, origins);
      if (response.status !== 402) {
        return {
          ...base,
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          body: response.text,
        };
      }
    } catch (error) {
      return { ...base, ok: false, error: error instanceof Error ? error.message : "Discovery failed" };
    }
    return { ...base, ok: false, status: 402, error: `${readiness}. No funds were spent.` };
  }

  // Gateway is the source of truth for what can be authorized. Reconcile a
  // stale local balance downward before applying policy; never increase it
  // here because an unverified external deposit must not create ledger funds.
  try {
    const { fetchGatewayBalances } = await import("./gateway.js");
    const remote = await fetchGatewayBalances(input.agent.custodyAddress as `0x${string}`);
    if (remote.totalUsdc + 0.000001 < input.agent.balanceUsdc) {
      input.agent.balanceUsdc = Number(remote.totalUsdc.toFixed(6));
      store.save();
      await flushPrimaryStore();
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: `Could not verify the agent's Gateway balance: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const key = input.idempotencyKey?.trim() || "";
  const prior = input.agent.paymentHistory?.find((row) => row.key === key);
  if (prior) {
    if (prior.url !== input.url) {
      return { ...base, ok: false, error: "Idempotency key was used for another resource" };
    }
    return {
      ...base,
      ok: prior.status === "settled",
      paid: prior.status === "settled",
      costUsdc: prior.amountUsdc,
      status: prior.httpStatus,
      error: prior.status === "settled" ? undefined :
        `Payment is ${prior.status}; do not retry with a new key until reconciled`,
      reconciliationRequired: prior.status === "authorized" || prior.status === "ambiguous",
    };
  }

  let reserved = false;
  const { nanopay } = await import("./nanopay.js");
  const outcome = await nanopay({
    walletId: input.agent.circleWalletId!,
    address: input.agent.custodyAddress as `0x${string}`,
    url: input.url,
    allowedOrigins: origins,
    async authorize(costUsdc) {
      if (!key || key.length < 16 || key.length > 100) {
        return "A 16-100 character idempotency key is required before payment";
      }
      if (!(costUsdc > 0) || !/^\d+(\.\d{1,6})?$/.test(String(costUsdc))) {
        return "Seller returned an invalid USDC price";
      }
      if (input.maxAmountUsdc != null && costUsdc > input.maxAmountUsdc) {
        return "Seller price exceeds the caller's maximum";
      }
      const day = new Date().toISOString().slice(0, 10);
      const userSpent = store.listAgents(input.agent.userId).reduce(
        (sum, agent) => sum + (agent.spentDay === day ? agent.spentTodayUsdc : 0),
        0,
      );
      if (userSpent + costUsdc > config.agents.maxUserDailySpendUsdc) {
        return "Payment exceeds the owner's total daily agent limit";
      }
      try {
        const reservation = store.reserveAgentPayment(input.agent, {
          key,
          url: input.url,
          amountUsdc: costUsdc,
        });
        if (!reservation.fresh) return `Payment is already ${reservation.payment.status}`;
        reserved = true;
        await flushPrimaryStore();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "Payment policy rejected";
      }
    },
    async onAuthorized() {
      store.updateAgentPayment(input.agent, key, { status: "authorized" });
      await flushPrimaryStore();
    },
  });

  if (reserved) {
    if (outcome.authorizationCreated) {
      store.updateAgentPayment(input.agent, key, {
        status: outcome.paid ? "settled" : "ambiguous",
        httpStatus: outcome.status,
        error: outcome.error,
      });
    } else {
      store.releaseAgentPayment(input.agent, key, outcome.error || "Authorization was not created");
    }
    await flushPrimaryStore();
  }

  return {
    ...outcome,
    agentId: input.agent.id,
    payment: outcome.payment ? { ...outcome.payment, rail: "circle-gateway-batching" } : undefined,
    reconciliationRequired: reserved && Boolean(outcome.authorizationCreated && !outcome.paid),
  };
}

export async function x402DiscoverAndPay(input: {
  agent: AgentWallet;
  query: string;
  resourceUrl?: string;
}): Promise<X402PayResult> {
  const base = { costUsdc: 0, paid: false, agentId: input.agent.id };
  if (input.agent.revokedAt) return { ...base, ok: false, error: "Agent key revoked" };
  if (input.resourceUrl) return x402PayForAgent({ agent: input.agent, url: input.resourceUrl });
  const { discoverResources } = await import("./circle-x402.js");
  const endpoints = await discoverResources(input.query, 3);
  return {
    ...base,
    ok: true,
    body: { mode: "discovery", endpoints, message: "Discovery is free; paid calls require a funded dedicated agent EOA." },
  };
}
