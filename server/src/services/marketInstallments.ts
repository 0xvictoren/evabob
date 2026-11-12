/**
 * Paying for something on the marketplace in parts.
 *
 * Each part is an ordinary job hold the buyer locks for the seller, so the
 * money is in the escrow contract from the first part, not with the seller
 * and not with Evabob. This file adds the two things a hold does not know:
 *
 *   which holds are parts of which deal   proved from the tracked hold, never
 *                                         from what the app says it paid
 *   the deadline                          when it passes with the total not
 *                                         in, every part goes back to the
 *                                         buyer (the contract can only send a
 *                                         refund to whoever funded it)
 *
 * Paid in full, the holds simply stand: the deal carries on like any deal
 * whose money is set aside, and the seller is paid as each hold is released.
 */

import { store } from "../store/db.js";
import * as market from "./market.js";
import { alertUser } from "./notifyUser.js";

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Checks that a hold is a genuine part of this deal and returns what it is
 * worth: locked by the buyer, for the seller, still held, on the current
 * contract. The amount counts the marketplace's 1% locked beside it, since
 * that also left the buyer for this deal.
 */
export async function provePart(input: { deal: market.MarketDeal; buyerId: string; transferId: string }): Promise<number> {
  const { findTrackedByTransferId } = await import("./escrow-jobs.js");
  const record = findTrackedByTransferId(input.transferId);
  const seller = store.getUser(input.deal.sellerId);
  const forSeller = record && seller &&
    [seller.handle, seller.email].some((id) => id && id.toLowerCase() === record.recipientId.toLowerCase());
  if (!record || record.fromUserId !== input.buyerId || !forSeller || record.purpose !== "job") {
    throw new market.MarketError("That payment is not a hold for this seller.", 409);
  }
  if (record.status !== "pending") throw new market.MarketError("That payment is no longer held.", 409);
  return Number((record.amountUsdc + (record.marketFee?.amountUsdc ?? 0)).toFixed(6));
}

/** Tells both people where a part payment stands after a part lands. */
export function announcePart(deal: market.MarketDeal, partUsd: number, funded: boolean): void {
  const buyer = store.getUser(deal.buyerId);
  const who = buyer?.handle ? `@${buyer.handle}` : "Your buyer";
  const paid = market.installmentPaid(deal);
  const left = Math.max(0, deal.priceUsd - paid);
  const due = deal.installments ? new Date(deal.installments.dueAt).toUTCString().slice(5, 16) : "";
  alertUser(deal.sellerId, {
    kind: "market_deal",
    title: funded ? "Paid in full, and set aside for you" : "A part payment came in",
    body: funded
      ? `${who} has finished paying ${money(deal.priceUsd)} for "${deal.title}". It is held until you deliver.`
      : `${who} set aside ${money(partUsd)} for "${deal.title}". ${money(paid)} of ${money(deal.priceUsd)} so far; ${money(left)} to go by ${due}.`,
    link: `evabob://market/${deal.postId}`,
  });
  if (funded) {
    alertUser(deal.buyerId, {
      kind: "market_deal",
      title: "You have paid in full",
      body: `${money(deal.priceUsd)} for "${deal.title}" is set aside until it is delivered.`,
      link: `evabob://market/${deal.postId}`,
    });
  }
}

/**
 * The scheduled step: every part-payment deal past its deadline without the
 * full amount has each part returned to the buyer. A part that will not
 * refund yet (the chain is busy) is tried again next time; the deal is only
 * closed once nothing of it is still held.
 */
export async function runInstallmentWork(now = Date.now()): Promise<{ refunded: number; parts: number; errors: string[] }> {
  const out = { refunded: 0, parts: 0, errors: [] as string[] };
  const overdue = market.installmentsOverdue(now);
  if (overdue.length === 0) return out;
  const { findTrackedByTransferId, updateTracked } = await import("./escrow-jobs.js");
  const { refundProtectedTransferEarly } = await import("./escrow.js");
  const { readTransfer } = await import("./protectedEscrow.js");
  const { noteRefunded } = await import("./heldPayments.js");
  for (const deal of overdue) {
    let stillHeld = 0;
    for (const part of deal.installments!.parts) {
      const record = findTrackedByTransferId(part.transferId);
      if (!record || record.status !== "pending") continue;
      try {
        const onChain = await readTransfer(part.transferId);
        if (onChain.status === "Pending") {
          const { refundTx } = await refundProtectedTransferEarly(BigInt(part.transferId));
          updateTracked(record.id, {
            status: "refunded",
            refundTx,
            settledBy: "expired",
            settledAt: new Date().toISOString(),
            lastAutoError: undefined,
          });
          noteRefunded(record, refundTx);
          out.parts += 1;
        }
      } catch (error) {
        stillHeld += 1;
        out.errors.push(`${part.transferId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (stillHeld > 0) continue;
    market.markInstallmentsRefunded(deal.id, now);
    out.refunded += 1;
    const paid = market.installmentPaid(deal);
    if (paid > 0) {
      alertUser(deal.buyerId, {
        kind: "market_deal",
        title: "Your part payments are back with you",
        body: `The time to finish paying for "${deal.title}" ran out, so the ${money(paid)} you had set aside was returned.`,
        link: `evabob://market/${deal.postId}`,
      });
    }
    alertUser(deal.sellerId, {
      kind: "market_deal",
      title: "A part payment ran out of time",
      body: `"${deal.title}" was not paid in full by the deadline. What had been set aside went back to the buyer.`,
      link: `evabob://market/${deal.postId}`,
    });
  }
  return out;
}
