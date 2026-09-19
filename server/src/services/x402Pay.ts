import { createHash } from "node:crypto";
import { config } from "../config.js";
import { store, type AgentWallet } from "../store/db.js";
import { allowanceOf, decide, describeAllowance, noteCall, type RefusalCode } from "./agentAllowance.js";
import {
  findApproval,
  liveMeter,
  pushAgentUpdate,
  requestApproval,
  tripLoopBreaker,
} from "./agentControls.js";
import {
  cameBackFrom,
  evidenceForPayment,
  judgeResponse,
  recordEvidence,
  recordOutcome,
  type EvidenceBundle,
  type Verdict,
} from "./agentEvidence.js";
import { sellerFor, type Seller } from "./agentMarketplace.js";
import type { Fetcher } from "./nanopay.js";
import { alertUser } from "./notifyUser.js";
import { onSaleOutcome } from "./paywalls.js";
import { flushPrimaryStore } from "./primary-store.js";
import { safeAgentGet } from "./safe-agent-http.js";

export type X402PayResult = {
  ok: boolean;
  status?: number;
  costUsdc: number;
  paid: boolean;
  body?: unknown;
  error?: string;
  /** Why it was refused, for software to act on without parsing words. */
  code?: RefusalCode | "LOOP_BREAKER" | "APPROVAL_PENDING" | "NOT_CHARGED" | "PAID_NOT_DELIVERED";
  payment?: { payTo?: string; amountUsdc?: number; network?: string; rail?: string };
  agentId?: string;
  reconciliationRequired?: boolean;
  /** Above the owner's limit: retry with the same idempotency key once approved. */
  approval?: { id: string; status: string; expiresAt: string };
  /** The seller holds the money until the response checks out. */
  settlement?: "proof" | "direct";
  evidenceId?: string;
};

export function findAgentByApiKey(rawKey: string): AgentWallet | undefined {
  const key = rawKey.trim();
  if (!key.startsWith("sk_evabob_") && !key.startsWith("sk_sendit_")) return undefined;
  const hash = createHash("sha256").update(key).digest("hex");
  return store.findAgentByApiKeyHash(hash);
}

