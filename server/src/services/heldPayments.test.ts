/**
 * The rules for held money, pinned without a chain.
 *
 * These were set by the product owner and written down before the first
 * dispute (docs/HELD_PAYMENTS.md): the worker marks delivered, the payer has
 * 7 days, silence pays the worker, a cancellation after delivery goes to a
 * person, and a cooling-off payment releases after 10 minutes unless the
 * sender cancels. The chain actions are covered by the contract tests; what
 * is tested here is when the server decides to take them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectedEscrowRecord } from "./mongo.js";

const scratch = mkdtempSync(join(tmpdir(), "evabob-held-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
// Holds are only acted on against the configured contract. Set before
// config.ts is first imported.
process.env.PAYMENT_ESCROW = "0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39";

const {
  actionsFor,
  JOB_REVIEW_MS,
  nextAutomaticStep,
  planAutoRelease,
  REVIEW_EXPIRY_BUFFER_MS,
  stageOf,
  viewFor,
} = await import("./heldPayments.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-18T12:00:00Z");

function job(patch: Partial<ProtectedEscrowRecord> = {}): ProtectedEscrowRecord {
  return {
    id: "r1",
    onChainTransferId: "1",
    contractAddress: "0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39",
    purpose: "job",
    fromUserId: "payer",
    recipientKind: "phone",
    recipientId: "worker",
    amountUsdc: 50,
    status: "pending",
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 90 * DAY).toISOString(),
    ...patch,
  };
}

describe("job holds", () => {
  it("does nothing on its own before the work is delivered", () => {
    assert.equal(nextAutomaticStep(job(), T0 + 10 * DAY), null);
    assert.equal(stageOf(job()), "waiting_for_delivery");
  });

  it("releases to the worker when the payer stays silent for 7 days", () => {
    // The defect this fixes: a silent payer used to get their money back at
    // expiry, and the worker who delivered got nothing.
    const delivered = job({
      deliveredAt: new Date(T0).toISOString(),
      autoReleaseAt: new Date(T0 + JOB_REVIEW_MS).toISOString(),
    });
    assert.equal(nextAutomaticStep(delivered, T0 + JOB_REVIEW_MS - 1)?.kind, "remind_payer");
    assert.deepEqual(nextAutomaticStep(delivered, T0 + JOB_REVIEW_MS), {
      kind: "release",
      settledBy: "auto_release",
    });
  });

  it("reminds the payer once, a day before release", () => {
    const delivered = job({
      deliveredAt: new Date(T0).toISOString(),
      autoReleaseAt: new Date(T0 + JOB_REVIEW_MS).toISOString(),
    });
    assert.equal(nextAutomaticStep(delivered, T0 + 2 * DAY), null, "not yet");
    assert.equal(nextAutomaticStep(delivered, T0 + 6.5 * DAY)?.kind, "remind_payer");
    const reminded = { ...delivered, reminderSentAt: new Date(T0 + 6.5 * DAY).toISOString() };
    assert.equal(nextAutomaticStep(reminded, T0 + 6.6 * DAY), null, "only once");
  });

  it("never releases or refunds on its own while a cancellation is under review", () => {
    const reviewed = job({
      deliveredAt: new Date(T0).toISOString(),
      autoReleaseAt: new Date(T0 + JOB_REVIEW_MS).toISOString(),
      review: {
        status: "under_review",
        openedAt: new Date(T0 + DAY).toISOString(),
        reason: "no_longer_needed",
        details: "The event was cancelled, so we no longer need the posters.",
      },
    });
    // Well past the 7 days: still nothing moves.
    assert.equal(nextAutomaticStep(reviewed, T0 + 20 * DAY), null);
    assert.equal(stageOf(reviewed), "under_review");
  });

  it("keeps a reviewed hold from expiring before a person decides", () => {
    const reviewed = job({
      expiresAt: new Date(T0 + 10 * DAY).toISOString(),
      review: {
        status: "under_review",
        openedAt: new Date(T0).toISOString(),
        reason: "other",
        details: "Details long enough to count as an explanation.",
      },
    });
    const step = nextAutomaticStep(reviewed, T0);
    assert.equal(step?.kind, "extend_expiry");
    assert.equal(
      step && "untilMs" in step ? step.untilMs : 0,
      T0 + REVIEW_EXPIRY_BUFFER_MS,
    );
  });

  it("nudges both people a week before an undelivered hold expires", () => {
    const h = job({ expiresAt: new Date(T0 + 6 * DAY).toISOString() });
    assert.equal(nextAutomaticStep(h, T0)?.kind, "nudge_expiry");
    const nudged = { ...h, expiryNudgeSentAt: new Date(T0).toISOString() };
    assert.equal(nextAutomaticStep(nudged, T0), null);
  });

  it("settled holds are left alone", () => {
    assert.equal(nextAutomaticStep(job({ status: "claimed" }), T0 + 100 * DAY), null);
    assert.equal(nextAutomaticStep(job({ status: "refunded" }), T0 + 100 * DAY), null);
  });
});

describe("auto-release timing", () => {
  it("releases 7 days after delivery when the hold has room", () => {
    const plan = planAutoRelease({
      deliveredAtMs: T0 + 10 * DAY,
      createdAtMs: T0,
      expiresAtMs: T0 + 90 * DAY,
    });
    assert.equal(plan.autoReleaseAtMs, T0 + 17 * DAY);
    assert.equal(plan.extendExpiryToMs, null);
  });

  it("extends a hold delivered near its expiry so the release lands first", () => {
    // Delivered on day 88 of 90: without an extension the refund would open
    // before the payer's 7 days ran out.
    const plan = planAutoRelease({
      deliveredAtMs: T0 + 88 * DAY,
      createdAtMs: T0,
      expiresAtMs: T0 + 90 * DAY,
    });
    assert.equal(plan.autoReleaseAtMs, T0 + 95 * DAY);
    assert.ok(plan.extendExpiryToMs! > plan.autoReleaseAtMs);
  });

  it("never plans past the contract's one-year ceiling", () => {
    const plan = planAutoRelease({
      deliveredAtMs: T0 + 364 * DAY,
      createdAtMs: T0,
      expiresAtMs: T0 + 364.5 * DAY,
    });
    assert.ok(plan.extendExpiryToMs! <= T0 + 365 * DAY);
    assert.ok(plan.autoReleaseAtMs < plan.extendExpiryToMs!);
  });
});

describe("who may do what", () => {
  it("before delivery: the payer may confirm or cancel; the worker may deliver or give back", () => {
    assert.deepEqual(actionsFor(job(), "payer"), ["confirm", "cancel"]);
    assert.deepEqual(actionsFor(job(), "worker"), ["mark_delivered", "give_back"]);
  });

  it("after delivery a payer's cancel needs the reconciliation form", () => {
    const delivered = job({ deliveredAt: new Date(T0).toISOString() });
    assert.deepEqual(actionsFor(delivered, "payer"), ["confirm", "cancel_with_reason"]);
    assert.ok(!actionsFor(delivered, "payer").includes("cancel"));
  });

  it("under review the worker can answer, and the payer can still just pay", () => {
    const reviewed = job({
      deliveredAt: new Date(T0).toISOString(),
      review: {
        status: "under_review",
        openedAt: new Date(T0).toISOString(),
        reason: "not_as_agreed",
        details: "The files were the wrong size for print.",
      },
    });
    assert.deepEqual(actionsFor(reviewed, "worker"), ["respond", "give_back"]);
    assert.deepEqual(actionsFor(reviewed, "payer"), ["confirm"]);
  });

  it("the reviewer's identity is never shown to either person", () => {
    const decided = job({
      status: "refunded",
      review: {
        status: "refunded_to_payer",
        openedAt: new Date(T0).toISOString(),
        reason: "not_received",
        details: "Nothing arrived by the agreed date at all.",
        decidedBy: "operator-user-id",
        decisionNote: "No delivery evidence was provided.",
      },
    });
    const view = viewFor(decided, "worker");
    assert.equal((view.review as Record<string, unknown>).decidedBy, undefined);
    assert.equal(view.review?.decisionNote, "No delivery evidence was provided.");
  });
});

describe("cooling-off holds", () => {
  const cooling = (patch: Partial<ProtectedEscrowRecord> = {}) =>
    job({
      purpose: "cooling_off",
      releaseAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
      expiresAt: new Date(T0 + DAY).toISOString(),
      ...patch,
    });

  it("can be cancelled by the sender inside the window, and not after", () => {
    assert.deepEqual(actionsFor(cooling(), "payer", T0 + 60_000), ["cancel"]);
    assert.deepEqual(actionsFor(cooling(), "payer", T0 + 11 * 60_000), []);
  });

  it("releases once the window has passed", () => {
    assert.equal(nextAutomaticStep(cooling(), T0 + 9 * 60_000), null);
    assert.deepEqual(nextAutomaticStep(cooling(), T0 + 10 * 60_000), {
      kind: "release",
      settledBy: "cooling_off_elapsed",
    });
  });

  it("gives the recipient nothing to do", () => {
    assert.deepEqual(actionsFor(cooling(), "worker"), []);
  });
});

describe("the review conversation", async () => {
  const { addReviewMessage, HeldPaymentError, viewFor: view } = await import("./heldPayments.js");
  const { trackProtectedEscrow, updateTracked } = await import("./escrow-jobs.js");
  const { store } = await import("../store/db.js");

  store.upsertUser({ id: "conv-payer", email: "conv-payer@example.com", displayName: "Payer", evmAddress: "0x" + "5".repeat(40) });
  store.upsertUser({ id: "conv-worker", email: "conv-worker@example.com", displayName: "Worker", evmAddress: "0x" + "6".repeat(40) });
  store.getUser("conv-worker")!.handle = "convworker";
  store.upsertUser({ id: "conv-stranger", email: "conv-stranger@example.com", displayName: "Stranger", evmAddress: "0x" + "7".repeat(40) });

  const tracked = trackProtectedEscrow({
    onChainTransferId: "9001",
    purpose: "job",
    fromUserId: "conv-payer",
    recipientKind: "phone",
    recipientId: "convworker",
    amountUsdc: 30,
    createTx: "0x" + "c".repeat(64),
    expiresInMs: 30 * DAY,
  });
  const openReview = () =>
    updateTracked(tracked.id, {
      deliveredAt: new Date().toISOString(),
      review: {
        status: "under_review",
        openedAt: new Date().toISOString(),
        reason: "not_as_agreed",
        details: "The print is blurry.",
      },
    });

  it("lets both people and the reviewer talk, each with evidence", () => {
    openReview();
    addReviewMessage({ transferId: "9001", userId: "conv-payer", text: "Photo of the print attached.", photos: ["/uploads/evidence_" + "a".repeat(32) + ".jpg"] });
    addReviewMessage({ transferId: "9001", userId: "conv-worker", text: "It was sharp when it left.", links: ["https://files.example.com/proof"] });
    const { record } = addReviewMessage({ transferId: "9001", userId: "op", asReviewer: true, text: "Which courier did you use?" });
    const msgs = record.review!.messages!;
    assert.deepEqual(msgs.map((m) => m.from), ["payer", "worker", "reviewer"]);
    assert.equal(msgs[0]!.photos.length, 1);
    assert.equal(msgs[1]!.links[0], "https://files.example.com/proof");
    // Both people see the conversation; nobody sees who the reviewer is.
    const seen = view(record, "worker");
    assert.equal(seen.review?.messages?.length, 3);
    assert.equal(JSON.stringify(seen).includes('"op"'), false);
  });

  it("keeps out strangers, stray files and closed reviews", () => {
    openReview();
    assert.throws(() => addReviewMessage({ transferId: "9001", userId: "conv-stranger", text: "hi" }), HeldPaymentError);
    // Only evidence uploads are accepted as photos; anything else is dropped.
    const { message } = addReviewMessage({ transferId: "9001", userId: "conv-payer", text: "See this", photos: ["/uploads/avatar_" + "b".repeat(32) + ".jpg", "https://evil.example/x.jpg"] });
    assert.deepEqual(message.photos, []);
    updateTracked(tracked.id, { review: { ...tracked.review!, status: "refunded_to_payer", openedAt: "", reason: "", details: "" } });
    assert.throws(() => addReviewMessage({ transferId: "9001", userId: "conv-payer", text: "one more" }), HeldPaymentError);
  });
});
