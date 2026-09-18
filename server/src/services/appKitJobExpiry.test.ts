import test from "node:test";
import assert from "node:assert/strict";

import {
  BALANCE_DUST,
  CCTP_V2_TOKEN_MESSENGER,
  OPEN_CHALLENGE_GRACE_MS,
  STALE_JOB_MS,
  classifyChallenge,
  decideExpiredJobAbandon,
  decideRunnerFailure,
  sourceFundsMoved,
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

test("runner failure: burned bridge stays running so Continue can mint", () => {
  const d = decideRunnerFailure({
    op: "bridge",
    burnFound: true,
    anyTxHash: true,
    balanceBefore: 20,
    balanceNow: 20,
    amount: 5,
  });
  assert.equal(d.outcome, "keep_running");
  assert.equal(d.stage, "sent");
});

test("runner failure: bridge whose source balance dropped is never failed", () => {
  const d = decideRunnerFailure({
    op: "bridge",
    burnFound: false,
    anyTxHash: true,
    balanceBefore: 20,
    balanceNow: 15,
    amount: 5,
  });
  assert.equal(d.outcome, "keep_running");
});

test("runner failure: approve-only bridge with unchanged balance fails", () => {
  const d = decideRunnerFailure({
    op: "bridge",
    burnFound: false,
    anyTxHash: true,
    balanceBefore: 20,
    balanceNow: 20,
    amount: 5,
  });
  assert.equal(d.outcome, "failed");
});

test("runner failure: deposit that moved money succeeded", () => {
  const d = decideRunnerFailure({
    op: "deposit",
    burnFound: false,
    anyTxHash: true,
    balanceBefore: 20,
    balanceNow: 10,
    amount: 10,
  });
  assert.equal(d.outcome, "succeeded");
  assert.equal(d.stage, "arrived");
});

test("runner failure: unreadable balance after a broadcast keeps the job", () => {
  const d = decideRunnerFailure({
    op: "deposit",
    burnFound: false,
    anyTxHash: true,
    balanceBefore: null,
    balanceNow: null,
    amount: 10,
  });
  assert.equal(d.outcome, "keep_running");
});

test("runner failure: nothing signed and nothing moved fails", () => {
  const d = decideRunnerFailure({
    op: "send",
    burnFound: false,
    anyTxHash: false,
    balanceBefore: null,
    balanceNow: null,
    amount: 10,
  });
  assert.equal(d.outcome, "failed");
});

test("source funds moved: an incoming payment cannot fake a movement", () => {
  assert.equal(sourceFundsMoved({ balanceBefore: 20, balanceNow: 25, amount: 5 }), false);
  assert.equal(sourceFundsMoved({ balanceBefore: 20, balanceNow: 19.99, amount: 5 }), false);
  assert.equal(sourceFundsMoved({ balanceBefore: 20, balanceNow: 17, amount: 5 }), true);
  assert.equal(sourceFundsMoved({ balanceBefore: null, balanceNow: 17, amount: 5 }), null);
});
// ─── Abandoned bridges (the 40-minute rule) ───────────────────────────────

import {
  abandonedBridgeDue,
  bridgeAbandonWindowMs,
  bridgeRelayRecord,
} from "./appKitJobExpiry.js";

test("abandoned bridge: the window defaults to 40 minutes", () => {
  assert.equal(bridgeAbandonWindowMs(undefined), 40 * 60_000);
  assert.equal(bridgeAbandonWindowMs("15"), 15 * 60_000);
  assert.equal(bridgeAbandonWindowMs("nonsense"), 40 * 60_000);
});

test("abandoned bridge: the person keeps the whole window to finish it", () => {
  const burnAtMs = Date.parse("2026-09-18T10:00:00Z");
  const windowMs = 40 * 60_000;
  assert.equal(
    abandonedBridgeDue({ burnAtMs, jobCreatedAtMs: burnAtMs - 60_000, nowMs: burnAtMs + windowMs - 1, windowMs }),
    false,
  );
  assert.equal(
    abandonedBridgeDue({ burnAtMs, jobCreatedAtMs: burnAtMs - 60_000, nowMs: burnAtMs + windowMs, windowMs }),
    true,
  );
});

test("abandoned bridge: timed from the burn, not from when the server noticed", () => {
  // A job created at 10:00 whose burn landed at 10:05 is due at 10:45.
  const created = Date.parse("2026-09-18T10:00:00Z");
  const burned = created + 5 * 60_000;
  const windowMs = 40 * 60_000;
  assert.equal(
    abandonedBridgeDue({ burnAtMs: burned, jobCreatedAtMs: created, nowMs: created + windowMs, windowMs }),
    false,
  );
});

test("abandoned bridge: an unreadable burn time can only bring the rescue forward", () => {
  // Job creation is never after the burn, so falling back to it can make the
  // server step in sooner, never leave money waiting longer.
  const created = Date.parse("2026-09-18T10:00:00Z");
  const windowMs = 40 * 60_000;
  assert.equal(
    abandonedBridgeDue({ burnAtMs: null, jobCreatedAtMs: created, nowMs: created + windowMs, windowMs }),
    true,
  );
});

test("abandoned bridge: the 2x gas charge is recorded and not collected on testnet", () => {
  const r = bridgeRelayRecord({
    gasCostWei: 1_500n,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    deploymentEnv: "testnet",
  });
  assert.equal(r.gasCostWei, "1500");
  assert.equal(r.wouldChargeWei, "3000");
  assert.equal(r.charged, false);
  assert.equal(r.reason, "waived_on_testnet");
  assert.equal(
    bridgeRelayRecord({ gasCostWei: 1n, nativeSymbol: "ETH", nativeDecimals: 18, deploymentEnv: "production" }).reason,
    "collection_not_decided",
  );
});

test("a bridge lands the amount less Circle's fast fee, never more", async () => {
  const { landedAfterFastFee } = await import("./appKitJobExpiry.js");
  // Base Sepolia → Arc charges 1.3 bps: 100 USDC lands as 99.987.
  assert.deepEqual(landedAfterFastFee(100, 1.3), { fee: 0.013, landed: 99.987 });
  // Rounding favours the honest figure: the fee rounds up.
  assert.deepEqual(landedAfterFastFee(0.5, 1.3), { fee: 0.000065, landed: 0.499935 });
  assert.deepEqual(landedAfterFastFee(1, 1), { fee: 0.0001, landed: 0.9999 });
  // Arc → Base charges nothing today.
  assert.deepEqual(landedAfterFastFee(25, 0), { fee: 0, landed: 25 });
  assert.deepEqual(landedAfterFastFee(0, 1), { fee: 0, landed: 0 });
});