/** Exact origins plus, when configured, Circle's payable catalog origins. */
async function allowedOrigins(): Promise<string[]> {
  const { resolvedAgentOrigins } = await import("./circle-x402.js");
  return resolvedAgentOrigins();
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

/**
 * An Evabob paywall answered in-process: the same code that serves software
 * over HTTP, without leaving the server — and without the SSRF guard, which
 * exists to stop requests reaching internal hosts, not this one.
 */
function paywallFetcher(paywallId: string, buyer: { agentId: string; paymentKey: string }): Fetcher {
  return async (url, headers = {}) => {
    const { handlePaywallRequest } = await import("./paywalls.js");
    const query = (() => {
      try {
        return new URL(url).search.replace(/^\?/, "");
      } catch {
        return "";
      }
    })();
    const res = await handlePaywallRequest({
      id: paywallId,
      query,
      paymentSignature: headers["Payment-Signature"] ?? headers["payment-signature"] ?? null,
      buyer,
    });
    return { status: res.status, text: res.body, headers: res.headers };
  };
}

function ownerHandle(agent: AgentWallet): string {
  const owner = store.getUser(agent.userId);
  return owner?.handle ? `@${owner.handle}` : owner?.email || agent.userId;
}

function authorisedPart(
  agent: AgentWallet,
  tier: "silent" | "approved",
  approval: { id: string; decidedAt?: string } | null,
  remainingBeforeUsdc: number,
): EvidenceBundle["authorised"] {
  return {
    owner: ownerHandle(agent),
    agent: { id: agent.id, label: agent.label, handle: agent.handle ? `@${agent.handle}` : null },
    allowance: describeAllowance(allowanceOf(agent)),
    tier,
    approval: approval ? { id: approval.id, decidedAt: approval.decidedAt ?? null } : null,
    remainingBeforeUsdc,
    at: new Date().toISOString(),
  };
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
  const agent = input.agent;
  const base = { costUsdc: 0, paid: false, agentId: agent.id };
  if (agent.revokedAt) return { ...base, ok: false, error: "Agent key revoked" };
  if ((input.method || "GET").toUpperCase() !== "GET" || input.body != null ||
      Object.keys(input.headers || {}).length) {
    return { ...base, ok: false, error: "Agent resources currently support GET without caller-supplied headers" };
  }

  // Stopped means stopped: before any request, free or paid.
  if (agent.pausedAt) {
    return {
      ...base,
      ok: false,
      code: "AGENT_PAUSED",
      error: agent.pauseReason === "loop"
        ? `This agent is paused: ${agent.pauseDetail ?? "it repeated one call too often"}. Its owner can resume it.`
        : "This agent is paused by its owner.",
    };
  }

  // The loop breaker counts every call, because a runaway loop is expensive
  // long before any one call is.
  const loop = noteCall(agent.id, input.url);
  if (loop.trip) {
    tripLoopBreaker(agent, loop.endpoint, loop.count);
    await flushPrimaryStore();
    return {
      ...base,
      ok: false,
      code: "LOOP_BREAKER",
      error: `Paused: this agent called the same endpoint ${loop.count} times in a minute. Its owner has been told and can resume it.`,
    };
  }

  const seller = await sellerFor(input.url);
  if (!seller) {
    return {
      ...base,
      ok: false,
      code: "NOT_ON_LIST",
      error: "This seller is not on the approved list. Only Evabob paywalls and curated marketplace sellers can be paid.",
    };
  }

  const key = input.idempotencyKey?.trim() || "";
  const fetcher = seller.paywallId
    ? paywallFetcher(seller.paywallId, { agentId: agent.id, paymentKey: key })
    : undefined;
  const origins = seller.paywallId ? [] : await allowedOrigins();

  const readiness = paidReady(agent);
  if (readiness) {
    try {
      const response = fetcher ? await fetcher(input.url) : await safeAgentGet(input.url, origins);
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
    const remote = await fetchGatewayBalances(agent.custodyAddress as `0x${string}`);
    if (remote.totalUsdc + 0.000001 < agent.balanceUsdc) {
      agent.balanceUsdc = Number(remote.totalUsdc.toFixed(6));
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

  const prior = agent.paymentHistory?.find((row) => row.key === key);
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
      settlement: prior.settlement,
      evidenceId: prior.evidenceId,
      error: prior.status === "settled" ? undefined
        : prior.status === "refunded" ? "That call failed its check and was not charged. Use a new key to try again."
          : prior.status === "held" ? "Waiting for the seller to accept. You will not be charged unless they do."
            : `Payment is ${prior.status}; do not retry with a new key until reconciled`,
      reconciliationRequired: prior.status === "authorized" || prior.status === "ambiguous",
    };
  }

  let reserved = false;
  let refusal: { code?: X402PayResult["code"]; approval?: X402PayResult["approval"] } = {};
  let tier: "silent" | "approved" = "silent";
  let usedApproval: { id: string; decidedAt?: string } | null = null;
  let remainingBefore = 0;
  const { nanopay } = await import("./nanopay.js");
  const outcome = await nanopay({
    walletId: agent.circleWalletId!,
    address: agent.custodyAddress as `0x${string}`,
    url: input.url,
    allowedOrigins: origins,
    fetcher,
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
      const userSpent = store.listAgents(agent.userId).reduce(
        (sum, a) => sum + (a.spentDay === day ? a.spentTodayUsdc : 0),
        0,
      );
      if (userSpent + costUsdc > config.agents.maxUserDailySpendUsdc) {
        return "Payment exceeds the owner's total daily agent limit";
      }

      const approval = findApproval(agent, key);
      if (approval?.status === "declined") {
        refusal = { code: "APPROVAL_DECLINED" };
        return "The owner declined this payment.";
      }
      const approved = approval?.status === "approved" &&
        approval.url === input.url && approval.amountUsdc + 1e-9 >= costUsdc;
      remainingBefore = liveMeter(agent).remainingUsdc;
      const verdict = decide({
        allowance: allowanceOf(agent),
        paused: Boolean(agent.pausedAt),
        costUsdc,
        category: seller.category,
        waitsForProof: seller.waitsForProof,
        remainingUsdc: remainingBefore,
        approved,
      });
      if (verdict.tier === "refuse") {
        refusal = { code: verdict.code };
        return verdict.reason;
      }
      if (verdict.tier === "ask") {
        const asked = requestApproval(agent, {
          key,
          url: input.url,
          seller: seller.name,
          category: seller.category,
          amountUsdc: costUsdc,
        });
        await flushPrimaryStore();
        refusal = { code: "APPROVAL_PENDING", approval: { id: asked.id, status: asked.status, expiresAt: asked.expiresAt } };
        return "Above the owner's limit. They have been asked; retry with the same idempotency key once they approve.";
      }
      if (approved && approval) {
        tier = "approved";
        approval.status = "used";
        usedApproval = { id: approval.id, decidedAt: approval.decidedAt };
      }
      try {
        const reservation = store.reserveAgentPayment(agent, {
          key,
          url: input.url,
          amountUsdc: costUsdc,
          remainingUsdc: remainingBefore,
          seller: seller.name,
          category: seller.category,
          settlement: seller.waitsForProof ? "proof" : "direct",
          tier,
          ...(usedApproval ? { approvalId: (usedApproval as { id: string }).id } : {}),
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
      store.updateAgentPayment(agent, key, { status: "authorized" });
      await flushPrimaryStore();
    },
  });

  if (!reserved) {
    return {
      ...outcome,
      agentId: agent.id,
      ...refusal,
      ...(refusal.code === "APPROVAL_PENDING" ? { ok: false, status: 202 } : {}),
      payment: outcome.payment ? { ...outcome.payment, rail: "circle-gateway-batching" } : undefined,
    };
  }

  const result = await finishPayment({
    agent,
    seller,
    key,
    url: input.url,
    outcome,
    tier,
    approval: usedApproval,
    remainingBefore,
  });
  pushAgentUpdate(agent);
  await flushPrimaryStore();
  return result;
}

/**
 * Settles the books for a payment that got as far as a reservation, and
 * writes its evidence bundle.
 *
 *   proof seller, content passed   → settled (the seller took it after the check)
 *   proof seller, content failed   → refunded (never taken; back in the balance)
 *   proof seller, booking accepted later → held until the person answers
 *   direct seller, usable          → settled
 *   direct seller, paid, unusable  → disputed, owner told, evidence to argue with
 *   no authorisation disclosed     → released, as before
 */
async function finishPayment(input: {
  agent: AgentWallet;
  seller: Seller;
  key: string;
  url: string;
  outcome: Awaited<ReturnType<typeof import("./nanopay.js")["nanopay"]>>;
  tier: "silent" | "approved";
  approval: { id: string; decidedAt?: string } | null;
  remainingBefore: number;
}): Promise<X402PayResult> {
  const { agent, seller, key, outcome } = input;
  const settlement: "proof" | "direct" = seller.waitsForProof ? "proof" : "direct";
  const common = {
    agentId: agent.id,
    costUsdc: outcome.costUsdc,
    settlement,
    payment: outcome.payment ? { ...outcome.payment, rail: "circle-gateway-batching" } : undefined,
  };

  if (!outcome.authorizationCreated) {
    store.releaseAgentPayment(agent, key, outcome.error || "Authorization was not created");
    return { ...outcome, ...common, paid: false, reconciliationRequired: false };
  }

  const verdict: Verdict = judgeResponse({
    status: outcome.status,
    contentType: outcome.contentType,
    body: outcome.rawText,
  });

  let status: NonNullable<AgentWallet["paymentHistory"]>[number]["status"];
  let evidenceOutcome: EvidenceBundle["payment"]["outcome"];
  let code: X402PayResult["code"];
  if (settlement === "proof") {
    if (outcome.status === 202) {
      status = "held";
      evidenceOutcome = "unknown";
    } else if (outcome.paid && verdict.usable) {
      status = "settled";
      evidenceOutcome = "paid";
    } else {
      // Evabob is this seller's host and did not take the payment.
      status = "refunded";
      evidenceOutcome = "not_charged";
      code = "NOT_CHARGED";
    }
  } else if (outcome.paid) {
    status = verdict.usable ? "settled" : "disputed";
    evidenceOutcome = verdict.usable ? "paid" : "paid_not_delivered";
    if (!verdict.usable) code = "PAID_NOT_DELIVERED";
  } else {
    status = "ambiguous";
    evidenceOutcome = "unknown";
  }

  const bundle = recordEvidence({
    agentId: agent.id,
    ownerId: agent.userId,
    paymentKey: key,
    authorised: authorisedPart(agent, input.tier, input.approval, input.remainingBefore),
    asked: { method: "GET", url: input.url, at: new Date().toISOString() },
    cameBack: cameBackFrom({
      status: outcome.status,
      contentType: outcome.contentType,
      body: outcome.rawText,
      verdict,
    }),
    payment: {
      amountUsdc: outcome.costUsdc,
      payTo: outcome.payment?.payTo ?? null,
      network: outcome.payment?.network ?? null,
      settlement,
      outcome: evidenceOutcome,
      settleReference: null,
    },
  });

  if (status === "refunded") {
    store.updateAgentPayment(agent, key, { httpStatus: outcome.status, evidenceId: bundle.id });
    store.refundHeldAgentPayment(agent, key, verdict.reason);
  } else {
    store.updateAgentPayment(agent, key, {
      status,
      httpStatus: outcome.status,
      error: status === "settled" || status === "held" ? undefined : outcome.error || verdict.reason,
      evidenceId: bundle.id,
    });
  }

  if (status === "disputed" || status === "ambiguous") {
    alertUser(agent.userId, {
      kind: "agent_payment_issue",
      title: status === "disputed" ? `${agent.label} paid for nothing usable` : `${agent.label}: a payment needs checking`,
      body: status === "disputed"
        ? `${seller.name} took $${outcome.costUsdc} and returned: ${verdict.reason} The evidence is saved if you need to argue it.`
        : `${seller.name} was sent a payment and the answer was unclear. The evidence is saved.`,
      link: `evabob://agents/${agent.id}`,
    });
  }

  return {
    ...outcome,
    ...common,
    ok: status === "settled" || status === "held",
    paid: status === "settled",
    evidenceId: bundle.id,
    ...(code ? { code } : {}),
    error: status === "settled" || status === "held"
      ? undefined
      : status === "refunded"
        ? `${verdict.reason} You were not charged.`
        : outcome.error || verdict.reason,
    reconciliationRequired: status === "ambiguous",
  };
}

/**
 * A booking with a person's time finishes later, when they answer. Their
 * answer settles the agent's held payment or gives it back.
 */
onSaleOutcome((sale, verdict) => {
  if (!sale.buyerAgentId || !sale.buyerPaymentKey) return;
  const agent = store.getAgentById(sale.buyerAgentId);
  const row = agent?.paymentHistory?.find((p) => p.key === sale.buyerPaymentKey);
  if (!agent || !row || row.status !== "held") return;
  const original = row.evidenceId ? evidenceForPayment(agent.id, row.key)[0] : undefined;
  if (sale.status === "settled") {
    store.updateAgentPayment(agent, row.key, { status: "settled" });
    if (original) recordOutcome(original, { outcome: "paid", settleReference: sale.settleReference ?? null });
  } else if (["declined", "expired", "failed", "not_charged"].includes(sale.status)) {
    store.refundHeldAgentPayment(agent, row.key, sale.reason ?? verdict?.reason ?? "The seller did not accept");
    if (original) recordOutcome(original, { outcome: "not_charged" });
  }
  pushAgentUpdate(agent);
  void flushPrimaryStore();
});

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
