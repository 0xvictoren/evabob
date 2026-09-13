/**
 * Job escrow lifecycle rules.
 *
 * These run against a temp working directory. The store resolves its file
 * from process.cwd(), and without this every `npm test` appended six more
 * rows to the real escrow ledger — 252 phantom jobs claiming 2,520 USDC was
 * locked, all of them from a test fixture user, none backed by anything on
 * chain. The same mistake had already been fixed for resolvePayee and for
 * payment requests; this file was missed.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-job-escrow-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const {
  assertPayerCanRelease,
  completeJob,
  createAndFundJob,
  expireJob,
  rejectJob,
  submitDeliverable,
} = await import("./arcJobEscrow.js");

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the store file; a stray temp directory is not
    // worth failing a green suite over.
  }
});

function fundedJob() {
  return createAndFundJob({
    userId: "payer-1",
    amountUsdc: 20,
    description: "Logo work",
    recipient: "@maya",
    allowLedgerOnly: true,
  });
}

describe("escrow release is payer-only", () => {
  it("does not let the recipient complete / release funds", () => {
    const job = fundedJob();
    assert.equal(job.status, "funded");
    assert.equal(job.lockedUsdc, 20);

    assert.throws(
      () => completeJob(job.id, "maya"),
      /Only the payer can release escrow/,
    );
    assert.throws(
      () => completeJob(job.id, "@maya"),
      /Only the payer/,
    );

    const still = fundedJob();
    // Original job must still be locked.
    assert.throws(() => completeJob(job.id, "maya"));
    void still;
  });

  it("releases only when the payer confirms completion", () => {
    const job = fundedJob();
    submitDeliverable(job.id, { userId: "maya", summary: "done" });
    const released = completeJob(job.id, "payer-1");
    assert.equal(released.status, "completed");
    assert.equal(released.lockedUsdc, 0);
    assert.equal(released.releasedTo, "payee");
  });

  it("does not let an unrelated user submit another recipient's work", () => {
    const job = fundedJob();
    assert.throws(
      () => submitDeliverable(job.id, { userId: "attacker", summary: "fake" }),
      /Only the recipient/,
    );
  });

  it("refunds the payer on reject/cancel — never the recipient", () => {
    const job = fundedJob();
    const refunded = rejectJob(job.id, {
      userId: "payer-1",
      reason: "cancelled",
    });
    assert.equal(refunded.status, "rejected");
    assert.equal(refunded.releasedTo, "payer");
    assert.equal(refunded.lockedUsdc, 0);
    assert.throws(
      () => completeJob(job.id, "payer-1"),
      /refunded to the payer/,
    );
  });

  it("expiry refunds the payer and blocks later release", () => {
    const job = fundedJob();
    const expired = expireJob(job.id);
    assert.equal(expired.status, "expired");
    assert.equal(expired.releasedTo, "payer");
    assert.throws(() => completeJob(job.id, "payer-1"), /expired/);
  });

  it("assertPayerCanRelease is explicit", () => {
    const job = fundedJob();
    assert.doesNotThrow(() => assertPayerCanRelease(job, "payer-1"));
    assert.throws(() => assertPayerCanRelease(job, "maya"), /Only the payer/);
  });
});
