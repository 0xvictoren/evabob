/**
 * One public link per payment: where it is while it travels, and proof it
 * arrived once it has.
 *
 * Fake "I've sent it" screenshots are an industry — apps exist purely to
 * fabricate bank alerts — and the only defence in circulation is the seller
 * logging into their own bank. Evabob already verifies settlement on chain
 * before it writes a receipt, so it can hand the payer a link anyone can
 * open, with no account: who paid, how much, when, and a check re-run against
 * the Arc network each time the page is opened. A screenshot can be faked; a
 * page that re-reads the chain cannot.
 *
 * While the payment is still moving the same link shows where it is —
 * Sending → On the way → Done — so the person waiting does not have to ask.
 *
 * Nothing is public until the payer shares it. The memo is never shown.
 */

import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { store, type ActivityItem } from "../store/db.js";

export type ReceiptStage =
  | "sending"
  | "on_the_way"
  | "done"
  | "held"
  | "returned"
  | "failed";

export type ReceiptCheck = {
  status: "verified" | "not_verified" | "not_yet" | "unavailable";
  txHash?: string;
  explorerUrl?: string;
  checkedAt?: string;
};

/** Kinds of payment a person can share a link for. */
const SHAREABLE_KINDS = new Set<ActivityItem["kind"]>(["send", "withdraw", "bridge"]);

export class ReceiptError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

/** A public id: 16 random bytes, URL-safe. Unguessable, unrelated to row ids. */
export function newPublicId(): string {
  return randomBytes(16).toString("base64url");
}

export function receiptUrl(publicId: string): string {
  return `${(config.appPublicUrl || "https://evabob.app").replace(/\/$/, "")}/r/${publicId}`;
}

/**
 * Makes a payment shareable (idempotent) and returns its link. Owner only.
 */
export function sharePayment(userId: string, activityId: string): {
  publicId: string;
  url: string;
} {
  const row = store.getActivity(activityId);
  if (!row || row.userId !== userId) throw new ReceiptError("No such payment", 404);
  if (!SHAREABLE_KINDS.has(row.kind)) {
    throw new ReceiptError("Only payments you made can be shared");
  }
  if (row.status === "cancelled") {
    throw new ReceiptError("This payment was cancelled, so there is nothing to show");
  }
  const publicId = row.publicId ?? newPublicId();
  if (!row.publicId) store.updateActivity(row.id, { publicId });
  return { publicId, url: receiptUrl(publicId) };
}

/** Where a payment stands, in the words the public page uses. Pure. */
export function stageOf(input: {
  row: Pick<ActivityItem, "status" | "txHash" | "mode" | "kind">;
  /** The App Kit job's stage, for bridges and other kit jobs. */
  jobStage?: "waiting_pin" | "sent" | "confirming" | "arrived" | "failed";
  /** The held payment's contract status, for holds. */
  heldStatus?: "pending" | "claimed" | "refunded" | "failed";
}): ReceiptStage {
  if (input.heldStatus) {
    if (input.heldStatus === "claimed") return "done";
    if (input.heldStatus === "refunded") return "returned";
    if (input.heldStatus === "failed") return "failed";
    return "held";
  }
  const status = input.row.status ?? "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "completed") return "done";
  if (input.jobStage) {
    if (input.jobStage === "arrived") return "done";
    if (input.jobStage === "failed") return "failed";
    if (input.jobStage === "sent" || input.jobStage === "confirming") return "on_the_way";
    return "sending";
  }
  return input.row.txHash ? "on_the_way" : "sending";
}

// A shared link can be opened many times; re-reading the chain for every open
// would be wasteful and slow. A minute is fresh enough to be honest.
const checkCache = new Map<string, { atMs: number; check: ReceiptCheck }>();
const CHECK_TTL_MS = 60 * 1000;

async function checkOnChain(row: ActivityItem, payerAddress: string | undefined): Promise<ReceiptCheck> {
  const txHash = row.txHash ?? "";
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return { status: "not_yet" };
  const explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`;
  // Only a same-network send to a known address can be checked end to end:
  // payer, recipient, token and exact amount in one Transfer event.
  const recipient = row.counterparty ?? "";
  if (row.kind !== "send" || !payerAddress || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return { status: "unavailable", txHash, explorerUrl };
  }
  const cached = checkCache.get(row.id);
  if (cached && Date.now() - cached.atMs < CHECK_TTL_MS) return cached.check;
  const { verifyPaymentEvidence } = await import("./payment-evidence.js");
  const ok = await verifyPaymentEvidence({
    txHash,
    sender: payerAddress,
    recipient,
    token: row.token || "USDC",
    amount: row.amountToken ?? Math.abs(row.amountUsdc),
  }).catch(() => false);
  const check: ReceiptCheck = {
    status: ok ? "verified" : "not_verified",
    txHash,
    explorerUrl,
    checkedAt: new Date().toISOString(),
  };
  checkCache.set(row.id, { atMs: Date.now(), check });
  return check;
}

function nameFor(label: string | undefined, fallbackAddress?: string): string {
  if (label && !/^0x[a-fA-F0-9]{40}$/.test(label)) return label;
  const a = label || fallbackAddress || "";
  return /^0x[a-fA-F0-9]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "someone";
}

/** The public view of a shared payment, or null if the id is unknown. */
export async function publicReceipt(publicId: string) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(publicId)) return null;
  const row = store.findActivityByPublicId(publicId);
  if (!row) return null;
  const payer = store.getUser(row.userId);

  let jobStage: Parameters<typeof stageOf>[0]["jobStage"];
  if (row.jobId) {
    const { getAppKitJob, jobStage: stageOfJob } = await import("./appKitMoney.js");
    const job = getAppKitJob(row.jobId);
    if (job) jobStage = stageOfJob(job);
  }
  let heldStatus: Parameters<typeof stageOf>[0]["heldStatus"];
  let heldFor: "order" | "cooling_off" | "sign_up" | undefined;
  if (row.mode === "escrow" && row.txHash) {
    const { listTrackedOnCurrentContract } = await import("./escrow-jobs.js");
    const held = listTrackedOnCurrentContract().find(
      (e) => (e.createTx ?? "").toLowerCase() === row.txHash!.toLowerCase(),
    );
    heldStatus = held?.status;
    heldFor =
      held?.purpose === "job" ? "order" : held?.purpose === "cooling_off" ? "cooling_off" : held ? "sign_up" : undefined;
  }
  const stage = stageOf({ row, jobStage, heldStatus });
  const amount = row.amountToken ?? Math.abs(row.amountUsdc);
  return {
    publicId,
    amount,
    token: row.token || "USDC",
    /** What the recipient receives. The Evabob fee is paid on top, not deducted. */
    landedAmount: amount,
    from: nameFor(row.sender || (payer?.handle ? `@${payer.handle}` : undefined), payer?.evmAddress),
    to: nameFor(row.receiver, row.counterparty),
    createdAt: row.createdAt,
    stage,
    /** Why money is held, for the page's explanation. */
    heldFor,
    check:
      stage === "done"
        ? await checkOnChain(row, payer?.evmAddress)
        : ({ status: "not_yet" } as ReceiptCheck),
  };
}
