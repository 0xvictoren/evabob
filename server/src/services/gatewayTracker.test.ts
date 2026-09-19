/**
 * Gateway money in flight: when the tracker mints, when it asks Circle, how a
 * top-up is judged to have arrived, and that a top-up's activity row appears
 * only once the person has signed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "evabob-gw-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
// No network in tests: every balance read fails, so watches start from zero.
globalThis.fetch = (async () => {
  throw new Error("offline");
}) as typeof fetch;

const {
  ATTESTATION_MINT_WINDOW_MS,
  UNTRACEABLE_AFTER_MS,
  confirmTopUpSigned,
  depositProgress,
  listTracked,
  payNextStep,
  startTopUpWatch,
  trackGatewayPay,
} = await import("./gatewayTracker.js");
const { store } = await import("../store/db.js");

const T0 = Date.parse("2026-09-18T12:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe("a GA payment that did not land in the request", () => {
  const base = {
    status: "on_its_way" as const,
    createdAt: at(0),
    attestation: "0xatt",
    signature: "0xsig",
    transferId: "tr_1",
  };

  it("is minted by the server while the attestation is still valid", () => {
    assert.equal(payNextStep(base, T0 + 60_000), "mint");
  });

  it("asks Circle how it ended once the attestation has expired", () => {
    assert.equal(payNextStep(base, T0 + ATTESTATION_MINT_WINDOW_MS), "ask_circle");
  });

  it("asks Circle when there was never an attestation to mint", () => {
    assert.equal(
      payNextStep({ ...base, attestation: undefined, signature: undefined }, T0),
      "ask_circle",
    );
  });

  it("escalates one it has nothing to follow, after a while", () => {
    const blind = { status: "on_its_way" as const, createdAt: at(0) };
    assert.equal(payNextStep(blind, T0 + 60_000), null);
    assert.equal(payNextStep(blind, T0 + UNTRACEABLE_AFTER_MS), "give_up");
  });

  it("leaves settled payments alone", () => {
    assert.equal(payNextStep({ ...base, status: "complete" }, T0), null);
  });

  it("is recorded with its attestation so it can be finished later", () => {
    const id = trackGatewayPay({
      userId: "ada",
      transferId: "tr_9",
      attestation: "0xatt",
      signature: "0xsig",
      destinationDomain: 6,
      destinationAddress: "0x1111000000000000000000000000000000002222",
      amountUsdc: 5,
    });
    const row = listTracked("ada").find((r) => r.id === id);
    assert.equal(row?.kind, "pay");
    assert.equal(row && "attestation" in row ? row.attestation : null, "0xatt");
  });
});

describe("a GA top-up", () => {
  const baseline = { baselineUsdc: 10, baselineCreditedUsdc: 10, amountUsdc: 5 };

  it("is not seen until the balance moves", () => {
    assert.equal(
      depositProgress({ ...baseline, creditedUsdc: 10, arrivingUsdc: 0 }),
      "not_seen",
    );
  });

  it("is arriving while Gateway still counts it as pending", () => {
    // Base Sepolia deposits sit here for ~40 minutes before credit.
    assert.equal(
      depositProgress({ ...baseline, creditedUsdc: 10, arrivingUsdc: 5 }),
      "arriving",
    );
  });

  it("has arrived once it is credited, allowing for a small Gateway fee", () => {
    assert.equal(
      depositProgress({ ...baseline, creditedUsdc: 14.99, arrivingUsdc: 0 }),
      "credited",
    );
  });

  it("shows nothing until the person has signed, and only they can confirm it", async () => {
    const before = store.listActivity("bola", 100).length;
    const watchId = await startTopUpWatch({
      userId: "bola",
      depositor: "0x3333000000000000000000000000000000004444",
      domain: 6,
      amountUsdc: 5,
    });
    assert.equal(store.listActivity("bola", 100).length, before, "no row before the PIN");

    assert.equal(
      confirmTopUpSigned({ userId: "someone-else", watchId }),
      undefined,
      "another account cannot confirm it",
    );

    const confirmed = confirmTopUpSigned({ userId: "bola", watchId });
    assert.equal(confirmed?.status, "submitted");
    const rows = store.listActivity("bola", 100);
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0]!.status, "pending");
  });
});

describe("scheduled GA payments", () => {
it("a payment waiting for an approval is sent only once the approval is final", async () => {
  const { scheduledNextStep, SCHEDULED_PAY_TTL_MS, APPROVAL_MINING_GRACE_MS } = await import("./gatewayTracker.js");
  const t0 = Date.parse("2026-09-19T10:00:00Z");
  const r = { status: "waiting" as const, createdAt: new Date(t0).toISOString(), justApproved: true };
  const ready = { missingDomains: [], confirmingDomains: [] };
  const confirming = { missingDomains: [], confirmingDomains: [0] };
  const missing = { missingDomains: [6], confirmingDomains: [] };
  // Still confirming: wait; final: send.
  assert.equal(scheduledNextStep(r, confirming, t0 + 60_000), "wait");
  assert.equal(scheduledNextStep(r, ready, t0 + 16 * 60_000), "send");
  // Just approved: the approval may not even be mined yet, so wait a little.
  assert.equal(scheduledNextStep(r, missing, t0 + 60_000), "wait");
  assert.equal(scheduledNextStep(r, missing, t0 + APPROVAL_MINING_GRACE_MS + 1), "give_up");
  assert.equal(scheduledNextStep({ ...r, justApproved: false }, missing, t0 + 60_000), "give_up");
  // Never waits for ever, and never acts twice.
  assert.equal(scheduledNextStep(r, confirming, t0 + SCHEDULED_PAY_TTL_MS), "give_up");
  assert.equal(scheduledNextStep({ ...r, status: "sent" }, ready, t0), null);
});
});
