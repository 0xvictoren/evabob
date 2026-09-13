import test from "node:test";
import assert from "node:assert/strict";

import {
  BALANCE_DUST,
  CCTP_V2_TOKEN_MESSENGER,
  OPEN_CHALLENGE_GRACE_MS,
  STALE_JOB_MS,
  classifyChallenge,
  decideExpiredJobAbandon,
  fundsIntactFromSnapshot,
  fundsIntactMessage,
  isTokenMessengerAddress,
  parseBalance,
} from "./appKitJobExpiry.js";

const expired = { settled: false, dead: true };
const pending = { settled: false, dead: false };
const settled = { settled: true, dead: false };

test("snapshot: current matching before is intact", () => {
  assert.equal(fundsIntactFromSnapshot(12.5, 12.5), true);
  assert.equal(fundsIntactFromSnapshot(12.5, 12.5 + BALANCE_DUST / 2), true);
});

test("snapshot: drop larger than dust is not intact", () => {
  assert.equal(fundsIntactFromSnapshot(12.5, 7.5), false);
});

test("expired PIN + matching snapshot → drop job, funds intact", () => {
  const d = decideExpiredJobAbandon({
    challenges: [expired],
    live: false,
    jobAgeMs: 20 * 60 * 1000,
    balanceBefore: 20.99,
    balanceNow: 20.99,
    amount: 5,
  });
  assert.equal(d.abandon, true);
  assert.equal(d.fundsIntact, true);
});

test("expired PIN + source balance dropped by the bridge amount → keep job", () => {
  const d = decideExpiredJobAbandon({
    challenges: [expired],
    live: false,
    jobAgeMs: 20 * 60 * 1000,
    balanceBefore: 20,
    balanceNow: 10,
    amount: 10,
    settledLooksLikeBurn: true,
  });
  assert.equal(d.abandon, false);
});

test("approve settled + burn expired, snapshot intact → drop", () => {
  const d = decideExpiredJobAbandon({
    challenges: [settled, expired],
    live: false,
    jobAgeMs: 20 * 60 * 1000,
    balanceBefore: 20,
    balanceNow: 20,
    settledLooksLikeBurn: false,
  });
  assert.equal(d.abandon, true);
});

test("open PIN within grace, even if live, is not abandoned", () => {
  const d = decideExpiredJobAbandon({
    challenges: [pending],
    live: true,
    jobAgeMs: OPEN_CHALLENGE_GRACE_MS - 1000,
  });
  assert.equal(d.abandon, false);
});

test("all settled challenges are recovered, not abandoned", () => {
  const d = decideExpiredJobAbandon({
    challenges: [settled],
    live: false,
    jobAgeMs: 20 * 60 * 1000,
    settledLooksLikeBurn: true,
  });
  assert.equal(d.abandon, false);
});

test("no snapshot, nothing signed, expired → drop", () => {
  const d = decideExpiredJobAbandon({
    challenges: [expired],
    live: false,
    jobAgeMs: 20 * 60 * 1000,
    statusesKnown: true,
  });
  assert.equal(d.abandon, true);
});

test("stale job with matching snapshot → drop", () => {
  const d = decideExpiredJobAbandon({
    challenges: [],
    live: false,
    jobAgeMs: STALE_JOB_MS + 1,
    balanceBefore: 5,
    balanceNow: 5,
  });
  assert.equal(d.abandon, true);
});

test("TokenMessenger address is a burn; USDC token is not", () => {
  assert.equal(isTokenMessengerAddress(CCTP_V2_TOKEN_MESSENGER), true);
  assert.equal(
    isTokenMessengerAddress("0x3600000000000000000000000000000000000000"),
    false,
  );
});

test("parseBalance accepts numeric strings", () => {
  assert.equal(parseBalance("12.5"), 12.5);
  assert.equal(parseBalance(3), 3);
});

test("notify copy mentions the remaining balance", () => {
  assert.match(fundsIntactMessage(20.99), /20\.99/);
});

test("COMPLETE challenge is settled", () => {
  const c = classifyChallenge({ status: "COMPLETE" });
  assert.equal(c.settled, true);
  assert.equal(c.dead, false);
});

test("PENDING challenge with no transaction is not settled", () => {
  const c = classifyChallenge({ status: "PENDING" });
  assert.equal(c.settled, false);
});

test("PENDING challenge whose tx already has a hash is settled", () => {
  const c = classifyChallenge({
    status: "PENDING",
    txHash: "0x" + "ab".repeat(32),
    txState: "SENT",
  });
  assert.equal(c.settled, true);
});

test("FAILED and EXPIRED challenges are dead", () => {
  assert.equal(classifyChallenge({ status: "EXPIRED" }).dead, true);
  assert.equal(classifyChallenge({ status: "FAILED" }).dead, true);
});
