/**
 * Checks, against Circle's live testnet facilitator, that the payment terms a
 * paywall offers are ones Circle will accept — without moving any money.
 *
 * A funded agent wallet signs a payment for the terms; Circle is asked to
 * *verify* it and never to settle it. The signed payment is made out to the
 * ops signer (Evabob's own address) and discarded, so nobody can ever take
 * it. Writes nothing to the store.
 *
 *   npx tsx src/scripts/check-paywall-terms.ts <agentId> [priceUsdc]
 */
import { readFileSync } from "node:fs";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { circleBatchSigner } from "../services/agentWallet.js";
import { acceptedMatches, requirementFor, verifyWithCircle, type Paywall } from "../services/paywalls.js";
import { validateArcBatchRequirement } from "../services/nanopay.js";

const [agentId, priceArg] = process.argv.slice(2);
if (!agentId) throw new Error("usage: check-paywall-terms.ts <agentId> [priceUsdc]");
const db = JSON.parse(readFileSync("data/evabob-db.json", "utf8")) as {
  agents: Array<{ id: string; circleWalletId?: string; custodyAddress?: string }>;
};
const agent = db.agents.find((a) => a.id === agentId);
if (!agent?.circleWalletId || !agent.custodyAddress) throw new Error("That agent has no Circle wallet");

const opsAddress = privateKeyToAccount(config.arc.privateKey as `0x${string}`).address;
const paywall = { priceUsdc: Number(priceArg ?? "0.01") } as Paywall;
const requirement = requirementFor(paywall, opsAddress);

// 1. The payer's own checks accept Evabob's terms.
const cost = validateArcBatchRequirement(requirement as never, 2);
console.log(`[check] terms pass the payer's validation: $${cost}`);

// 2. The agent's Circle-held key signs them.
const scheme = new BatchEvmScheme(
  circleBatchSigner({ walletId: agent.circleWalletId, address: agent.custodyAddress as `0x${string}` }) as never,
);
const created = await scheme.createPaymentPayload(2, requirement as never);
const payload = {
  ...(created as Record<string, unknown>),
  resource: { url: "http://localhost:8787/x/check", description: "Terms check", mimeType: "application/json" },
  accepted: requirement,
};
console.log(`[check] signed by ${agent.custodyAddress}; matches the paywall's terms: ${acceptedMatches(payload, requirement)}`);

// 3. Circle verifies it. Deliberately never settled.
const verified = await verifyWithCircle(payload, requirement);
console.log(`[check] Circle verify: ${JSON.stringify(verified)}`);
