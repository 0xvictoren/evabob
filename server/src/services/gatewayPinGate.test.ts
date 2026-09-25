/**
 * With GATEWAY_PAY_REQUIRE_PIN on, a GA payment waits for a PIN challenge that
 * only its own person can complete, and is released exactly once.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.GATEWAY_PAY_REQUIRE_PIN = "true";

const {
  PIN_WINDOW_MS,
  __resetParkedPayments,
  gatewayPayNeedsPin,
  isParkedChallenge,
  parkForPin,
  pinMessageFor,
  releaseConfirmed,
} = await import("./gatewayPinGate.js");

const payment = {
  userId: "user-a",
  depositor: `0x${"a".repeat(40)}` as `0x${string}`,
  amountUsdc: 5,
  destinationDomain: 6,
  destinationAddress: `0x${"b".repeat(40)}`,
};

describe("GA payment PIN gate", () => {
  beforeEach(() => __resetParkedPayments());

  it("is read from GATEWAY_PAY_REQUIRE_PIN", () => {
    assert.equal(gatewayPayNeedsPin(), true);
  });

  it("names the payment on the PIN screen", () => {
    assert.equal(
      pinMessageFor(payment),
      "Evabob: pay 5 USDC from your Gateway Account to 0xbbbb…bbbb",
    );
  });

  it("releases a payment once its own person confirms the PIN", () => {
    parkForPin("ch-1", payment);
    assert.equal(isParkedChallenge("ch-1"), true);
    const out = releaseConfirmed("user-a", ["ch-1"]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.amountUsdc, 5);
    assert.equal(isParkedChallenge("ch-1"), false);
  });

  it("never releases the same payment twice", () => {
    parkForPin("ch-2", payment);
    assert.equal(releaseConfirmed("user-a", ["ch-2"]).length, 1);
    assert.equal(releaseConfirmed("user-a", ["ch-2"]).length, 0);
  });

  it("does not release someone else's payment", () => {
    parkForPin("ch-3", payment);
    assert.equal(releaseConfirmed("user-b", ["ch-3"]).length, 0);
    // Still waiting for its own person.
    assert.equal(isParkedChallenge("ch-3"), true);
  });

  it("drops a payment whose PIN never came", () => {
    const start = 1_000_000;
    parkForPin("ch-4", payment, start);
    assert.equal(releaseConfirmed("user-a", ["ch-4"], start + PIN_WINDOW_MS + 1).length, 0);
    assert.equal(isParkedChallenge("ch-4"), false);
  });
});
