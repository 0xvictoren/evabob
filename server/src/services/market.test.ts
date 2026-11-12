import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data directory, set before the store is first imported.
const scratch = mkdtempSync(join(tmpdir(), "evabob-market-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
process.env.ALLOW_HEADER_AUTH = "false";

const { store } = await import("../store/db.js");
const market = await import("./market.js");

/** A user with this handle, living in this area of Lagos unless told otherwise. */
function user(handle: string | undefined, area?: string, state = "Lagos") {
  const id = `mk-${Math.random().toString(36).slice(2)}`;
  store.upsertUser({ id, email: `${id}@example.com`, displayName: handle ?? "Nameless", evmAddress: "0x" + "5".repeat(40) });
  store.getUser(id)!.handle = handle;
  if (area) market.saveProfile(id, { place: { state, area } });
  return id;
}

const statuses = new Map<string, string>();
market.setRequestStatusReader((id) => statuses.get(id));

const noRecord = { delivered: 0, notDelivered: 0, refundedAfterReview: 0, inProgress: 0 };

test("nearness: same area beats same state beats elsewhere; a measured distance wins", () => {
  const lekki = { country: "Nigeria", state: "Lagos", area: "Lekki" };
  assert.equal(market.nearness(lekki, { ...lekki }).score, 1);
  assert.equal(market.nearness(lekki, { ...lekki, area: "Ikeja" }).score, 0.7);
  assert.ok(market.nearness(lekki, { country: "Nigeria", state: "Kano", area: "Sabon Gari" }).score < 0.3);
  // Case and spacing do not matter.
  assert.equal(market.nearness(lekki, { country: "Nigeria", state: " lagos ", area: "LEKKI" }).score, 1);
  // Someone who works from anywhere is never ranked as far away.
  assert.ok(market.nearness(lekki, { country: "Nigeria", state: "Kano", area: "" }, true).score > 0.5);
  const near = market.nearness({ ...lekki, lat: 6.45, lng: 3.47 }, { ...lekki, area: "Ajah", lat: 6.47, lng: 3.56 });
  assert.ok(near.km! > 5 && near.km! < 15);
  assert.match(near.label!, /km away/);
});

test("a shared point is rounded so it cannot find a door", () => {
  const place = market.cleanPlace({ state: "Lagos", area: "Lekki", lat: 6.458123, lng: 3.601987 })!;
  assert.equal(place.lat, 6.46);
  assert.equal(place.lng, 3.6);
  assert.equal(market.cleanPlace({ state: "", area: "" }), undefined);
});

test("a position alone is a place, so one tap ranks by distance before anything is typed", () => {
  const here = market.cleanPlace({ lat: 6.4474, lng: 3.4723 });
  assert.deepEqual(here, { country: "Nigeria", state: "", area: "", lat: 6.45, lng: 3.47 });
  assert.equal(market.cleanPlace({}), undefined);
  assert.equal(market.cleanPlace({ lat: 0, lng: 0 }), undefined);
  const near = market.nearness(here, market.cleanPlace({ state: "Lagos", area: "Ikoyi", lat: 6.45, lng: 3.44 }));
  assert.ok(near.km != null && near.km > 2 && near.km < 5);
  assert.match(near.label ?? "", /km away/);
});

test("reputation: nothing yet is 'new', delivery and paid reviews raise it, refunds cost", () => {
  const fresh = market.scoreReputation({ record: noRecord, ratingSum: 0, reviews: 0, dealsPaid: 0, verifiedSocials: 0, ageDays: 0 });
  assert.equal(fresh.tier, "new");
  assert.equal(fresh.score, 0);

  const steady = market.scoreReputation({
    record: { ...noRecord, delivered: 12 }, ratingSum: 48, reviews: 10, dealsPaid: 12, verifiedSocials: 1, ageDays: 200,
  });
  assert.equal(steady.tier, "top");
  assert.ok(steady.score >= 70);

  const burned = market.scoreReputation({
    record: { ...noRecord, delivered: 12, refundedAfterReview: 2 }, ratingSum: 48, reviews: 10, dealsPaid: 12, verifiedSocials: 1, ageDays: 200,
  });
  assert.ok(burned.score < steady.score - 20);

  // Three five-star reviews do not outrank forty good ones.
  const few = market.scoreReputation({ record: { ...noRecord, delivered: 3 }, ratingSum: 15, reviews: 3, dealsPaid: 3, verifiedSocials: 0, ageDays: 30 });
  const many = market.scoreReputation({ record: { ...noRecord, delivered: 40 }, ratingSum: 188, reviews: 40, dealsPaid: 40, verifiedSocials: 0, ageDays: 30 });
  assert.ok(many.score > few.score);

  // Checked accounts help, but cannot make a top seller of someone with no orders.
  const onlySocials = market.scoreReputation({ record: noRecord, ratingSum: 0, reviews: 0, dealsPaid: 0, verifiedSocials: 6, ageDays: 400 });
  assert.ok(onlySocials.score <= 25);
  assert.equal(onlySocials.tier, "new");
});

test("category is guessed from the words when none is chosen", () => {
  assert.equal(market.guessCategory("I need a cleaner for my flat"), "home");
  assert.equal(market.guessCategory("Birthday cake and small chops"), "food");
  assert.equal(market.guessCategory("plumber to fix a leaking pipe"), "repairs");
  assert.equal(market.guessCategory("something unusual"), "other");
});

test("posting needs a username, a price and a place", () => {
  const nameless = user(undefined, "Lekki");
  assert.throws(() => market.createPost(nameless, { kind: "offer", type: "service", title: "House cleaning", priceUsd: 10 }), /username/);
  const homeless = user("nowhere");
  assert.throws(() => market.createPost(homeless, { kind: "offer", type: "service", title: "House cleaning", priceUsd: 10 }), /where you are/);
  const ok = user("tidy", "Lekki");
  assert.throws(() => market.createPost(ok, { kind: "offer", type: "service", title: "House cleaning", priceUsd: 0 }), /price/);
  const post = market.createPost(ok, { kind: "offer", type: "service", title: "House cleaning", priceUsd: 10 });
  assert.equal(post.category, "home");
  assert.equal(post.place.area, "Lekki");
});

test("the agent shortlists sellers for a request by fit, nearness and budget", () => {
  market.resetMarketForTests();
  const near = user("near_cleaner", "Lekki");
  const far = user("far_cleaner", "Sabon Gari", "Kano");
  const pricey = user("pricey_cleaner", "Lekki");
  const baker = user("baker", "Lekki");
  const buyer = user("buyer", "Lekki");
  market.createPost(near, { kind: "offer", type: "service", title: "Home cleaning, flats and duplexes", priceUsd: 12 });
  market.createPost(far, { kind: "offer", type: "service", title: "Home cleaning service", priceUsd: 10 });
  market.createPost(pricey, { kind: "offer", type: "service", title: "Premium home cleaning", priceUsd: 60 });
  market.createPost(baker, { kind: "offer", type: "service", title: "Custom birthday cakes", priceUsd: 15 });
  const want = market.createPost(buyer, { kind: "want", type: "service", title: "I need home cleaning for a 3 bedroom flat", priceUsd: 15 });

  const matches = market.matchWant(want);
  const owners = matches.map((m) => store.getUser(m.post.ownerId)!.handle);
  assert.equal(owners[0], "near_cleaner");
  assert.ok(owners.indexOf("far_cleaner") > 0);
  assert.ok(!owners.includes("baker"), "a baker does not answer a cleaning request");
  assert.ok(!owners.includes("buyer"), "never the person who asked");
  assert.ok(matches[0]!.why.includes("Within your budget"));
  assert.match(matches[0]!.why.join(" "), /Lekki/);
  // The nearest matching sellers are the ones told.
  assert.equal(store.getUser(market.sellersToTell(want, 1)[0]!)!.handle, "near_cleaner");
});

test("browsing: closed posts and the wrong kind are left out; sorting works", () => {
  market.resetMarketForTests();
  const a = user("seller_a", "Lekki");
  const b = user("seller_b", "Ikeja");
  const viewer = user("viewer", "Lekki");
  const cheap = market.createPost(a, { kind: "offer", type: "goods", title: "Bag of rice", priceUsd: 30 });
  market.createPost(b, { kind: "offer", type: "goods", title: "Bag of rice, premium", priceUsd: 45 });
  const closed = market.createPost(b, { kind: "offer", type: "goods", title: "Bag of rice, old stock", priceUsd: 20 });
  market.setPostActive(b, closed.id, false);
  market.createPost(viewer, { kind: "want", type: "goods", title: "Bag of rice wanted", priceUsd: 35 });

  const found = market.browse({ viewerId: viewer, kind: "offer", query: "rice" });
  assert.equal(found.length, 2);
  assert.equal(found[0]!.post.id, cheap.id, "the one in the viewer's own area comes first");
  assert.equal(market.browse({ viewerId: viewer, kind: "offer", query: "rice", sort: "price_high" })[0]!.post.priceUsd, 45);
  assert.equal(market.browse({ viewerId: viewer, kind: "offer", query: "generator" }).length, 0);
  assert.equal(market.browse({ viewerId: viewer, kind: "want" }).length, 1);
  assert.throws(() => market.setPostActive(a, closed.id, true), /No such post/);
});

test("offers on a request: one live offer per seller, and only its people may settle it", () => {
  market.resetMarketForTests();
  const buyer = user("asker", "Lekki");
  const seller = user("fixer", "Lekki");
  const stranger = user("stranger", "Lekki");
  const want = market.createPost(buyer, { kind: "want", type: "service", title: "Fix my generator", priceUsd: 20 });

  assert.throws(() => market.sendProposal(buyer, want.id, { priceUsd: 10 }), /your own/);
  // A seller cannot price a request until the buyer has messaged them.
  assert.throws(() => market.sendProposal(seller, want.id, { priceUsd: 25 }), /has not messaged you/);
  market.recordContact(buyer, want.id, seller);
  const first = market.sendProposal(seller, want.id, { priceUsd: 25, message: "Today" });
  const again = market.sendProposal(seller, want.id, { priceUsd: 18 });
  assert.equal(again.id, first.id, "sending again replaces the offer");
  assert.equal(market.proposalsFor(want.id).length, 1);
  assert.equal(market.proposalsFor(want.id)[0]!.priceUsd, 18);

  assert.throws(() => market.setProposalStatus(stranger, first.id, "declined"), /not yours/);
  assert.throws(() => market.setProposalStatus(buyer, first.id, "withdrawn"), /not yours/);
  assert.equal(market.setProposalStatus(seller, first.id, "withdrawn").status, "withdrawn");
});

test("accepting an offer makes the deal, declines the rest and closes the request", () => {
  market.resetMarketForTests();
  const buyer = user("asker2", "Lekki");
  const s1 = user("seller1", "Lekki");
  const s2 = user("seller2", "Ikeja");
  const want = market.createPost(buyer, { kind: "want", type: "service", title: "Paint a room", priceUsd: 40 });
  market.recordContact(buyer, want.id, s1);
  market.recordContact(buyer, want.id, s2);
  const p1 = market.sendProposal(s1, want.id, { priceUsd: 38 });
  const p2 = market.sendProposal(s2, want.id, { priceUsd: 30 });

  const deal = market.recordDeal({ postId: want.id, proposalId: p1.id, sellerId: s1, buyerId: buyer, title: want.title, priceUsd: 38, requestId: "req-1" });
  assert.equal(market.getProposal(p1.id)!.status, "accepted");
  assert.equal(market.getProposal(p2.id)!.status, "declined");
  assert.equal(market.getPost(want.id)!.active, false);
  assert.throws(() => market.sendProposal(s2, want.id, { priceUsd: 20 }), /closed/);

  // Not paid yet: no review.
  statuses.set("req-1", "open");
  assert.equal(market.dealView(deal, buyer).canReview, false);
  assert.throws(() => market.leaveReview(buyer, deal.id, { stars: 5 }), /once you have paid/);

  // Money set aside counts as paid for; the buyer may review, once, and only the buyer.
  statuses.set("req-1", "escrow");
  assert.equal(market.dealView(deal, buyer).canReview, true);
  assert.equal(market.dealView(deal, s1).role, "seller");
  assert.throws(() => market.leaveReview(s1, deal.id, { stars: 5 }), /No such deal/);
  assert.throws(() => market.leaveReview(buyer, deal.id, { stars: 9 }), /1 to 5/);
  market.leaveReview(buyer, deal.id, { stars: 4, text: "Neat work" });
  assert.throws(() => market.leaveReview(buyer, deal.id, { stars: 5 }), /already reviewed/);

  const rep = market.reputationOf(s1);
  assert.equal(rep.reviews, 1);
  assert.equal(rep.rating, 4);
  assert.equal(rep.dealsPaid, 1);
  assert.notEqual(rep.tier, "new");
});

test("a request tells five sellers, then five more only after seven quiet hours", () => {
  market.resetMarketForTests();
  const buyer = user("pinger", "Lekki");
  const sellers = Array.from({ length: 12 }, (_, i) => {
    const id = user(`cleaner${i}`, "Lekki");
    market.createPost(id, { kind: "offer", type: "service", title: "Home cleaning", priceUsd: 10 + i });
    return id;
  });
  const want = market.createPost(buyer, { kind: "want", type: "service", title: "Home cleaning for my flat", priceUsd: 30 });
  const t0 = Date.parse("2026-11-12T08:00:00Z");

  const first = market.nextSellersToPing(want, t0);
  assert.equal(first.length, 5);
  assert.ok(first.every((id) => sellers.includes(id)));
  assert.deepEqual(market.wantsToWiden(t0 + 6 * 3_600_000), [], "not yet: six hours");
  assert.equal(market.wantsToWiden(t0 + 7 * 3_600_000)[0]?.id, want.id);

  const second = market.nextSellersToPing(want, t0 + 7 * 3_600_000);
  assert.equal(second.length, 5);
  assert.ok(second.every((id) => !first.includes(id)), "nobody is told twice");

  // Someone said they are available: no more widening.
  market.markAvailable(second[0]!, want.id);
  assert.deepEqual(market.wantsToWiden(t0 + 30 * 3_600_000), []);
  market.withdrawAvailable(second[0]!, want.id);
  assert.equal(market.wantsToWiden(t0 + 30 * 3_600_000).length, 1);

  // Four rounds at most, however quiet it stays.
  market.nextSellersToPing(want, t0 + 14 * 3_600_000);
  market.nextSellersToPing(want, t0 + 21 * 3_600_000);
  assert.deepEqual(market.wantsToWiden(t0 + 90 * 3_600_000), []);
});

test("only the buyer starts a conversation; available sellers rank by record, not by speed", () => {
  market.resetMarketForTests();
  const buyer = user("chooser", "Lekki");
  const quick = user("quick_new", "Lekki");
  const lister = user("lister", "Lekki");
  market.createPost(lister, { kind: "offer", type: "service", title: "Generator repair", priceUsd: 15 });
  const want = market.createPost(buyer, { kind: "want", type: "service", title: "Generator repair today", priceUsd: 20 });

  assert.throws(() => market.markAvailable(buyer, want.id), /your own/);
  assert.equal(market.markAvailable(quick, want.id).fresh, true);
  assert.equal(market.markAvailable(quick, want.id).fresh, false, "saying it twice tells the buyer once");

  const people = market.candidatesFor(want);
  assert.deepEqual(people.map((p) => p.sellerId).sort(), [lister, quick].sort());
  assert.equal(people.find((p) => p.sellerId === quick)!.available, true);
  assert.match(people.find((p) => p.sellerId === quick)!.why[0]!, /available/);
  assert.equal(people.find((p) => p.sellerId === lister)!.offer!.post.title, "Generator repair");

  // A seller cannot open the conversation on a want; the buyer can, once.
  assert.throws(() => market.recordContact(quick, want.id, buyer), /Only the person who asked/);
  assert.throws(() => market.recordContact(buyer, want.id), /Choose who/);
  const contact = market.recordContact(buyer, want.id, quick);
  assert.equal(market.recordContact(buyer, want.id, quick).id, contact.id);
  assert.equal(market.candidatesFor(want).find((p) => p.sellerId === quick)!.contact!.id, contact.id);
  assert.equal(market.contactForSeller(want.id, lister), undefined);

  // On something for sale, any buyer may message its seller; the seller is the owner.
  const offer = market.postsBy(lister)[0]!;
  assert.throws(() => market.recordContact(lister, offer.id), /your own/);
  assert.equal(market.recordContact(buyer, offer.id).sellerId, lister);
});

test("outside accounts: a handle is cleaned, checked by code, and a changed handle starts over", () => {
  market.resetMarketForTests();
  const id = user("stylist", "Lekki");
  assert.equal(market.cleanSocialHandle("instagram", "https://www.instagram.com/hair.by_ada/?hl=en"), "hair.by_ada");
  assert.equal(market.cleanSocialHandle("x", "@ada"), "ada");
  assert.equal(market.cleanSocialHandle("website", "ada.example.com/shop/"), "https://ada.example.com/shop");
  assert.throws(() => market.cleanSocialHandle("website", "http://ada.example.com"), /https/);
  assert.throws(() => market.cleanSocialHandle("whatsapp", "12"), /country code/);
  assert.throws(() => market.cleanSocialHandle("instagram", "not a handle!"), /does not look right/);

  market.saveProfile(id, { socials: [{ platform: "instagram", handle: "@hair.by_ada" }] });
  assert.throws(() => market.requestSocialCheck(id, "x"), /Add that account/);
  const pending = market.requestSocialCheck(id, "instagram");
  assert.equal(pending.status, "pending");
  assert.match(pending.code!, /^evabob-[a-f0-9]{6}$/);
  assert.equal(market.pendingSocialChecks().length, 1);
  assert.equal(market.reputationOf(id).verifiedSocials.length, 0, "asking is not being checked");

  market.decideSocialCheck({ userId: id, platform: "instagram", verified: true, by: "op" });
  assert.deepEqual(market.reputationOf(id).verifiedSocials, ["instagram"]);
  assert.equal(market.personCard(id).socials[0]!.verified, true);

  // Same handle saved again keeps its check; a different one loses it.
  market.saveProfile(id, { socials: [{ platform: "instagram", handle: "hair.by_ada" }] });
  assert.equal(market.reputationOf(id).verifiedSocials.length, 1);
  market.saveProfile(id, { socials: [{ platform: "instagram", handle: "someone_famous" }] });
  assert.equal(market.reputationOf(id).verifiedSocials.length, 0);
});

test("what others see of a person never includes their wallet, email or exact point", () => {
  market.resetMarketForTests();
  const id = user("private_person", "Lekki");
  market.saveProfile(id, { place: { state: "Lagos", area: "Lekki", lat: 6.45, lng: 3.47 } });
  const card = JSON.stringify(market.personCard(id));
  assert.ok(!card.includes("example.com"));
  assert.ok(!card.includes("0x5555"));
  assert.ok(!card.includes("6.45"));
});
