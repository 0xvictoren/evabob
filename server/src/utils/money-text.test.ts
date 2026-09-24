import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeAmounts } from "./money-text.js";

test("money text: raw amounts become rounded dollars and euros", () => {
  assert.equal(humanizeAmounts("Sent 1.438849 USDC to @ekuma"), "Sent $1.44 to @ekuma");
  assert.equal(humanizeAmounts("20 EURC came back"), "€20.00 came back");
  assert.equal(humanizeAmounts("Paid 1500 USDC"), "Paid $1,500.00");
});

test("money text: leaves other text and already-formatted amounts alone", () => {
  assert.equal(humanizeAmounts("Your GA is empty"), "Your GA is empty");
  assert.equal(humanizeAmounts("$2.00 · transport"), "$2.00 · transport");
  assert.equal(humanizeAmounts("USDC on Base"), "USDC on Base");
  assert.equal(humanizeAmounts(undefined), undefined);
});
