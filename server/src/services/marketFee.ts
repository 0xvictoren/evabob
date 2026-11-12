/**
 * The marketplace fee: 1% of a marketplace deal, taken out of the money the
 * buyer pays, and only when the deal succeeds.
 *
 * The buyer pays exactly the invoice total. Of each payment towards a deal:
 *
 *   paid now      99% goes to the seller and 1% to Evabob, in the same wallet
 *                 batch as the payment, under the buyer's one PIN.
 *   set aside     two holds are locked under one PIN: 99% for the seller and
 *                 1% for Evabob's fee account. When the seller's hold is paid
 *                 out, the 1% is paid out too. When the seller's hold goes
 *                 back to the buyer — cancelled, refunded after review,
 *                 expired — the 1% goes back with it.
 *
 * The 1% hold is not a tracked hold of its own: it rides on the seller's
 * record (`marketFee`) and is settled by `runMarketFeeWork` from the
 * scheduled tick, which only ever copies what happened to the seller's hold.
 * Nothing in the release, cancel, review or refund code knows about it.
 *
 * A hold can only be paid to an identity registered on chain, so the fee is
 * collected by an ordinary Evabob account: MARKET_FEE_ACCOUNT (a @handle),
 * or else the account whose wallet is the platform fee recipient. With
 * neither, no marketplace fee is charged and deals work as before.
 *
 * A deal remembers the rate it was made at (`feeBps`), so the seller was
 * shown it before sending the invoice, and older deals are untouched.
 */

