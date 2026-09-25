import test from "node:test";
import assert from "node:assert/strict";

import { flatFeeSwapBps } from "./appKit.js";

test("the flat $0.02 becomes the nearest whole-bp rate for the swap", () => {
  assert.equal(flatFeeSwapBps(2, 0.02), 100); // exactly $0.02
  assert.equal(flatFeeSwapBps(20, 0.02), 10); // exactly $0.02
  assert.equal(flatFeeSwapBps(3, 0.02), 67); // $0.0201
});

test("at least 1 bp on large swaps, at most 10% on tiny ones", () => {
  assert.equal(flatFeeSwapBps(1_000, 0.02), 1);
  assert.equal(flatFeeSwapBps(0.05, 0.02), 1_000);
});

test("no fee without an amount or a flat fee", () => {
  assert.equal(flatFeeSwapBps(0, 0.02), 0);
  assert.equal(flatFeeSwapBps(5, 0), 0);
});
