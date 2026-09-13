import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyChallenge,
  unwrapCircleChallenge,
  unwrapCircleTransaction,
} from "./circle-ucw.js";

const HASH =
  "0x375f52e3aa1c4d2b9e7f8a06b5c4d3e2f1a09b8c7d6e5f4a3b2c1d0e9f8a7b6c";

test("COMPLETE challenge is settled", () => {
  assert.deepEqual(classifyChallenge({ challengeStatus: "COMPLETE" }), {
    settled: true,
    dead: false,
  });
});

test("PENDING challenge with no transaction is not settled", () => {
  assert.deepEqual(classifyChallenge({ challengeStatus: "PENDING" }), {
    settled: false,
    dead: false,
  });
});

// The regression this whole change exists for: the burn landed on Arc but the
// challenge record still read PENDING, so the app aborted before attestation.
test("PENDING challenge whose tx already has a hash is settled", () => {
  assert.deepEqual(
    classifyChallenge({ challengeStatus: "PENDING", txHash: HASH }),
    { settled: true, dead: false },
  );
});

test("IN_PROGRESS challenge with a SENT transaction is settled", () => {
  assert.deepEqual(
    classifyChallenge({ challengeStatus: "IN_PROGRESS", txState: "SENT" }),
    { settled: true, dead: false },
  );
});

test("IN_PROGRESS challenge with no transaction state is not settled", () => {
  assert.deepEqual(classifyChallenge({ challengeStatus: "IN_PROGRESS" }), {
    settled: false,
    dead: false,
  });
});

test("FAILED and EXPIRED challenges are dead, never settled", () => {
  for (const challengeStatus of ["FAILED", "EXPIRED"]) {
    assert.deepEqual(
      classifyChallenge({ challengeStatus }),
      { settled: false, dead: true },
      `${challengeStatus} should be dead`,
    );
  }
});

test("a rejected transaction is dead even when it carries a hash", () => {
  for (const txState of ["FAILED", "DENIED", "CANCELLED"]) {
    assert.deepEqual(
      classifyChallenge({
        challengeStatus: "IN_PROGRESS",
        txHash: HASH,
        txState,
      }),
      { settled: false, dead: true },
      `${txState} should be dead`,
    );
  }
});

test("a malformed tx hash does not settle a pending challenge", () => {
  assert.deepEqual(
    classifyChallenge({ challengeStatus: "PENDING", txHash: "0xdeadbeef" }),
    { settled: false, dead: false },
  );
});

test("status and state comparisons are case-insensitive", () => {
  assert.deepEqual(
    classifyChallenge({ challengeStatus: "complete" }),
    { settled: true, dead: false },
  );
  assert.deepEqual(
    classifyChallenge({ challengeStatus: "pending", txState: "confirmed" }),
    { settled: true, dead: false },
  );
});

test("missing status defaults to PENDING rather than settling", () => {
  assert.deepEqual(classifyChallenge({}), { settled: false, dead: false });
});

test("unwraps GET /v1/w3s/user/challenges/{id} nested { challenge } payload", () => {
  const inner = unwrapCircleChallenge({
    challenge: {
      id: "6d8aa8c6-c6b3-5bd4-9ff1-3a4ba46b60b2",
      status: "COMPLETE",
      correlationIds: ["970763dc-924b-5383-9539-fa5cf4aa712b"],
    },
  });
  assert.equal(inner?.status, "COMPLETE");
  assert.equal(inner?.correlationIds?.[0], "970763dc-924b-5383-9539-fa5cf4aa712b");
});

test("unwraps a flattened challenge payload", () => {
  assert.equal(
    unwrapCircleChallenge({ status: "PENDING", correlationIds: [] })?.status,
    "PENDING",
  );
});

test("unwraps GET transaction nested { transaction } payload", () => {
  const tx = unwrapCircleTransaction({
    transaction: { txHash: HASH, state: "COMPLETE" },
  });
  assert.equal(tx?.txHash, HASH);
  assert.equal(tx?.state, "COMPLETE");
});
