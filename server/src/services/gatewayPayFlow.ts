/**
 * Paying someone from the GA (Gateway unified balance): planning, sending,
 * and recording — shared by the Pay route and by the tracker, which sends
 * payments that had to wait for an approval to become final.
 *
 * The person approves Evabob once per network (a PIN). Circle only honours
 * that approval once it is final on that chain — about 15 minutes on
 * Ethereum and Base Sepolia — so a payment made right after approving used
 * to fail with "Signer is not authorized". Now it is scheduled instead, and
 * goes through by itself as soon as the approval is final.
 */

import type { Address } from "viem";
import { formatUnits } from "viem";
import { store } from "../store/db.js";
import { jsonSafe } from "../utils/json-safe.js";
import { feeActivityFields, quotePlatformFee } from "./platformFee.js";

export async function planGatewayPayment(input: {
  depositor: Address;
  amountUsdc: number;
  destinationDomain: number;
  sourceDomain?: number;
}) {
  const { getGatewayPayDelegateAddress, planGatewayPay } = await import("./gateway-e2e.js");
  // The platform fee rides in the same Gateway transfer as its own burn
  // intent, so the sources are planned to cover amount + fee.
  const feeQuote = quotePlatformFee(input.amountUsdc, 6);
  const delegate = getGatewayPayDelegateAddress();
  const plan = await planGatewayPay({
    depositor: input.depositor,
    amountUsdc: Number(formatUnits(feeQuote.totalUnits, 6)),
    destinationDomain: input.destinationDomain,
    sourceDomain: input.sourceDomain,
    delegate,
  });
  return { plan, feeQuote, delegate };
}

/**
 * Sends a planned GA payment and records it. When [activityId] is given (a
 * scheduled payment) that row is updated instead of a new one being added.
 */
export async function sendGatewayPayment(input: {
  userId: string;
  depositor: Address;
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDomain?: number;
  slices: import("./gateway-e2e.js").GatewaySourceSlice[];
  enableForwarder?: boolean;
  activityId?: string;
}): Promise<{ httpStatus: 200 | 202; body: Record<string, unknown>; landed: boolean }> {
  const { gatewayPayFromUserDepositor } = await import("./gateway-e2e.js");
  const feeQuote = quotePlatformFee(input.amountUsdc, 6);
  const platformFee =
    feeQuote.feeUnits > 0n && feeQuote.recipient
      ? { units: feeQuote.feeUnits, recipient: feeQuote.recipient }
      : undefined;
  const result = await gatewayPayFromUserDepositor({
    depositor: input.depositor,
    amountUsdc: input.amountUsdc,
    destinationDomain: input.destinationDomain,
    destinationAddress: input.destinationAddress,
    sourceDomain: input.sourceDomain,
    enableForwarder: input.enableForwarder ?? true,
    slices: input.slices,
    platformFee,
  });
  const feeFields = feeActivityFields(feeQuote, "USDC");
  const to = `${input.destinationAddress.slice(0, 6)}…${input.destinationAddress.slice(-4)}`;

  if (!(result.status === "complete" && result.mintTx)) {
    // Not landed inside this request. Record it — with the attestation, so
    // the tracker can still mint it from the ops wallet while it is valid —
    // and show it as on its way.
    const description = `${input.amountUsdc} USDC to ${to} · on its way`;
    const activityId = input.activityId
      ? (store.updateActivity(input.activityId, { description, txHash: result.transferId }), input.activityId)
      : store.addActivity({
          userId: input.userId,
          kind: "withdraw",
          title: "Paid from your GA",
          description,
          amountUsdc: -input.amountUsdc,
          token: "USDC",
          amountToken: input.amountUsdc,
          txHash: result.transferId,
          status: "pending",
          receiver: input.destinationAddress,
          mode: "gateway_pay",
          ...feeFields,
        }).id;
    const gw = (result.gatewayResponse ?? {}) as { attestation?: string; signature?: string };
    const { trackGatewayPay } = await import("./gatewayTracker.js");
    const paymentId = trackGatewayPay({
      userId: input.userId,
      transferId: result.transferId,
      attestation: typeof gw.attestation === "string" ? gw.attestation : undefined,
      signature: typeof gw.signature === "string" ? gw.signature : undefined,
      destinationDomain: input.destinationDomain,
      destinationAddress: input.destinationAddress,
      amountUsdc: input.amountUsdc,
      activityId,
    });
    return {
      httpStatus: 202,
      landed: false,
      body: jsonSafe({
        ...result,
        ok: false,
        doNotRetry: true,
        mode: "user_gateway_pay",
        status: "in_transit",
        paymentId,
        error: "Sent — it is on its way. We will tell you when it arrives.",
        // The attestation stays on the server, which finishes the mint.
        gatewayResponse: undefined,
      }) as Record<string, unknown>,
    };
  }

  const srcNote = (result.sources || []).map((s) => `${s.amountUsdc} ${s.name}`).join(" + ");
  const description = `${input.amountUsdc} USDC${srcNote ? ` (from ${srcNote})` : ""} → ${to}`;
  if (input.activityId) {
    store.updateActivity(input.activityId, {
      description,
      txHash: result.mintTx || result.transferId,
      status: "completed",
    });
  } else {
    store.addActivity({
      userId: input.userId,
      kind: "withdraw",
      title: "Paid from your GA",
      description,
      amountUsdc: -input.amountUsdc,
      txHash: result.mintTx || result.transferId,
      status: "completed",
      receiver: input.destinationAddress,
      ...feeFields,
    });
  }
  return {
    httpStatus: 200,
    landed: true,
    body: jsonSafe({ ok: true, mode: "user_gateway_pay", ...result }) as Record<string, unknown>,
  };
}
