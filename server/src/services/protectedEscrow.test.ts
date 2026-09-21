/**
 * Rules for held payments that must hold without a chain to check against.
 *
 * Two of these encode bugs that cost real money on Arc. One live transfer was
 * created with an email hashed as a *handle*, producing a key nothing could
 * ever resolve — 1.449301 USDC that could not have been claimed even before
 * it expired. And `claimWithAttestation` pays whatever address it is handed
 * without ever comparing it to the stored `recipientKey`, so the binding
 * between "who this money is for" and "who gets paid" exists only in the
 * server. These pin the server half.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeFunctionData,
} from "viem";
import { paymentEscrowAbi } from "../abis/escrow.js";
import {
  CLAIM_LINK_EXPIRY_SECONDS,
  EscrowError,
  JOB_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  escrowIdentityKind,
  escrowRecipientKey,
  planProtectedEscrow,
} from "./protectedEscrow.js";

describe("identity typing", () => {
  it("types an email address as an email", () => {
    // The bug: this was hashed as a handle, and the key resolved to nothing.
    assert.equal(escrowIdentityKind("maya@example.com"), "email");
    assert.equal(escrowRecipientKey("maya@example.com").kind, "email");
  });

  it("types an @handle as a handle", () => {
    assert.equal(escrowIdentityKind("@maya"), "handle");
    assert.equal(escrowRecipientKey("@maya").normalized, "maya");
  });

  it("normalises case and whitespace before hashing", () => {
    // Keys are exact hashes, so "Maya@Example.com" and "maya@example.com"
    // must not become two different recipients.
    assert.equal(
      escrowRecipientKey("  MAYA@Example.COM ").key,
      escrowRecipientKey("maya@example.com").key,
    );
  });

  it("gives an email and a handle of the same text different keys", () => {
    // Precisely the mismatch that stranded a live transfer.
    assert.notEqual(
      escrowRecipientKey("maya@example.com").key,
      escrowRecipientKey("@maya@example.com").key,
    );
  });

  it("refuses something that is neither", () => {
    assert.throws(() => escrowRecipientKey("   "), EscrowError);
  });
});

describe("planning a hold", () => {
  it("produces approve then create, in that order", () => {
    // The contract pulls funds with transferFrom, so an approve that runs
    // second would leave createTransfer reverting.
    const plan = planProtectedEscrow({
      recipientId: "@maya",
      amountUsdc: 5,
      purpose: "claim_link",
    });
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0]!.step, "approve");
    assert.equal(plan.steps[1]!.step, "create");
  });

  it("gives a claim link a week and a job three months", () => {
    assert.equal(
      planProtectedEscrow({
        recipientId: "@maya",
        amountUsdc: 5,
        purpose: "claim_link",
      }).expirySeconds,
      CLAIM_LINK_EXPIRY_SECONDS,
    );
    assert.equal(
      planProtectedEscrow({
        recipientId: "@maya",
        amountUsdc: 5,
        purpose: "job",
      }).expirySeconds,
      JOB_EXPIRY_SECONDS,
    );
  });

  it("clamps to the contract ceiling instead of reverting on chain", () => {
    // createTransfer reverts with InvalidExpiry above MAX_EXPIRY, which would
    // fail after the user had already approved and paid gas.
    const plan = planProtectedEscrow({
      recipientId: "@maya",
      amountUsdc: 5,
      purpose: "job",
      expirySeconds: 400 * 24 * 60 * 60,
    });
    assert.equal(plan.expirySeconds, MAX_EXPIRY_SECONDS);
  });

  it("refuses a non-positive amount", () => {
    for (const amountUsdc of [0, -1]) {
      assert.throws(
        () =>
          planProtectedEscrow({
            recipientId: "@maya",
            amountUsdc,
            purpose: "claim_link",
          }),
        EscrowError,
      );
    }
  });

  it("carries the recipient key the release path will check against", () => {
    const plan = planProtectedEscrow({
      recipientId: "@maya",
      amountUsdc: 5,
      purpose: "claim_link",
    });
    assert.equal(plan.recipientKey, escrowRecipientKey("@maya").key);
  });

  it("blocks new email-based on-chain holds while the privacy gate is off", () => {
    assert.throws(
      () => planProtectedEscrow({
        recipientId: "maya@example.com",
        amountUsdc: 5,
        purpose: "claim_link",
      }),
      /disabled for privacy/,
    );
  });

  it("puts only an opaque random reference in contract calldata", () => {
    const plan = planProtectedEscrow({
      recipientId: "@maya",
      amountUsdc: 5,
      memo: "Private medical invoice",
      purpose: "job",
    });
    const decoded = decodeFunctionData({
      abi: paymentEscrowAbi,
      data: plan.steps[1]!.data,
    });
    assert.equal(decoded.functionName, "createTransfer");
    const reference = String(decoded.args[3]);
    assert.match(reference, /^evb_[a-f0-9]{32}$/);
    assert.ok(!reference.includes("Private"));
  });
});
