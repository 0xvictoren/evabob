import { store, type ActivityItem } from "../store/db.js";
import { confirmMemoOnchain, memoOnchainEnabled } from "./memo.js";
import { verifyPaymentEvidence, verifySpendEvidence } from "./payment-evidence.js";
import { alertUser, signalBalanceChanged } from "./notifyUser.js";

/**
 * Turns a pending conversion into a receipt once its transaction is proven:
 * it succeeded and spent exactly the amount from this person's wallet.
 * Conversions used to be refused here — only sends were accepted — so every
 * Synthra swap stayed "On the way" even after it landed.
 */
export async function confirmSwapActivity(userId: string, activityId: string, txHash?: string) {
  const row = store.getActivity(activityId);
  if (!row || row.userId !== userId || row.kind !== "exchange") throw new Error("Activity not found");
  const hash = txHash || row.txHash || "";
  if (row.settlementVerified) return { row, newlyVerified: false };
  const sender = store.getUser(userId)?.evmAddress || "";
  const ok = await verifySpendEvidence({
    txHash: hash,
    sender,
    token: row.token || "USDC",
    amount: row.amountToken ?? Math.abs(row.amountUsdc),
    notBefore: row.createdAt,
  });
  if (!ok) throw new Error("Conversion is not yet verified on Arc");
  store.updateActivity(row.id, { status: "completed", txHash: hash, settlementVerified: true });
  signalBalanceChanged(userId);
  return { row: store.getActivity(row.id)!, newlyVerified: true };
}

export async function confirmPaymentActivity(userId: string, activityId: string, txHash?: string) {
  const row = store.getActivity(activityId);
  if (!row || row.userId !== userId) throw new Error("Activity not found");
  const hash = txHash || row.txHash || "";
  if (row.settlementVerified) {
    if (hash.toLowerCase() !== row.txHash?.toLowerCase()) throw new Error("Payment evidence cannot be replaced");
    return { row, newlyVerified: false };
  }
  const sender = store.getUser(userId)?.evmAddress || "";
  if (row.kind !== "send" || !await verifyPaymentEvidence({
    txHash: hash, sender,
    recipient: row.counterparty || "", token: row.token || "USDC",
    amount: row.amountToken ?? Math.abs(row.amountUsdc),
    notBefore: row.createdAt,
  })) throw new Error("Payment is not yet verified on Arc");
  // A memo planned for the chain is confirmed from the same receipt. Its
  // absence does not undo a verified payment — the money moved — it only
  // means the receipt says the memo was kept with the payment, not on chain.
  const memoOnchain = row.memo && row.memoId && memoOnchainEnabled()
    ? await confirmMemoOnchain(hash, { sender, memoId: row.memoId as `0x${string}`, memo: row.memo })
    : undefined;
  // Recheck after RPC awaits. A receipt must not be reused for another draft.
  if (store.isPaymentEvidenceUsed(userId, hash, row.id, row.batchId)) throw new Error("Transaction already recorded");
  if (row.settlementVerified) return { row, newlyVerified: false };
  store.updateActivity(row.id, {
    status: "completed",
    txHash: hash,
    settlementVerified: true,
    ...(memoOnchain != null ? { memoOnchain } : {}),
  });
  signalBalanceChanged(userId);
  return { row: store.getActivity(row.id)!, newlyVerified: true };
}

/**
 * Writes the payee's side of a verified payment between two Evabob users.
 *
 * Called once, when the sender's row is first verified. The memo travels with
 * it, so the person paid reads the same note the sender wrote.
 */
export function recordPeerReceipt(row: ActivityItem, txHash: string | undefined) {
  if (row.kind !== "send" || !row.counterparty) return null;
  const peer =
    store.findUserByRecipient(row.counterparty) ||
    (row.receiver ? store.findUserByHandle(row.receiver.replace(/^@/, "")) : null);
  if (!peer || peer.id === row.userId) return null;
  const hash = txHash || row.txHash;
  const token = row.token || "USDC";
  const amount = row.amountToken ?? Math.abs(row.amountUsdc);
  // The payee's inbound scan may have recorded this transfer first. Give that
  // row the sender's name and memo rather than adding the money twice.
  const scanned = hash
    ? store.findInboundReceipt({ userId: peer.id, txHash: hash, token, amount })
    : null;
  if (scanned) {
    return store.updateActivity(scanned.id, {
      ...(row.sender ? { sender: row.sender } : {}),
      ...(row.memo
        ? { memo: row.memo, memoId: row.memoId, memoOnchain: row.memoOnchain }
        : {}),
    });
  }
  const receipt = store.addActivity({
    userId: peer.id,
    kind: "receive",
    title: row.sender || "Evabob user",
    description: "Payment received",
    amountUsdc: row.token === "USDC" ? Math.abs(row.amountUsdc) : 0,
    amountNgnHint: row.amountNgnHint ? Math.abs(row.amountNgnHint) : undefined,
    counterparty: row.sender || row.userId,
    sender: row.sender,
    receiver: row.receiver,
    token: row.token,
    amountToken: row.amountToken,
    mode: row.mode,
    status: "completed",
    txHash: hash,
    ...(row.memo
      ? { memo: row.memo, memoId: row.memoId, memoOnchain: row.memoOnchain }
      : {}),
    ...(row.batchId ? { batchId: row.batchId } : {}),
  });
  // The inbound scan skips transfers this receipt already covers, so it would
  // never tell the payee. A seller waiting at the counter needs the ding now.
  // Same tag as the scan's alert, so a phone never shows it twice.
  alertUser(peer.id, {
    kind: "money_in",
    moneyIn: true,
    title: "Money received",
    body: `${amount} ${token} from ${row.sender || "an Evabob user"}`,
    amountUsdc: token === "USDC" ? amount : undefined,
    token,
    counterparty: row.sender,
    txHash: hash,
  });
  return receipt;
}
