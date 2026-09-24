/**
 * What happens to held money after it is locked — for jobs, cooling-off
 * payments and claim links alike.
 *
 * A job hold used to release only when the payer said the work arrived, and
 * refund to the payer when it expired. A worker who delivered to a payer who
 * then went quiet got nothing: the protection ran one way. The rules now,
 * set by the product owner and written down before the first dispute rather
 * than during it (docs/HELD_PAYMENTS.md):
 *
 *   1. The worker marks the work delivered, with a note and links.
 *   2. The payer has 7 days to confirm or object. Silence releases the money
 *      to the worker.
 *   3. Before delivery the payer may cancel, and the money goes straight back.
 *   4. After delivery, cancelling opens a reconciliation form — the payer says
 *      why they no longer need the job — and a person reviews it. Nothing
 *      moves on its own while it is under review, and the hold's expiry is
 *      pushed out so the payer cannot simply wait for the refund that opens at
 *      expiry.
 *   5. The worker may give the money back at any point, which settles it.
 *
 * Cooling-off holds (a first payment to someone new) release after 10 minutes
 * unless the sender cancels. Claim links release when the recipient signs up
 * (protectedEscrow.ts) and may be cancelled by the sender before that.
 *
 * Every "give it back now" uses PaymentEscrowV3's refundWithAttestation, which
 * can only pay the original sender. Every release uses claimWithAttestation,
 * which can only pay the address the identity registry resolves the recipient
 * to. The server decides when; the contract decides who.
 */

import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { store } from "../store/db.js";
import type { HeldReview, ProtectedEscrowRecord, ReviewMessage } from "./mongo.js";
import {
  findTrackedByTransferId,
  listLocalPending,
  listTrackedOnCurrentContract,
  updateTracked,
} from "./escrow-jobs.js";
import {
  MAX_EXPIRY_SECONDS,
  escrowRecipientKey,
  readClaimTarget,
  readTransfer,
  releaseProtectedEscrow,
} from "./protectedEscrow.js";
import {
  extendProtectedTransferExpiry,
  refundProtectedTransferEarly,
} from "./escrow.js";
import { alertUser } from "./notifyUser.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a payer has to confirm or object once work is marked delivered. */
export const JOB_REVIEW_MS = 7 * DAY_MS;

/** How far ahead of auto-release the payer gets a last reminder. */
export const RELEASE_REMINDER_MS = DAY_MS;

/** Undelivered job holds get a nudge this long before they expire. */
export const EXPIRY_NUDGE_MS = 7 * DAY_MS;

/**
 * While a cancellation is under review, the hold's expiry is kept at least
 * this far ahead, so the refund that opens at expiry cannot pre-empt the
 * reviewer. Bounded on chain to a year after the hold was created.
 */
export const REVIEW_EXPIRY_BUFFER_MS = 30 * DAY_MS;

/** A release must land before expiry; this is the margin kept free of it. */
const EXPIRY_SAFETY_MS = DAY_MS;