import { formatUnits, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { store } from "../store/db.js";
import type { MarketDeal } from "./market.js";
import * as market from "./market.js";
import type { ProtectedEscrowRecord } from "./mongo.js";
import { toUnits } from "./platformFee.js";

export const MARKET_FEE_BPS = 100;

export type MarketFeeAccount = { userId: string; handle: string; address: Address };

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** The Evabob account that collects the fee, or null when there is none. */
export function marketFeeAccount(): MarketFeeAccount | null {
  const named = process.env.MARKET_FEE_ACCOUNT?.trim().replace(/^@/, "");
  const user = named
    ? store.findUserByHandle(named)
    : config.platformFee.recipient
      ? store.listUsers().find((u) =>
          u.handle && u.evmAddress?.toLowerCase() === config.platformFee.recipient.toLowerCase())
      : undefined;
  if (!user?.handle || !user.evmAddress || !ADDRESS.test(user.evmAddress)) return null;
  return { userId: user.id, handle: user.handle, address: user.evmAddress as Address };
}

/** The rate a deal made now would carry: 100 (1%), or 0 with nobody to collect it. */
export function marketFeeBpsNow(): number {
  return marketFeeAccount() ? MARKET_FEE_BPS : 0;
}

/** Splits a payment into the seller's part and the fee, in base units. Pure. */
export function splitMarketFee(grossUnits: bigint, bps: number): { netUnits: bigint; feeUnits: bigint } {
  if (grossUnits <= 0n || !(bps > 0)) return { netUnits: grossUnits, feeUnits: 0n };
  const feeUnits = (grossUnits * BigInt(Math.round(bps))) / 10_000n;
  return { netUnits: grossUnits - feeUnits, feeUnits };
}

const asNumber = (units: bigint) => Number(formatUnits(units, 6));

/**
 * The fee on a payment the buyer is about to make towards a request, or null
 * when none applies: not a marketplace deal, a deal made without a fee, not
 * this deal's buyer paying this deal's seller, or nobody to collect it.
 */
export function marketFeeForPayment(input: {
  requestId: string | undefined;
  payerId: string;
  /** Who the payment is going to, as the route resolved it. */
  payeeUserId: string | undefined;
  amountUsdc: number;
}): { deal: MarketDeal; account: MarketFeeAccount; netUsdc: number; feeUsdc: number; netUnits: bigint; feeUnits: bigint } | null {
  if (!input.requestId) return null;
  const deal = market.dealByRequest(input.requestId);
  if (!deal?.feeBps || deal.buyerId !== input.payerId || deal.sellerId !== input.payeeUserId) return null;
  const account = marketFeeAccount();
  // The fee account buying or selling pays no fee to itself.
  if (!account || account.userId === deal.sellerId || account.userId === deal.buyerId) return null;
  const { netUnits, feeUnits } = splitMarketFee(toUnits(input.amountUsdc, 6), deal.feeBps);
  if (feeUnits <= 0n || netUnits <= 0n) return null;
  return { deal, account, netUnits, feeUnits, netUsdc: asNumber(netUnits), feeUsdc: asNumber(feeUnits) };
}

/**
 * What the seller receives of an amount paid towards a request: less the fee
 * for a marketplace deal that carries one, otherwise the amount itself. Used
 * to check a payment on chain, where either figure is honest — an older app
 * pays the seller in full and no fee is taken.
 */
export function sellerShareOf(requestId: string, amountUsdc: number): number {
  const deal = market.dealByRequest(requestId);
  if (!deal?.feeBps || !(amountUsdc > 0)) return amountUsdc;
  return asNumber(splitMarketFee(toUnits(amountUsdc, 6), deal.feeBps).netUnits);
}

export type MarketFeeHold = NonNullable<ProtectedEscrowRecord["marketFee"]>;

/**
 * Finds the 1% hold among the holds one transaction created: locked by the
 * same wallet as the seller's hold, for the fee account. Pure.
 */
export function feeHoldAmong(
  created: Array<{ transferId: string; amountUsdc: number; recipientKey: Hex; sender: string }>,
  main: { transferId: string; sender: string },
  feeAccountKey: Hex,
): MarketFeeHold | null {
  const fee = created.find((t) =>
    t.transferId !== main.transferId &&
    t.sender.toLowerCase() === main.sender.toLowerCase() &&
    t.recipientKey.toLowerCase() === feeAccountKey.toLowerCase());
  return fee ? { transferId: fee.transferId, amountUsdc: fee.amountUsdc, status: "held" } : null;
}

/** What to do with a held fee, from where the seller's hold stands. Pure. */
export function feeStepFor(record: Pick<ProtectedEscrowRecord, "status" | "marketFee">): "take" | "return" | "wait" {
  if (record.marketFee?.status !== "held") return "wait";
  if (record.status === "claimed") return "take";
  if (record.status === "refunded" || record.status === "failed") return "return";
  return "wait";
}

/**
 * The scheduled step. For every held fee whose deal has ended, does the same
 * thing that happened to the seller's hold. Safe to run twice: it reads the
 * chain first and only records what is already true there.
 */
export async function runMarketFeeWork(): Promise<{ taken: number; returned: number; errors: string[] }> {
  const out = { taken: 0, returned: 0, errors: [] as string[] };
  const { listTrackedOnCurrentContract, updateTracked } = await import("./escrow-jobs.js");
  const due = listTrackedOnCurrentContract().filter((r) => feeStepFor(r) !== "wait");
  if (due.length === 0) return out;
  const { readTransfer } = await import("./protectedEscrow.js");
  const { claimProtectedTransfer, refundProtectedTransferEarly } = await import("./escrow.js");
  for (const record of due) {
    const fee = record.marketFee!;
    const step = feeStepFor(record);
    try {
      const onChain = await readTransfer(fee.transferId);
      let tx: string | undefined;
      let status: MarketFeeHold["status"];
      if (onChain.status === "Claimed") status = "taken";
      else if (onChain.status === "Refunded") status = "returned";
      else if (step === "take") {
        const account = marketFeeAccount();
        if (!account) throw new Error("No marketplace fee account to pay");
        tx = (await claimProtectedTransfer(BigInt(fee.transferId), account.address)).claimTx;
        status = "taken";
      } else {
        tx = (await refundProtectedTransferEarly(BigInt(fee.transferId))).refundTx;
        status = "returned";
      }
      updateTracked(record.id, { marketFee: { ...fee, status, ...(tx ? { tx } : {}), settledAt: new Date().toISOString(), lastError: undefined } });
      if (status === "taken") out.taken += 1;
      else {
        out.returned += 1;
        // The buyer's 1% is back beside the rest of their refund.
        store.addActivity({
          userId: record.fromUserId,
          kind: "system",
          title: "Money returned",
          description: `${fee.amountUsdc} USDC marketplace fee returned with your refund`,
          amountUsdc: fee.amountUsdc,
          token: "USDC",
          amountToken: fee.amountUsdc,
          counterparty: record.recipientId,
          txHash: tx,
          mode: "protected_escrow_refund",
          status: "completed",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.errors.push(`${fee.transferId}: ${message}`);
      updateTracked(record.id, { marketFee: { ...fee, lastError: message.slice(0, 200) } });
    }
  }
  return out;
}
