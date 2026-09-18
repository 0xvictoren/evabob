import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data directory, set before the store is first imported.
const scratch = mkdtempSync(join(tmpdir(), "evabob-hold-links-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { store } = await import("../store/db.js");
const {
  DEFAULT_DELIVERY_DAYS,
  HoldLinkError,
  assertHoldLinkOrder,
  countSellerRecord,
  createHoldLink,
  publicHoldLinkView,
  setHoldLinkActive,
} = await import("./holdLinks.js");
type Hold = import("./mongo.js").ProtectedEscrowRecord;

const DAY = 24 * 60 * 60 * 1000;

/** A user with exactly this handle, or none. */
function user(handle?: string) {
  const id = `hl-${Math.random().toString(36).slice(2)}`;
  store.upsertUser({ id, email: `${id}@example.com`, displayName: "Tester", evmAddress: "0x" + "4".repeat(40) });
  store.getUser(id)!.handle = handle;
  return id;
}

function hold(over: Partial<Hold>): Hold {
  return {
    id: Math.random().toString(36),
    onChainTransferId: "1",
    purpose: "job",
    fromUserId: "buyer",
    recipientKind: "phone",
    recipientId: "ada",
    amountUsdc: 10,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    ...over,
  };
}

test("a seller's record counts what they delivered, and only fair marks against them", () => {
  const holds = [
    hold({ status: "claimed" }),
    hold({ status: "claimed", recipientId: "ADA" }),
    hold({ status: "pending" }),
    hold({ status: "refunded", settledBy: "expired" }),
    hold({ status: "refunded", settledBy: "review_refunded", deliveredAt: "x" }),
    // The buyer changing their mind before delivery, or the seller handing it
    // back, says nothing against the seller.
    hold({ status: "refunded", settledBy: "payer_cancelled" }),
    hold({ status: "refunded", settledBy: "worker_refunded" }),
    // Someone else's orders, and holds that are not orders, do not count.
    hold({ status: "claimed", recipientId: "bola" }),
    hold({ status: "claimed", purpose: "claim_link" }),
  ];
  assert.deepEqual(countSellerRecord(holds, ["ada", "ada@example.com"]), {
    delivered: 2,
    notDelivered: 1,
    refundedAfterReview: 1,
    inProgress: 1,
  });
});

test("a link needs a username, a name and a sensible price", () => {
  const noHandle = user();
  assert.throws(
    () => createHoldLink(noHandle, { title: "Shoes", amount: 20 }),
    (e: unknown) => e instanceof HoldLinkError && /username/.test(e.message),
  );
  const seller = user("shoeshop");
  assert.throws(() => createHoldLink(seller, { title: "  ", amount: 20 }), HoldLinkError);
  assert.throws(() => createHoldLink(seller, { title: "Shoes", amount: 0.001 }), HoldLinkError);
  assert.throws(() => createHoldLink(seller, { title: "Shoes", amount: 20, deliveryDays: 90 }), HoldLinkError);
  assert.equal(createHoldLink(seller, { title: "Shoes", amount: 20, deliveryDays: 5 }).deliveryDays, 5);
});

test("an order must match the link: seller, price and delivery time", () => {
  const seller = user("adashop");
  const buyer = user("buyer1");
  const link = createHoldLink(seller, { title: "Ankara dress", amount: 45 });
  assert.equal(link.deliveryDays, DEFAULT_DELIVERY_DAYS);

  const now = Date.now();
  const ok = {
    holdLinkId: link.id,
    buyerId: buyer,
    recipientNormalized: "adashop",
    amountUsdc: 45,
    expiresAtMs: now + DEFAULT_DELIVERY_DAYS * DAY,
    nowMs: now,
  };
  assert.equal(assertHoldLinkOrder(ok).id, link.id);
  const bad = (over: Partial<typeof ok>) => assert.throws(() => assertHoldLinkOrder({ ...ok, ...over }), HoldLinkError);
  bad({ recipientNormalized: "someoneelse" });
  bad({ amountUsdc: 40 });
  bad({ expiresAtMs: now + 2 * DAY });
  bad({ buyerId: seller });

  // Anyone can see the link, without anything private about the seller.
  const view = publicHoldLinkView(link.id)!;
  assert.equal(view.seller.handle, "@adashop");
  assert.equal(view.amount, 45);
  assert.equal(JSON.stringify(view).includes("@example.com"), false);

  setHoldLinkActive(seller, link.id, false);
  assert.throws(() => assertHoldLinkOrder(ok), (e: unknown) => e instanceof HoldLinkError && e.status === 409);
});
