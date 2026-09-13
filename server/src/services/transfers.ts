import { createHash, randomUUID } from "node:crypto";
import { store } from "../store/db.js";

/** Normalize handle / phone / email into a lookup key. */
export function normalizeRecipient(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Ledger-backed send for product UX until PaymentEscrow is deployed & funded.
 * When PAYMENT_ESCROW + PRIVATE_KEY are live, this becomes an on-chain create.
 */
export function executeSend(input: {
  fromUserId: string;
  toHandle: string;
  amountUsdc: number;
  amountNgn: number;
  memo?: string;
  /**
   * Whether to write activity rows for this transfer.
   *
   * False when the money already moved on chain and was recorded there. One
   * send used to produce three rows in the feed — the pending row from the
   * send route, the real one from the App Kit job, and a third from here —
   * because each writer recorded the same payment without knowing about the
   * others. This one is the easiest to drop: it is a ledger mirror of a
   * transfer that really happened elsewhere.
   */
  recordActivity?: boolean;
}) {
  if (input.amountUsdc <= 0) throw new Error("Amount must be positive");
  const to = normalizeRecipient(input.toHandle);
  if (!to) throw new Error("Recipient required");

  const transfer = store.addTransfer({
    fromUserId: input.fromUserId,
    toHandle: to,
    amountUsdc: input.amountUsdc,
    amountNgn: input.amountNgn,
    memo: input.memo,
    status: "completed",
  });

  const fromUser = store.getUser(input.fromUserId);
  const peer = store.findUserByRecipient(input.toHandle);
  const senderLabel =
    fromUser?.handle
      ? `@${fromUser.handle}`
      : fromUser?.displayName || fromUser?.email || input.fromUserId;
  const receiverLabel = peer?.handle
    ? `@${peer.handle}`
    : peer?.displayName || to;

  if (input.recordActivity !== false) {
  store.addActivity({
    userId: input.fromUserId,
    kind: "send",
    title: to,
    description: input.memo || "Evabob transfer",
    amountUsdc: -input.amountUsdc,
    amountNgnHint: -input.amountNgn,
    counterparty: to,
    sender: senderLabel,
    receiver: receiverLabel,
    token: "USDC",
    amountToken: input.amountUsdc,
    mode: "chat_ledger",
    txHash: transfer.id,
  });

  // Mirror receive for real peer when we know them
  store.addActivity({
    userId: peer?.id || `peer_${to}`,
    kind: "receive",
    title: fromUser?.displayName || "Evabob user",
    description: input.memo || "Received via Evabob",
    amountUsdc: input.amountUsdc,
    amountNgnHint: input.amountNgn,
    counterparty: input.fromUserId,
    sender: senderLabel,
    receiver: receiverLabel,
    token: "USDC",
    amountToken: input.amountUsdc,
    mode: "chat_ledger",
    txHash: transfer.id,
  });
  }

  return transfer;
}

/** Approximate rates for UI when Synthra key is absent (not a market price). */
export function fxApprox(
  from: "USDC" | "EURC" | "CIRBTC",
  to: "USDC" | "EURC" | "CIRBTC",
  amountIn: number,
): number {
  // Placeholder rates — production uses Synthra quotes.
  const eurPerUsdc = 1 / 1.08;
  const btcPerUsdc = 1 / 95000; // rough display only
  if (from === to) return amountIn;
  if (from === "EURC" && to === "USDC") return amountIn * 1.08;
  if (from === "USDC" && to === "EURC") return amountIn * eurPerUsdc;
  if (from === "USDC" && to === "CIRBTC") return amountIn * btcPerUsdc;
  if (from === "CIRBTC" && to === "USDC") return amountIn / btcPerUsdc;
  if (from === "EURC" && to === "CIRBTC") return amountIn * 1.08 * btcPerUsdc;
  if (from === "CIRBTC" && to === "EURC") {
    return (amountIn / btcPerUsdc) * eurPerUsdc;
  }
  return amountIn;
}

export function executeExchange(input: {
  userId: string;
  from: "USDC" | "EURC";
  to: "USDC" | "EURC";
  amountIn: number;
  amountOut: number;
}) {
  const id = randomUUID();
  store.addActivity({
    userId: input.userId,
    kind: "exchange",
    title: `${input.from} → ${input.to}`,
    description: `Exchanged ${input.amountIn} ${input.from}`,
    amountUsdc:
      input.to === "USDC"
        ? input.amountOut
        : input.from === "USDC"
          ? -input.amountIn
          : 0,
  });
  return {
    id,
    ...input,
    route: "arc-eurc-usdc",
    note: "StableFX / pool swap on Arc when liquidity path is wired; ledgered for now.",
  };
}

export function recipientKey(handle: string): `0x${string}` {
  const h = createHash("sha256").update(normalizeRecipient(handle)).digest("hex");
  return `0x${h.slice(0, 40)}`;
}