export const CANCEL_REASONS = [
  "no_longer_needed",
  "not_as_agreed",
  "not_received",
  "other",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type HeldRole = "payer" | "worker";

export type HeldStage =
  | "waiting_for_delivery"
  | "delivered"
  | "under_review"
  | "cooling_off"
  | "waiting_to_claim"
  | "released"
  | "refunded";

export type HeldAction =
  | "confirm"
  | "cancel"
  | "cancel_with_reason"
  | "mark_delivered"
  | "give_back"
  | "respond";

export class HeldPaymentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// ─── Who is who ───────────────────────────────────────────────────────────

function normalizeRecipient(identifier: string): string | null {
  try {
    return escrowRecipientKey(identifier).normalized;
  } catch {
    return null;
  }
}

/** The caller's relationship to a hold, or null when they have none. */
export function roleFor(
  record: ProtectedEscrowRecord,
  userId: string,
): HeldRole | null {
  if (record.fromUserId === userId) return "payer";
  const user = store.getUser(userId);
  if (!user) return null;
  const mine = [user.handle, user.email]
    .filter((v): v is string => Boolean(v))
    .map(normalizeRecipient)
    .filter((v): v is string => Boolean(v));
  return mine.includes(record.recipientId) ? "worker" : null;
}

// ─── Where a hold stands ──────────────────────────────────────────────────

export function stageOf(record: ProtectedEscrowRecord): HeldStage {
  if (record.status === "claimed") return "released";
  if (record.status === "refunded") return "refunded";
  const purpose = record.purpose ?? "claim_link";
  if (purpose === "cooling_off") return "cooling_off";
  if (purpose === "claim_link") return "waiting_to_claim";
  if (record.review?.status === "under_review") return "under_review";
  return record.deliveredAt ? "delivered" : "waiting_for_delivery";
}

/** What the caller may do next. The routes enforce the same rules. */
export function actionsFor(
  record: ProtectedEscrowRecord,
  role: HeldRole,
  now = Date.now(),
): HeldAction[] {
  if (record.status !== "pending") return [];
  const stage = stageOf(record);
  if (role === "payer") {
    switch (stage) {
      case "waiting_for_delivery":
        return ["confirm", "cancel"];
      case "delivered":
        return ["confirm", "cancel_with_reason"];
      case "under_review":
        // Changing their mind and paying ends the review in the worker's favour.
        return ["confirm"];
      case "cooling_off":
        return record.releaseAt && Date.parse(record.releaseAt) > now
          ? ["cancel"]
          : [];
      case "waiting_to_claim":
        return ["cancel"];
      default:
        return [];
    }
  }
  switch (stage) {
    case "waiting_for_delivery":
      return ["mark_delivered", "give_back"];
    case "delivered":
      return ["give_back"];
    case "under_review":
      return ["respond", "give_back"];
    default:
      return [];
  }
}

// ─── Automatic steps ──────────────────────────────────────────────────────

export type AutomaticStep =
  | { kind: "release"; settledBy: "auto_release" | "cooling_off_elapsed" }
  | { kind: "remind_payer" }
  | { kind: "nudge_expiry" }
  | { kind: "extend_expiry"; untilMs: number };

/**
 * The next thing the server should do to a hold on its own, if anything.
 *
 * Pure so the rules can be tested without a chain. Releases come first: a
 * hold that is due to pay out should pay out, not also collect a reminder.
 */
export function nextAutomaticStep(
  record: ProtectedEscrowRecord,
  now = Date.now(),
): AutomaticStep | null {
  if (record.status !== "pending") return null;
  const purpose = record.purpose ?? "claim_link";

  if (purpose === "cooling_off") {
    if (record.releaseAt && Date.parse(record.releaseAt) <= now) {
      return { kind: "release", settledBy: "cooling_off_elapsed" };
    }
    return null;
  }
  if (purpose !== "job") return null;

  const expiresAt = Date.parse(record.expiresAt);
  if (record.review?.status === "under_review") {
    // Nothing is released or refunded automatically during a review; only
    // the expiry is kept ahead of it.
    if (expiresAt - now < REVIEW_EXPIRY_BUFFER_MS / 2) {
      return { kind: "extend_expiry", untilMs: now + REVIEW_EXPIRY_BUFFER_MS };
    }
    return null;
  }

  if (record.deliveredAt && record.autoReleaseAt) {
    const releaseAt = Date.parse(record.autoReleaseAt);
    if (releaseAt <= now) return { kind: "release", settledBy: "auto_release" };
    if (!record.reminderSentAt && releaseAt - now <= RELEASE_REMINDER_MS) {
      return { kind: "remind_payer" };
    }
    return null;
  }

  if (!record.deliveredAt && !record.expiryNudgeSentAt && expiresAt - now <= EXPIRY_NUDGE_MS) {
    return { kind: "nudge_expiry" };
  }
  return null;
}

/**
 * When silence should release a job marked delivered at `deliveredAtMs`, and
 * the expiry the hold needs so that release lands before a refund can open.
 */
export function planAutoRelease(input: {
  deliveredAtMs: number;
  createdAtMs: number;
  expiresAtMs: number;
}): { autoReleaseAtMs: number; extendExpiryToMs: number | null } {
  const autoReleaseAtMs = input.deliveredAtMs + JOB_REVIEW_MS;
  const needed = autoReleaseAtMs + EXPIRY_SAFETY_MS;
  if (needed <= input.expiresAtMs) {
    return { autoReleaseAtMs, extendExpiryToMs: null };
  }
  const ceiling = input.createdAtMs + MAX_EXPIRY_SECONDS * 1000;
  return {
    autoReleaseAtMs: Math.min(autoReleaseAtMs, ceiling - EXPIRY_SAFETY_MS),
    extendExpiryToMs: Math.min(needed, ceiling),
  };
}

// ─── The public view of a hold ────────────────────────────────────────────

function displayName(userId: string): string {
  const u = store.getUser(userId);
  return u?.handle ? `@${u.handle}` : u?.displayName || u?.email || "someone";
}

/**
 * Who is paying, as the worker should see it. A hold an agent funded names
 * the agent and its owner, so the person always knows who answers for it.
 */
function payerName(record: ProtectedEscrowRecord): string {
  if (record.payerAgentId) {
    const agent = store.getAgentById(record.payerAgentId);
    const name = agent?.handle ? `@${agent.handle}` : agent?.label ?? "An agent";
    return `${name} (agent of ${displayName(record.fromUserId)})`;
  }
  return displayName(record.fromUserId);
}

/** What either party sees. The reviewer's identity is never included. */
export function viewFor(
  record: ProtectedEscrowRecord,
  role: HeldRole,
  now = Date.now(),
) {
  const review: Omit<HeldReview, "decidedBy"> | undefined = record.review
    ? (({ decidedBy: _hidden, ...rest }) => rest)(record.review)
    : undefined;
  return {
    transferId: record.onChainTransferId,
    purpose: record.purpose ?? "claim_link",
    role,
    stage: stageOf(record),
    actions: actionsFor(record, role, now),
    amountUsdc: record.amountUsdc,
    memo: record.memo ?? "",
    /** The other side: who pays, or who the money is for. */
    counterparty:
      role === "payer" ? record.recipientId : payerName(record),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    deliveredAt: record.deliveredAt,
    deliveryNote: record.deliveryNote,
    deliveryLinks: record.deliveryLinks ?? [],
    autoReleaseAt: record.autoReleaseAt,
    releaseAt: record.releaseAt,
    settledBy: record.settledBy,
    settledAt: record.settledAt,
    claimTx: record.claimTx,
    refundTx: record.refundTx,
    review,
    /** An agent put this money aside; the worker is told before starting. */
    payerAgent: record.payerAgentId ? agentSummary(record.payerAgentId) : null,
    agentTaskId: record.agentTaskId ?? null,
  };
}

function agentSummary(agentId: string) {
  const agent = store.getAgentById(agentId);
  if (!agent) return null;
  const owner = store.getUser(agent.userId);
  return {
    label: agent.label,
    handle: agent.handle ? `@${agent.handle}` : null,
    owner: owner?.handle ? `@${owner.handle}` : owner?.displayName ?? null,
  };
}

// ─── Chain actions ────────────────────────────────────────────────────────

function requireRecord(transferId: string): ProtectedEscrowRecord {
  const record = findTrackedByTransferId(transferId);
  if (!record) throw new HeldPaymentError("No such held payment", 404);
  return record;
}

function requirePending(record: ProtectedEscrowRecord) {
  if (record.status !== "pending") {
    throw new HeldPaymentError(
      record.status === "claimed"
        ? "This payment has already been released"
        : "This payment has already gone back to the payer",
      409,
    );
  }
}

/** Releases a hold to its recipient, whoever the registry says that is now. */
async function releaseToRecipient(
  record: ProtectedEscrowRecord,
  settledBy: NonNullable<ProtectedEscrowRecord["settledBy"]>,
): Promise<ProtectedEscrowRecord> {
  const transferId = record.onChainTransferId!;
  const target = await readClaimTarget(transferId);
  if (!target.claimable || !target.account) {
    throw new HeldPaymentError(
      `${record.recipientId} has not finished signing up yet, so there is no wallet to pay. It will go through once they do.`,
      409,
    );
  }
  const out = await releaseProtectedEscrow({
    transferId,
    recipientId: record.recipientId,
    claimerAddress: target.account,
  });
  const settledAt = new Date().toISOString();
  const updated = updateTracked(record.id, {
    status: "claimed",
    claimTx: out.claimTx,
    settledBy,
    settledAt,
    lastAutoError: undefined,
    ...(record.review?.status === "under_review"
      ? { review: { ...record.review, status: "released_to_worker", decidedAt: settledAt } }
      : {}),
  })!;

  store.addActivity({
    userId: record.fromUserId,
    kind: "escrow",
    title: "Held payment sent",
    description: `${out.amountUsdc} USDC to ${record.recipientId}`,
    amountUsdc: 0,
    token: "USDC",
    amountToken: out.amountUsdc,
    counterparty: record.recipientId,
    txHash: out.claimTx,
    mode: "protected_escrow",
    status: "completed",
  });

  // The contract paid whichever wallet the registry resolves, so the receipt
  // belongs to that wallet's owner. Looking the person up by handle or email
  // could credit someone else if the identity and the wallet ever disagree —
  // they would be told they were paid while the money went elsewhere.
  const paidTo = target.account.toLowerCase();
  const worker = store
    .listUsers()
    .find((u) => u.evmAddress?.toLowerCase() === paidTo && !u.deletedAt);
  const named = workerUserId(record);
  if (named && named !== worker?.id) {
    console.warn(
      `[held] transfer ${transferId}: ${record.recipientId} resolves on chain to a wallet ` +
        `its current Evabob holder does not own; receipt recorded for the wallet owner only`,
    );
  }
  if (worker) {
    store.addActivity({
      userId: worker.id,
      kind: "receive",
      title: "Payment received",
      description: `${out.amountUsdc} USDC from ${payerName(record)}`,
      amountUsdc: out.amountUsdc,
      token: "USDC",
      amountToken: out.amountUsdc,
      receiver: target.account,
      counterparty: payerName(record),
      txHash: out.claimTx,
      mode: "protected_escrow_claim",
      status: "completed",
    });
    alertUser(worker.id, {
      kind: "hold_released",
      moneyIn: true,
      title: "Money received",
      body: `${out.amountUsdc} USDC from ${payerName(record)}`,
      amountUsdc: out.amountUsdc,
      token: "USDC",
      txHash: out.claimTx,
      transferId,
    });
  }
  return updated;
}

/** Returns a hold to the person who funded it, now. */
async function refundToPayer(
  record: ProtectedEscrowRecord,
  settledBy: NonNullable<ProtectedEscrowRecord["settledBy"]>,
  review?: HeldReview,
): Promise<ProtectedEscrowRecord> {
  const transferId = record.onChainTransferId!;
  const onChain = await readTransfer(transferId);
  if (onChain.status !== "Pending") {
    throw new HeldPaymentError(
      `This payment is already ${onChain.status.toLowerCase()}`,
      409,
    );
  }
  const { refundTx } = await refundProtectedTransferEarly(BigInt(transferId));
  const settledAt = new Date().toISOString();
  const updated = updateTracked(record.id, {
    status: "refunded",
    refundTx,
    settledBy,
    settledAt,
    lastAutoError: undefined,
    ...(review ? { review } : {}),
  })!;
  noteRefunded(record, refundTx);
  return updated;
}

/**
 * Tells the payer their held money is back. Money an agent put aside goes
 * back to the agent's wallet, not the owner's, and the wording says so; the
 * agent's balance is credited once it is spendable again (agentTasks.ts).
 */
export function noteRefunded(record: ProtectedEscrowRecord, refundTx: string | undefined) {
  const agent = record.payerAgentId ? store.getAgentById(record.payerAgentId) : undefined;
  const where = agent ? `back in ${agent.label}` : "back with you";
  store.addActivity({
    userId: record.fromUserId,
    kind: "system",
    title: "Money returned",
    description: `${record.amountUsdc} USDC held for ${record.recipientId} is ${where}`,
    amountUsdc: agent ? 0 : record.amountUsdc,
    token: "USDC",
    amountToken: record.amountUsdc,
    counterparty: record.recipientId,
    txHash: refundTx,
    mode: "protected_escrow_refund",
    status: "completed",
  });
  alertUser(record.fromUserId, {
    kind: "hold_refunded",
    moneyIn: !agent,
    title: "Money returned",
    body: `${record.amountUsdc} USDC held for ${record.recipientId} is ${where}`,
    amountUsdc: record.amountUsdc,
    token: "USDC",
    txHash: refundTx,
    transferId: record.onChainTransferId,
  });
}

async function extendExpiryTo(
  record: ProtectedEscrowRecord,
  untilMs: number,
): Promise<ProtectedEscrowRecord> {
  const transferId = record.onChainTransferId!;
  const onChain = await readTransfer(transferId);
  const ceilingMs = (onChain.createdAt + MAX_EXPIRY_SECONDS) * 1000;
  const targetMs = Math.min(untilMs, ceilingMs);
  if (targetMs <= onChain.expiresAt * 1000) {
    return updateTracked(record.id, {
      expiresAt: new Date(onChain.expiresAt * 1000).toISOString(),
    })!;
  }
  await extendProtectedTransferExpiry(
    BigInt(transferId),
    BigInt(Math.floor(targetMs / 1000)),
  );
  return updateTracked(record.id, { expiresAt: new Date(targetMs).toISOString() })!;
}

function workerUserId(record: ProtectedEscrowRecord): string | null {
  const user =
    store.findUserByEmail(record.recipientId) ??
    store.findUserByHandle(record.recipientId);
  return user?.id ?? null;
}

// ─── What people do ───────────────────────────────────────────────────────

const LINK = /^https?:\/\/\S{3,490}$/i;

function cleanLinks(links: string[] | undefined): string[] {
  const out = (links ?? []).map((l) => l.trim()).filter(Boolean);
  if (out.length > 5) throw new HeldPaymentError("Add at most 5 links");
  for (const l of out) {
    if (!LINK.test(l)) throw new HeldPaymentError(`"${l}" is not a web link`);
  }
  return out;
}

/** The worker says the work is done. Starts the 7-day clock. */
export async function markDelivered(input: {
  transferId: string;
  userId: string;
  note: string;
  links?: string[];
  now?: number;
}) {
  const record = requireRecord(input.transferId);
  requirePending(record);
  if ((record.purpose ?? "claim_link") !== "job") {
    throw new HeldPaymentError("Only held payments for work can be marked delivered");
  }
  if (roleFor(record, input.userId) !== "worker") {
    throw new HeldPaymentError("Only the person being paid can mark this delivered", 403);
  }
  if (record.deliveredAt) throw new HeldPaymentError("Already marked delivered", 409);
  const note = input.note.trim();
  if (note.length < 3) throw new HeldPaymentError("Say briefly what you delivered");
  const links = cleanLinks(input.links);

  const now = input.now ?? Date.now();
  const plan = planAutoRelease({
    deliveredAtMs: now,
    createdAtMs: Date.parse(record.createdAt),
    expiresAtMs: Date.parse(record.expiresAt),
  });
  let current = record;
  if (plan.extendExpiryToMs) current = await extendExpiryTo(current, plan.extendExpiryToMs);

  const updated = updateTracked(current.id, {
    deliveredAt: new Date(now).toISOString(),
    deliveryNote: note.slice(0, 500),
    deliveryLinks: links,
    autoReleaseAt: new Date(plan.autoReleaseAtMs).toISOString(),
  })!;
  alertUser(record.fromUserId, {
    kind: "hold_delivered",
    title: `${displayName(input.userId)} says the work is done`,
    body: `Check it and confirm. If you don't raise a problem, ${record.amountUsdc} USDC goes to them on ${updated.autoReleaseAt!.slice(0, 10)}.`,
    amountUsdc: record.amountUsdc,
    token: "USDC",
    transferId: input.transferId,
  });
  return updated;
}

/** The payer confirms: pay the worker now. Also ends a review in their favour. */
export async function confirmRelease(input: { transferId: string; userId: string }) {
  const record = requireRecord(input.transferId);
  requirePending(record);
  if (roleFor(record, input.userId) !== "payer") {
    throw new HeldPaymentError("Only the person who paid can release this", 403);
  }
  if ((record.purpose ?? "claim_link") === "claim_link") {
    throw new HeldPaymentError(
      "This one is released automatically when they sign up",
    );
  }
  return releaseToRecipient(record, "payer_confirmed");
}

/**
 * The payer cancels.
 *
 * Before delivery, and for cooling-off and claim-link holds, the money goes
 * straight back. After delivery it needs the reconciliation form and goes to a
 * person for review; nothing moves until they decide.
 */
export async function cancelHold(input: {
  transferId: string;
  userId: string;
  reason?: CancelReason;
  details?: string;
  links?: string[];
  now?: number;
}) {
  const record = requireRecord(input.transferId);
  requirePending(record);
  if (roleFor(record, input.userId) !== "payer") {
    throw new HeldPaymentError("Only the person who paid can cancel this", 403);
  }
  const now = input.now ?? Date.now();
  const purpose = record.purpose ?? "claim_link";

  if (purpose === "cooling_off") {
    if (!record.releaseAt || Date.parse(record.releaseAt) <= now) {
      throw new HeldPaymentError("Too late to cancel — this has already been sent", 409);
    }
    return { record: await refundToPayer(record, "payer_cancelled"), review: false };
  }
  if (purpose === "claim_link") {
    return { record: await refundToPayer(record, "payer_cancelled"), review: false };
  }

  if (record.review?.status === "under_review") {
    throw new HeldPaymentError("This is already being reviewed", 409);
  }
  if (!record.deliveredAt) {
    const out = await refundToPayer(record, "payer_cancelled");
    const worker = workerUserId(record);
    if (worker) {
      alertUser(worker, {
        kind: "hold_refunded",
        title: "A held payment was cancelled",
        body: `${payerName(record)} cancelled before the work was delivered. ${record.amountUsdc} USDC went back to them.`,
        amountUsdc: record.amountUsdc,
        token: "USDC",
        transferId: input.transferId,
      });
    }
    return { record: out, review: false };
  }

  // After delivery: the reconciliation form.
  if (!input.reason || !CANCEL_REASONS.includes(input.reason)) {
    throw new HeldPaymentError("Choose why you no longer need this work");
  }
  const details = (input.details ?? "").trim();
  if (details.length < 20) {
    throw new HeldPaymentError(
      "Tell us what happened in a sentence or two — a person reads this",
    );
  }
  const links = cleanLinks(input.links);
  const review: HeldReview = {
    status: "under_review",
    openedAt: new Date(now).toISOString(),
    reason: input.reason,
    details: details.slice(0, 2000),
    payerLinks: links,
  };
  let current = updateTracked(record.id, { review })!;
  // Keep the refund that opens at expiry from deciding this before a person
  // does. Best effort: if the chain write fails, the due-work pass retries.
  try {
    current = await extendExpiryTo(current, now + REVIEW_EXPIRY_BUFFER_MS);
  } catch (e) {
    updateTracked(current.id, {
      lastAutoError: `extend for review: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const worker = workerUserId(record);
  if (worker) {
    alertUser(worker, {
      kind: "hold_under_review",
      title: `${payerName(record)} cancelled after delivery`,
      body: "The money stays held while we review it. Add your side — what you delivered and when.",
      amountUsdc: record.amountUsdc,
      token: "USDC",
      transferId: input.transferId,
    });
  }
  for (const operator of config.auth.operatorUserIds) {
    alertUser(operator, {
      kind: "review_needed",
      title: "A held payment needs review",
      body: `${record.amountUsdc} USDC · ${input.reason.replaceAll("_", " ")}`,
      amountUsdc: record.amountUsdc,
      token: "USDC",
      transferId: input.transferId,
    });
  }
  return { record: current, review: true };
}

/** The worker gives the money back. Settles the hold, and any review. */
export async function giveBack(input: { transferId: string; userId: string }) {
  const record = requireRecord(input.transferId);
  requirePending(record);
  if ((record.purpose ?? "claim_link") !== "job") {
    throw new HeldPaymentError("Only held payments for work can be given back");
  }
  if (roleFor(record, input.userId) !== "worker") {
    throw new HeldPaymentError("Only the person being paid can give this back", 403);
  }
  const review = record.review?.status === "under_review"
    ? {
        ...record.review,
        status: "refunded_to_payer" as const,
        decidedAt: new Date().toISOString(),
        decisionNote: "The worker gave the money back.",
      }
    : undefined;
  return refundToPayer(record, "worker_refunded", review);
}

/** The worker's side of a review. */
export function respondToReview(input: {
  transferId: string;
  userId: string;
  statement: string;
  links?: string[];
}) {
  const record = requireRecord(input.transferId);
  requirePending(record);
  if (roleFor(record, input.userId) !== "worker") {
    throw new HeldPaymentError("Only the person being paid can respond", 403);
  }
  if (record.review?.status !== "under_review") {
    throw new HeldPaymentError("There is no review open on this payment", 409);
  }
  const statement = input.statement.trim();
  if (statement.length < 20) {
    throw new HeldPaymentError("Tell us what you delivered in a sentence or two");
  }
  return updateTracked(record.id, {
    review: {
      ...record.review,
      workerStatement: statement.slice(0, 2000),
      workerLinks: cleanLinks(input.links),
      workerRespondedAt: new Date().toISOString(),
    },
  })!;
}

export const MAX_REVIEW_MESSAGES = 60;

/**
 * Adds to the conversation on an open review.
 *
 * A single statement each side was not enough: a reviewer usually needs to ask
 * something ("which address did you ship to?") and the answer needs to reach
 * everyone. Payer, worker and reviewer all write here, each message with its
 * own links and photos. The reviewer is shown only as "Reviewer".
 */
export function addReviewMessage(input: {
  transferId: string;
  userId: string;
  /** True when the caller is an operator writing as the reviewer. */
  asReviewer?: boolean;
  text: string;
  links?: string[];
  photos?: string[];
}): { record: ProtectedEscrowRecord; message: ReviewMessage } {
  const record = requireRecord(input.transferId);
  if (record.review?.status !== "under_review") {
    throw new HeldPaymentError("This review is closed", 409);
  }
  const from: ReviewMessage["from"] | null = input.asReviewer
    ? "reviewer"
    : roleFor(record, input.userId);
  if (!from) throw new HeldPaymentError("This is not your payment", 403);
  const text = input.text.trim();
  if (!text) throw new HeldPaymentError("Write something first");
  const messages = record.review.messages ?? [];
  if (messages.length >= MAX_REVIEW_MESSAGES) {
    throw new HeldPaymentError("This conversation is full. The reviewer will decide from what is here.", 409);
  }
  const photos = (input.photos ?? []).filter((u) => /^\/uploads\/evidence_[a-f0-9]{32}\.(jpg|png|webp)$/.test(u));
  if (photos.length > 3) throw new HeldPaymentError("Add at most 3 photos to a message");
  const message: ReviewMessage = {
    id: randomUUID(),
    from,
    text: text.slice(0, 2000),
    links: cleanLinks(input.links),
    photos,
    at: new Date().toISOString(),
  };
  const updated = updateTracked(record.id, {
    review: { ...record.review, messages: [...messages, message] },
  })!;

  // Everyone else in the conversation hears about it.
  const payerId = record.fromUserId;
  const workerId = workerUserId(record);
  const notify = [
    ...(from !== "payer" ? [payerId] : []),
    ...(from !== "worker" && workerId ? [workerId] : []),
  ];
  const who = from === "reviewer" ? "The reviewer" : from === "payer" ? "The payer" : "The person being paid";
  for (const id of notify) {
    alertUser(id, {
      kind: "hold_under_review",
      title: `${who} wrote about a payment under review`,
      body: text.slice(0, 140),
      amountUsdc: record.amountUsdc,
      token: "USDC",
      transferId: input.transferId,
    });
  }
  if (from !== "reviewer") {
    for (const operator of config.auth.operatorUserIds) {
      alertUser(operator, {
        kind: "review_needed",
        title: "New message on a review",
        body: `${who}: ${text.slice(0, 120)}`,
        amountUsdc: record.amountUsdc,
        token: "USDC",
        transferId: input.transferId,
      });
    }
  }
  return { record: updated, message };
}

/** An operator's decision on a review. */
export async function decideReview(input: {
  transferId: string;
  operatorId: string;
  outcome: "release" | "refund";
  note: string;
}) {
  if (!config.auth.operatorUserIds.includes(input.operatorId)) {
    throw new HeldPaymentError("Operators only", 403);
  }
  const record = requireRecord(input.transferId);
  requirePending(record);
  if (record.review?.status !== "under_review") {
    throw new HeldPaymentError("There is no review open on this payment", 409);
  }
  const note = input.note.trim();
  if (note.length < 10) {
    throw new HeldPaymentError("Write down why — both people will see this");
  }
  const decidedAt = new Date().toISOString();
  if (input.outcome === "release") {
    updateTracked(record.id, {
      review: {
        ...record.review,
        decidedBy: input.operatorId,
        decisionNote: note.slice(0, 1000),
      },
    });
    const updated = await releaseToRecipient(
      requireRecord(input.transferId),
      "review_released",
    );
    alertUser(record.fromUserId, {
      kind: "hold_released",
      title: "Review decided",
      body: `${record.amountUsdc} USDC went to ${record.recipientId}. ${note}`,
      transferId: input.transferId,
    });
    return updated;
  }
  const updated = await refundToPayer(record, "review_refunded", {
    ...record.review,
    status: "refunded_to_payer",
    decidedAt,
    decidedBy: input.operatorId,
    decisionNote: note.slice(0, 1000),
  });
  const worker = workerUserId(record);
  if (worker) {
    alertUser(worker, {
      kind: "hold_refunded",
      title: "Review decided",
      body: `${record.amountUsdc} USDC went back to ${payerName(record)}. ${note}`,
      transferId: input.transferId,
    });
  }
  return updated;
}

// ─── Lists ────────────────────────────────────────────────────────────────

export function listHoldsFor(userId: string) {
  return listTrackedOnCurrentContract()
    .filter((r) => r.onChainTransferId)
    .map((r) => ({ record: r, role: roleFor(r, userId) }))
    .filter((x): x is { record: ProtectedEscrowRecord; role: HeldRole } => x.role !== null)
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

export function listOpenReviews(): ProtectedEscrowRecord[] {
  return listLocalPending().filter((r) => r.review?.status === "under_review");
}

export function holdFor(transferId: string, userId: string) {
  const record = requireRecord(transferId);
  const role = roleFor(record, userId);
  if (!role) throw new HeldPaymentError("No such held payment", 404);
  return { record, role };
}

// ─── The due-work pass ────────────────────────────────────────────────────

export type DueWorkResult = {
  released: number;
  reminded: number;
  nudged: number;
  extended: number;
  errors: string[];
};

/**
 * Does whatever is due on pending holds: releases jobs whose 7 days have run
 * out and cooling-off payments whose window has closed, reminds payers, nudges
 * about holds nearing expiry, and keeps reviewed holds from expiring.
 *
 * Runs from the scheduled tick, and also for one person's holds whenever they
 * open them, so a missed schedule delays a release rather than losing it.
 */
export async function runDueHeldPaymentWork(opts?: {
  onlyUserId?: string;
  now?: number;
}): Promise<DueWorkResult> {
  const now = opts?.now ?? Date.now();
  const result: DueWorkResult = { released: 0, reminded: 0, nudged: 0, extended: 0, errors: [] };
  const pending = listLocalPending().filter((r) => {
    if (!r.onChainTransferId) return false;
    if (!opts?.onlyUserId) return true;
    return roleFor(r, opts.onlyUserId) !== null;
  });

  for (const record of pending) {
    const step = nextAutomaticStep(record, now);
    if (!step) continue;
    try {
      switch (step.kind) {
        case "release":
          await releaseToRecipient(record, step.settledBy);
          result.released += 1;
          break;
        case "remind_payer":
          alertUser(record.fromUserId, {
            kind: "hold_release_soon",
            title: "Held payment releases tomorrow",
            body: `${record.amountUsdc} USDC goes to ${record.recipientId} on ${record.autoReleaseAt!.slice(0, 10)} unless you raise a problem.`,
            amountUsdc: record.amountUsdc,
            token: "USDC",
            transferId: record.onChainTransferId,
          });
          updateTracked(record.id, { reminderSentAt: new Date(now).toISOString() });
          result.reminded += 1;
          break;
        case "nudge_expiry": {
          const body = `Nothing has been marked delivered. ${record.amountUsdc} USDC goes back to the payer on ${record.expiresAt.slice(0, 10)}.`;
          alertUser(record.fromUserId, {
            kind: "hold_expiring",
            title: "A held payment ends soon",
            body,
            transferId: record.onChainTransferId,
          });
          const worker = workerUserId(record);
          if (worker) {
            alertUser(worker, {
              kind: "hold_expiring",
              title: "Mark your work delivered",
              body,
              transferId: record.onChainTransferId,
            });
          }
          updateTracked(record.id, { expiryNudgeSentAt: new Date(now).toISOString() });
          result.nudged += 1;
          break;
        }
        case "extend_expiry":
          await extendExpiryTo(record, step.untilMs);
          result.extended += 1;
          break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Kept on the record so a stuck release is visible, not silent.
      updateTracked(record.id, { lastAutoError: message.slice(0, 300) });
      result.errors.push(`${record.onChainTransferId}: ${message}`);
    }
  }
  return result;
}
