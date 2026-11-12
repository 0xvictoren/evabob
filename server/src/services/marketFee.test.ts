import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "evabob-market-fee-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { store } = await import("../store/db.js");
const market = await import("./market.js");
const fee = await import("./marketFee.js");

let n = 0;
function user(handle: string) {
  const id = `mf-${handle}`;
  n += 1;
  store.upsertUser({ id, email: `${id}@example.com`, displayName: handle, evmAddress: "0x" + String(n).repeat(40).slice(0, 40) });
  store.getUser(id)!.handle = handle;
  market.saveProfile(id, { place: { state: "Lagos", area: "Lekki" } });
  return id;
}

const buyer = user("feebuyer");
const seller = user("feeseller");
const other = user("feeother");

function deal(requestId: string, feeBps?: number) {
  const post = market.createPost(seller, { kind: "offer", type: "service", title: `Cleaning ${requestId}`, priceUsd: 10 });
  return market.recordDeal({
    postId: post.id, sellerId: seller, buyerId: buyer, title: post.title, priceUsd: 10, requestId,
    ...(feeBps ? { feeBps } : {}),
  });
}

test("the split: 1% rounded down, and the two parts always add back up", () => {
  assert.deepEqual(fee.splitMarketFee(10_000_000n, 100), { netUnits: 9_900_000n, feeUnits: 100_000n });
  assert.deepEqual(fee.splitMarketFee(1_234_567n, 100), { netUnits: 1_222_222n, feeUnits: 12_345n });
  // Too small to carry a whole unit of fee: nothing is taken.
  assert.deepEqual(fee.splitMarketFee(99n, 100), { netUnits: 99n, feeUnits: 0n });
  assert.deepEqual(fee.splitMarketFee(5_000_000n, 0), { netUnits: 5_000_000n, feeUnits: 0n });
  for (const gross of [1n, 101n, 7_777_777n, 123_456_789n]) {
    const { netUnits, feeUnits } = fee.splitMarketFee(gross, 100);
    assert.equal(netUnits + feeUnits, gross);
  }
});

test("with no account to collect it, no fee is charged and deals carry none", () => {
  delete process.env.MARKET_FEE_ACCOUNT;
  assert.equal(fee.marketFeeAccount(), null);
  assert.equal(fee.marketFeeBpsNow(), 0);
  deal("req-nofee-acct", 100);
  assert.equal(fee.marketFeeForPayment({ requestId: "req-nofee-acct", payerId: buyer, payeeUserId: seller, amountUsdc: 10 }), null);
});

test("a fee applies only to this deal's buyer paying this deal's seller", () => {
  const treasury = user("evabobfees");
  process.env.MARKET_FEE_ACCOUNT = "@evabobfees";
  assert.equal(fee.marketFeeAccount()?.userId, treasury);
  assert.equal(fee.marketFeeBpsNow(), 100);

  deal("req-with-fee", 100);
  const got = fee.marketFeeForPayment({ requestId: "req-with-fee", payerId: buyer, payeeUserId: seller, amountUsdc: 10 });
  assert.equal(got?.netUsdc, 9.9);
  assert.equal(got?.feeUsdc, 0.1);
  assert.equal(got?.account.handle, "evabobfees");

  // Half of a half-and-half deal carries half the fee.
  assert.equal(fee.marketFeeForPayment({ requestId: "req-with-fee", payerId: buyer, payeeUserId: seller, amountUsdc: 5 })?.feeUsdc, 0.05);

  assert.equal(fee.marketFeeForPayment({ requestId: undefined, payerId: buyer, payeeUserId: seller, amountUsdc: 10 }), null);
  assert.equal(fee.marketFeeForPayment({ requestId: "not-a-deal", payerId: buyer, payeeUserId: seller, amountUsdc: 10 }), null);
  assert.equal(fee.marketFeeForPayment({ requestId: "req-with-fee", payerId: other, payeeUserId: seller, amountUsdc: 10 }), null, "someone else paying");
  assert.equal(fee.marketFeeForPayment({ requestId: "req-with-fee", payerId: buyer, payeeUserId: other, amountUsdc: 10 }), null, "paying someone else");
  assert.equal(fee.marketFeeForPayment({ requestId: "req-with-fee", payerId: buyer, payeeUserId: undefined, amountUsdc: 10 }), null);

  // A deal made before the fee pays the seller in full.
  deal("req-old-deal");
  assert.equal(fee.marketFeeForPayment({ requestId: "req-old-deal", payerId: buyer, payeeUserId: seller, amountUsdc: 10 }), null);
});

test("checking a payment: the seller's share of a deal, the whole amount otherwise", () => {
  assert.equal(fee.sellerShareOf("req-with-fee", 10), 9.9);
  assert.equal(fee.sellerShareOf("req-with-fee", 18.5), 18.315);
  assert.equal(fee.sellerShareOf("req-old-deal", 10), 10);
  assert.equal(fee.sellerShareOf("not-a-deal", 10), 10);
});

test("the 1% hold is found beside the seller's hold, and only a real one", () => {
  const key = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const sellerKey = ("0x" + "cd".repeat(32)) as `0x${string}`;
  const me = "0x" + "1".repeat(40);
  const main = { transferId: "41", sender: me };
  const created = [
    { transferId: "41", amountUsdc: 9.9, recipientKey: sellerKey, sender: me },
    { transferId: "42", amountUsdc: 0.1, recipientKey: key, sender: me },
  ];
  assert.deepEqual(fee.feeHoldAmong(created, main, key), { transferId: "42", amountUsdc: 0.1, status: "held" });
  assert.equal(fee.feeHoldAmong(created.slice(0, 1), main, key), null);
  // A hold for the fee account locked by another wallet is not this deal's fee.
  assert.equal(fee.feeHoldAmong([created[0]!, { ...created[1]!, sender: "0x" + "2".repeat(40) }], main, key), null);
  // The seller's own hold is never mistaken for the fee, even if the keys matched.
  assert.equal(fee.feeHoldAmong([{ ...created[0]!, recipientKey: key }], main, key), null);
});

test("the 1% does whatever the seller's hold did, and waits until then", () => {
  const held = { transferId: "42", amountUsdc: 0.1, status: "held" as const };
  assert.equal(fee.feeStepFor({ status: "pending", marketFee: held }), "wait");
  assert.equal(fee.feeStepFor({ status: "claimed", marketFee: held }), "take");
  assert.equal(fee.feeStepFor({ status: "refunded", marketFee: held }), "return");
  assert.equal(fee.feeStepFor({ status: "failed", marketFee: held }), "return");
  // Already settled, or no fee at all: nothing to do.
  assert.equal(fee.feeStepFor({ status: "claimed", marketFee: { ...held, status: "taken" } }), "wait");
  assert.equal(fee.feeStepFor({ status: "refunded", marketFee: { ...held, status: "returned" } }), "wait");
  assert.equal(fee.feeStepFor({ status: "claimed" }), "wait");
});
