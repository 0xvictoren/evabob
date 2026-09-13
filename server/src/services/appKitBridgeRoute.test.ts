import test from "node:test";
import assert from "node:assert/strict";

import {
  ARC_USDC_GAS_RESERVE,
  assertMintRecipient,
  parseBridgeAmount,
  planUsdcCctpHop,
  ZERO_ADDRESS,
} from "./appKitBridgeRoute.js";

test("USDC any product pair is a direct CCTP hop", () => {
  const hop = planUsdcCctpHop({
    fromChain: "Base_Sepolia",
    toChain: "Ethereum_Sepolia",
  });
  assert.equal(hop.kind, "cctp");
});

test("same chain is rejected", () => {
  assert.throws(
    () =>
      planUsdcCctpHop({
        fromChain: "Arc_Testnet",
        toChain: "Arc_Testnet",
      }),
    /must differ/,
  );
});

test("amount parser rejects scientific notation, zero, overflow", () => {
  assert.equal(parseBridgeAmount("5"), "5");
  assert.equal(parseBridgeAmount(1.5), "1.5");
  assert.throws(() => parseBridgeAmount("1e18"), /decimal/);
  assert.throws(() => parseBridgeAmount("-5"), /decimal/);
  assert.throws(() => parseBridgeAmount("0"), /positive/);
  assert.throws(() => parseBridgeAmount("0x10"), /decimal/);
  assert.throws(() => parseBridgeAmount(1_000_001), /max/);
});

test("mint recipient rejects zero and non-0x", () => {
  assert.equal(
    assertMintRecipient("0x4a212fdb747d9063a1ca3774888a94c6bdc50cbf"),
    "0x4a212fdb747d9063a1ca3774888a94c6bdc50cbf",
  );
  assert.throws(() => assertMintRecipient(ZERO_ADDRESS), /zero address/);
  assert.throws(() => assertMintRecipient("not-an-address"), /0x EVM/);
  assert.equal(assertMintRecipient(undefined), undefined);
});

test("Arc gas reserve is a small positive USDC amount", () => {
  assert.ok(ARC_USDC_GAS_RESERVE > 0 && ARC_USDC_GAS_RESERVE < 1);
});

const CHAINS = ["Arc_Testnet", "Base_Sepolia", "Ethereum_Sepolia"] as const;

test("every product pair is either a hop or a same-chain rejection", () => {
  let ok = 0;
  let blocked = 0;
  for (const from of CHAINS) {
    for (const to of CHAINS) {
      try {
        planUsdcCctpHop({ fromChain: from, toChain: to });
        if (from === to) assert.fail(`${from}→${to} should reject same chain`);
        ok++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        assert.match(msg, /must differ/);
        blocked++;
      }
    }
  }
  assert.equal(ok + blocked, 9);
  assert.equal(ok, 6);
  assert.equal(blocked, 3);
});
