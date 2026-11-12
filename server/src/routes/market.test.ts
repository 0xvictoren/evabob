/**
 * The marketplace over HTTP, mounted the way index.ts mounts it: posting,
 * the agent's shortlist, offers, and a deal that is an ordinary payment
 * request. Runs against a temp working directory.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-market-routes-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { Hono } = await import("hono");
const { createAuthMiddleware } = await import("../middleware/auth.js");
const { marketRoutes } = await import("./market.js");
const { store } = await import("../store/db.js");
const { getPaymentRequest } = await import("../services/payment-requests.js");

function app() {
  const a = new Hono();
  // Header identities are for tests only; production requires a session.
  a.use("/v1/*", createAuthMiddleware({ allowHeaderFallback: true }));
  a.route("/v1", marketRoutes);
  return a;
}

async function call(method: string, path: string, uid: string | null, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(uid ? { "x-user-id": uid } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const SELLER = "mr-seller";
const BUYER = "mr-buyer";

before(() => {
  for (const [id, handle] of [[SELLER, "sparkle"], [BUYER, "ngozi"]] as const) {
    store.upsertUser({ id, email: `${id}@example.com`, displayName: handle, evmAddress: "0x" + "6".repeat(40) });
    store.getUser(id)!.handle = handle;
  }
});

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows holds the store file open; a stray temp dir is not worth a red suite.
  }
});

describe("the marketplace", () => {
  let offerId = "";

  it("needs a place before a first post, then remembers it", async () => {
    const without = await call("POST", "/v1/market/posts", SELLER, { kind: "offer", type: "service", title: "Home cleaning", priceUsd: 12 });
    assert.equal(without.status, 400);
    assert.equal(without.body.code, "PLACE_REQUIRED");

    const made = await call("POST", "/v1/market/posts", SELLER, {
      kind: "offer", type: "service", title: "Home cleaning", priceUsd: 12, place: { state: "Lagos", area: "Lekki" },
    });
    assert.equal(made.status, 201);
    offerId = made.body.post.id;
    assert.equal(made.body.post.category, "home");
    const me = await call("GET", "/v1/market/me", SELLER);
    assert.equal(me.body.place.area, "Lekki");
  });

  it("shows a buyer the post with the seller's record, and why it is ranked", async () => {
    await call("PUT", "/v1/market/me", BUYER, { place: { state: "Lagos", area: "Lekki" } });
    const list = await call("GET", "/v1/market/posts?kind=offer&q=cleaning", BUYER);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].seller.handle, "@sparkle");
    assert.equal(list.body.items[0].seller.tierLabel, "New here");
    assert.match(list.body.items[0].near, /Lekki/);
    const detail = await call("GET", `/v1/market/posts/${offerId}`, BUYER);
    assert.equal(detail.body.mine, false);
    assert.ok(!JSON.stringify(detail.body).includes("example.com"));
  });

  it("turns an order into a payment request the buyer can hold, split or pay in full", async () => {
    const own = await call("POST", `/v1/market/posts/${offerId}/order`, SELLER);
    assert.equal(own.status, 403);
    const order = await call("POST", `/v1/market/posts/${offerId}/order`, BUYER);
    assert.equal(order.status, 201);
    const request = getPaymentRequest(order.body.deal.requestId)!;
    assert.equal(request.userId, SELLER);
    assert.equal(request.receiverId, BUYER);
    assert.equal(request.total, 12);
    assert.deepEqual([...request.allowedStructures].sort(), ["escrow", "full", "split"]);
    assert.equal(order.body.deal.payLink, `evabob://pay/${request.id}`);
    assert.equal(order.body.deal.canReview, false);
    // Asking again reuses the unpaid deal instead of making a second request.
    const again = await call("POST", `/v1/market/posts/${offerId}/order`, BUYER);
    assert.equal(again.body.deal.requestId, request.id);
  });

  it("answers a request with the agent's shortlist, takes offers, and accepts one", async () => {
    const want = await call("POST", "/v1/market/posts", BUYER, {
      kind: "want", type: "service", title: "I need home cleaning this Saturday", priceUsd: 15,
    });
    assert.equal(want.status, 201);
    assert.equal(want.body.matches[0].id, offerId);
    const wantId = want.body.post.id;

    const offer = await call("POST", `/v1/market/posts/${wantId}/offers`, SELLER, { priceUsd: 14, message: "Free on Saturday" });
    assert.equal(offer.status, 201);
    const seen = await call("GET", `/v1/market/posts/${wantId}`, BUYER);
    assert.equal(seen.body.offers.length, 1);
    assert.equal(seen.body.offers[0].seller.handle, "@sparkle");

    const notMine = await call("POST", `/v1/market/offers/${offer.body.offer.id}/accept`, SELLER);
    assert.equal(notMine.status, 403);
    const accepted = await call("POST", `/v1/market/offers/${offer.body.offer.id}/accept`, BUYER);
    assert.equal(accepted.status, 201);
    assert.equal(getPaymentRequest(accepted.body.deal.requestId)!.total, 14);
    const mine = await call("GET", "/v1/market/mine", BUYER);
    assert.equal(mine.body.posts.find((p: any) => p.id === wantId).active, false);
    assert.equal(mine.body.deals.length, 2);
  });

  it("keeps the operator queue to operators and the public view to the post", async () => {
    const queue = await call("GET", "/v1/operator/market/socials", BUYER);
    // 403 for a signed-in non-operator; 401 here, where the test identity is unverified.
    assert.ok(queue.status === 403 || queue.status === 401);
    const pub = await call("GET", `/v1/public/market/posts/${offerId}`, null);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.post.title, "Home cleaning");
    // No viewer, so no "like you" and no distance: only where the seller is.
    assert.equal(pub.body.post.near, "In Lekki, Lagos");
  });
});
