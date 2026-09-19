import assert from "node:assert/strict";
import { test } from "node:test";
import { depositableUsdc, DEPOSIT_GAS_RESERVE_USDC } from "./agentWallet.js";

test("a top-up leaves room for the network fee instead of failing", () => {
  // $10 sent, approval already spent ~0.0016: depositing the full $10 was
  // what Circle refused ("transfer amount exceeds balance").
  assert.equal(depositableUsdc(10, 9.998402), 9.988402);
  // More than enough in the wallet: the amount asked for, exactly.
  assert.equal(depositableUsdc(2, 2.032633), 2);
  // Nothing beyond the reserve: nothing to deposit.
  assert.equal(depositableUsdc(5, DEPOSIT_GAS_RESERVE_USDC), 0);
});
