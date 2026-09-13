import { store } from "../store/db.js";
import { verifyPaymentEvidence } from "./payment-evidence.js";

export async function confirmPaymentActivity(userId: string, activityId: string, txHash?: string) {
  const row = store.getActivity(activityId);
  if (!row || row.userId !== userId) throw new Error("Activity not found");
  const hash = txHash || row.txHash || "";
  if (row.settlementVerified) {
    if (hash.toLowerCase() !== row.txHash?.toLowerCase()) throw new Error("Payment evidence cannot be replaced");
    return { row, newlyVerified: false };
  }
  if (row.kind !== "send" || !await verifyPaymentEvidence({
    txHash: hash, sender: store.getUser(userId)?.evmAddress || "",
    recipient: row.counterparty || "", token: row.token || "USDC",
    amount: row.amountToken ?? Math.abs(row.amountUsdc),
    notBefore: row.createdAt,
  })) throw new Error("Payment is not yet verified on Arc");
  // Recheck after RPC awaits. A receipt must not be reused for another draft.
  if (store.isPaymentEvidenceUsed(userId, hash, row.id)) throw new Error("Transaction already recorded");
  if (row.settlementVerified) return { row, newlyVerified: false };
  store.updateActivity(row.id, { status: "completed", txHash: hash, settlementVerified: true });
  return { row: store.getActivity(row.id)!, newlyVerified: true };
}
