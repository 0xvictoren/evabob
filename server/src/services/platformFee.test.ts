import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi } from "viem";

import {
  SCA_EXECUTE_BATCH_ABI,
  encodeWalletBatch,
  erc20TransferCall,
  feeTransferCall,
  feeUnitsFor,
  quotePlatformFee,
  toUnits,
} from "./platformFee.js";

const FEE = "0x00000000000000000000000000000000000000fe" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const TO = "0x1111111111111111111111111111111111111111" as const;
const on = { recipient: FEE, bps: 5 } as const;
const off = { recipient: "", bps: 5 } as const;

test("0.05% of $100 is $0.05, added on top", () => {
  const q = quotePlatformFee(100, 6, on);
  assert.equal(q.fee, "0.05");
  assert.equal(q.totalUnits, 100_050_000n);
});

test("no minimum: a fee below one micro-unit is zero, not rounded up", () => {
  // $0.001 × 0.05% = 0.0000005 → 0 base units
  assert.equal(quotePlatformFee(0.001, 6, on).feeUnits, 0n);
  // $1 × 0.05% = 0.0005 → 500 base units
  assert.equal(quotePlatformFee(1, 6, on).feeUnits, 500n);
});

test("fee is off without a recipient", () => {
  assert.equal(feeUnitsFor(100_000_000n, off), 0n);
  assert.equal(feeTransferCall(USDC, quotePlatformFee(100, 6, off)), null);
});

test("amounts avoid float drift", () => {
  assert.equal(toUnits(0.1 + 0.2), 300_000n);
});

test("wallet batch wraps payment and fee in executeBatch", () => {
  const quote = quotePlatformFee(10, 6, on);
  const payment = erc20TransferCall(USDC, TO, quote.amountUnits);
  const fee = feeTransferCall(USDC, quote)!;
  const data = encodeWalletBatch([payment, fee]);
  const decoded = decodeFunctionData({ abi: SCA_EXECUTE_BATCH_ABI, data });
  assert.equal(decoded.functionName, "executeBatch");
  const calls = decoded.args[0];
  assert.equal(calls.length, 2);
  const feeLeg = decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data });
  assert.equal(feeLeg.functionName, "transfer");
  assert.equal((feeLeg.args[0] as string).toLowerCase(), FEE);
  assert.equal(feeLeg.args[1], 5_000n);
});
