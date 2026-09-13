import assert from "node:assert/strict";
import test from "node:test";
import { ARC, validateArcBatchRequirement } from "./nanopay.js";

function validRequirement() {
  return {
    scheme: "exact",
    network: `eip155:${ARC.chain.id}`,
    asset: ARC.usdc,
    amount: "12500",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 604_900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC.gatewayWallet,
    },
  };
}

test("x402 policy prices the exact atomic amount that Circle signs", () => {
  assert.equal(validateArcBatchRequirement(validRequirement(), 2), 0.0125);
  assert.throws(
    () => validateArcBatchRequirement({
      ...validRequirement(),
      maxAmountRequired: "1",
    }, 2),
    /conflicting payment amounts/,
  );
});

test("x402 policy rejects a different network, token, or Gateway contract", () => {
  assert.throws(
    () => validateArcBatchRequirement({ ...validRequirement(), network: "eip155:1" }, 2),
    /Arc testnet/,
  );
  assert.throws(
    () => validateArcBatchRequirement({ ...validRequirement(), asset: "0x2222222222222222222222222222222222222222" }, 2),
    /Arc USDC/,
  );
  assert.throws(
    () => validateArcBatchRequirement({
      ...validRequirement(),
      extra: { ...validRequirement().extra, verifyingContract: "0x3333333333333333333333333333333333333333" },
    }, 2),
    /Circle Gateway/,
  );
});

test("x402 policy rejects unsafe numeric encodings and excessive validity", () => {
  assert.throws(
    () => validateArcBatchRequirement({ ...validRequirement(), amount: Number.MAX_SAFE_INTEGER + 1 }, 2),
    /invalid atomic/,
  );
  assert.throws(
    () => validateArcBatchRequirement({ ...validRequirement(), amount: "1e6" }, 2),
    /invalid atomic/,
  );
  assert.throws(
    () => validateArcBatchRequirement({ ...validRequirement(), maxTimeoutSeconds: 604_901 }, 2),
    /timeout/,
  );
});
