/**
 * Circle Nanopayments — real x402 settlement for agent wallets.
 *
 * This replaces a homemade scheme that sent an ordinary USDC transfer and then
 * attached invented headers (`X-PAYMENT: <txHash>`) as proof. No x402 seller
 * recognises that, so the agent paid and was still refused.
 *
 * The real protocol, per Circle Gateway Nanopayments:
 *   1. Probe the resource. A paid one answers 402 with a PAYMENT-REQUIRED
 *      header describing what it accepts.
 *   2. Sign an EIP-3009 authorization offchain — no transaction, no gas —
 *      against the GatewayWallet contract rather than USDC directly.
 *   3. Retry with `Payment-Signature: base64(JSON)`. The seller verifies the
 *      signature and serves immediately.
 *   4. Gateway batches many authorizations and settles net positions onchain,
 *      which is what makes sub-cent payments viable.
 *
 * Spending is bounded before anything is signed: an authorization cannot be
 * recalled, so the caps have to gate the signature, not the settlement.
 */

import {
  BatchEvmScheme,
  CHAIN_CONFIGS,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
} from "@circle-fin/x402-batching/client";
import { supportsBatching } from "@circle-fin/x402-batching";
import type { Address } from "viem";
import { circleBatchSigner } from "./agentWallet.js";

export const ARC = CHAIN_CONFIGS.arcTestnet;

type PaymentRequirements = Record<string, unknown> & {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type NanopayOutcome = {
  ok: boolean;
  /** HTTP status of the final (paid) response, when one was made. */
  status?: number;
  /** USDC actually authorized. 0 when nothing was paid. */
  costUsdc: number;
  paid: boolean;
  /** True once a spendable authorization was disclosed to the seller. */
  authorizationCreated?: boolean;
  body?: unknown;
  error?: string;
  /** Which network and recipient the authorization was made out to. */
  payment?: { network?: string; payTo?: string; amountUsdc?: number };
};

/** Reads the 402's requirements from the header, falling back to the body. */
function parsePaymentRequired(
  headers: Record<string, string>,
  text: string,
): { x402Version: number; accepts: PaymentRequirements[] } {
  const header = headers["payment-required"];

  const decode = (raw: string): unknown => {
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    } catch {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  };

  const parsed = (header ? decode(header) : null) ?? (text ? decode(text) : null);
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;

  const accepts = Array.isArray(obj.accepts)
    ? (obj.accepts as PaymentRequirements[])
    : Array.isArray(obj.paymentRequirements)
      ? (obj.paymentRequirements as PaymentRequirements[])
      : [];

  // Gateway requires x402 version 2; honour whatever the seller declares.
  const x402Version = Number(obj.x402Version ?? 2) || 2;
  return { x402Version, accepts };
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;

/**
 * Validate the fields the batching SDK will actually sign. The seller owns
 * this document, so checking a legacy price field while signing `amount`
 * would let those values differ and bypass the policy limit.
 */
export function validateArcBatchRequirement(
  requirement: PaymentRequirements,
  x402Version: number,
): number {
  if (x402Version !== 2) throw new Error("Only x402 version 2 is supported");
  if (requirement.scheme !== "exact") throw new Error("Payment scheme must be exact");
  if (requirement.network !== `eip155:${ARC.chain.id}`) {
    throw new Error("Payment must settle on Arc testnet");
  }
  if (requirement.asset?.toLowerCase() !== ARC.usdc.toLowerCase()) {
    throw new Error("Payment asset must be Arc USDC");
  }
  if (!requirement.payTo || !ADDRESS.test(requirement.payTo) || ZERO_ADDRESS.test(requirement.payTo)) {
    throw new Error("Payment recipient is invalid");
  }
  if (requirement.extra?.verifyingContract?.toString().toLowerCase() !==
      ARC.gatewayWallet.toLowerCase()) {
    throw new Error("Payment must use Circle Gateway batching");
  }
  if (!Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
      Number(requirement.maxTimeoutSeconds) <= 0 ||
      Number(requirement.maxTimeoutSeconds) > GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS) {
    throw new Error("Payment authorization timeout is invalid");
  }

  const raw = requirement.amount;
  const atomic = typeof raw === "number"
    ? Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : ""
    : typeof raw === "string" && /^\d+$/.test(raw) ? raw : "";
  if (!atomic) throw new Error("Seller returned an invalid atomic USDC amount");
  const units = BigInt(atomic);
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Seller returned an unsupported USDC amount");
  }
  if (requirement.maxAmountRequired != null &&
      String(requirement.maxAmountRequired) !== atomic) {
    throw new Error("Seller returned conflicting payment amounts");
  }
  return Number(units) / 1e6;
}

/**
 * Pays for `url` from an agent's Gateway balance.
 *
 * `authorize` is called with the resolved price before signing and must return
 * an error string to refuse. The caller owns policy — balance, per-call and
 * daily caps — because only it knows the agent's ledger.
 */
export async function nanopay(input: {
  walletId: string;
  address: Address;
  url: string;
  allowedOrigins: string[];
  authorize: (costUsdc: number) => Promise<string | null>;
  onAuthorized: () => Promise<void>;
}): Promise<NanopayOutcome> {
  // 1. Probe.
  let res: { status: number; text: string; headers: Record<string, string> };
  let text: string;
  try {
    const { safeAgentGet } = await import("./safe-agent-http.js");
    res = await safeAgentGet(input.url, input.allowedOrigins);
    text = res.text;
  } catch (e) {
    return {
      ok: false,
      costUsdc: 0,
      paid: false,
      error: e instanceof Error ? e.message : "request failed",
    };
  }

  // Not a paid resource — hand back what it said.
  if (res.status !== 402) {
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      costUsdc: 0,
      paid: false,
      body,
      error: res.status >= 200 && res.status < 300 ? undefined : `HTTP ${res.status}`,
    };
  }

  // 2. Work out what it accepts, and pick a batched option.
  const { x402Version, accepts } = parsePaymentRequired(res.headers, text);
  if (accepts.length === 0) {
    return {
      ok: false,
      costUsdc: 0,
      paid: false,
      error: "Seller returned 402 without usable payment requirements",
    };
  }

  const candidates = accepts.filter((r) => supportsBatching(r as never));
  let requirement: PaymentRequirements | undefined;
  let costUsdc = 0;
  let validationError = "";
  for (const candidate of candidates) {
    try {
      costUsdc = validateArcBatchRequirement(candidate, x402Version);
      requirement = candidate;
      break;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!requirement) {
    return {
      ok: false,
      costUsdc: 0,
      paid: false,
      error:
        validationError ||
        "This resource does not accept a valid Arc Circle Gateway batched payment.",
      payment: { network: accepts[0]?.network },
    };
  }

  // 3. Enforce policy BEFORE signing. A signed authorization is spendable.
  const refusal = await input.authorize(costUsdc);
  if (refusal) {
    return {
      ok: false,
      costUsdc,
      paid: false,
      error: refusal,
      payment: {
        network: requirement.network,
        payTo: requirement.payTo,
        amountUsdc: costUsdc,
      },
    };
  }

  // 4. Sign offchain via Circle's MPC-held key.
  let paymentPayload: Record<string, unknown>;
  try {
    const scheme = new BatchEvmScheme(
      circleBatchSigner({ walletId: input.walletId, address: input.address }) as never,
    );
    const created = await scheme.createPaymentPayload(
      x402Version,
      requirement as never,
    );
    // The seller reads `accepted` to know which option was taken.
    paymentPayload = { ...created, accepted: requirement };
    await input.onAuthorized();
  } catch (e) {
    return {
      ok: false,
      costUsdc,
      paid: false,
      error: `Could not sign the payment authorization: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // 5. Retry with the authorization attached.
  const encoded = Buffer.from(JSON.stringify(paymentPayload), "utf-8").toString(
    "base64",
  );
  try {
    const { safeAgentGet } = await import("./safe-agent-http.js");
    const paidRes = await safeAgentGet(input.url, input.allowedOrigins, {
      "Payment-Signature": encoded,
    });
    const paidText = paidRes.text;
    let body: unknown = paidText;
    try {
      body = JSON.parse(paidText);
    } catch {
      /* keep as text */
    }
    return {
      ok: paidRes.status >= 200 && paidRes.status < 300,
      status: paidRes.status,
      // Only treat it as spent when the seller accepted the authorization.
      costUsdc,
      paid: paidRes.status >= 200 && paidRes.status < 300,
      authorizationCreated: true,
      body,
      error: paidRes.status >= 200 && paidRes.status < 300 ? undefined : `HTTP ${paidRes.status} after payment`,
      payment: {
        network: requirement.network,
        payTo: requirement.payTo,
        amountUsdc: costUsdc,
      },
    };
  } catch (e) {
    return {
      ok: false,
      costUsdc,
      paid: false,
      authorizationCreated: true,
      error: `Paid request failed: ${e instanceof Error ? e.message : String(e)}`,
      payment: {
        network: requirement.network,
        payTo: requirement.payTo,
        amountUsdc: costUsdc,
      },
    };
  }
}
