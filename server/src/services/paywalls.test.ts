import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch data directory: nothing here touches the real server/data.
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-paywalls-"));
mkdirSync(join(scratch, "data"), { recursive: true });
const TREASURY = "0x7777777777777777777777777777777777777777";
writeFileSync(
  join(scratch, "data", "paywalls.json"),
  JSON.stringify([{ type: "treasury", walletId: "w-treasury", address: TREASURY, createdAt: "2026-09-19T00:00:00.000Z" }]),
);
process.chdir(scratch);

const { store } = await import("../store/db.js");
const pw = await import("./paywalls.js");
const { canonicalJson, bundleHash, judgeResponse, recordEvidence, exportEvidence, cameBackFrom } = await import("./agentEvidence.js");

after(() => {
  pw.setFacilitatorForTests(null);
  process.chdir(originalCwd);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows */ }
});

type Calls = { verify: number; settle: number };
function fakeFacilitator(opts: { valid?: boolean; settles?: boolean } = {}): Calls {
  const calls = { verify: 0, settle: 0 };
  pw.setFacilitatorForTests({
    async verify() {
      calls.verify += 1;
      return opts.valid === false ? { isValid: false, invalidReason: "bad signature" } : { isValid: true, payer: "0xpayer" };
    },
    async settle() {
      calls.settle += 1;
      return opts.settles === false ? { success: false, errorReason: "insufficient balance" } : { success: true, transaction: "settle-ref-1" };
    },
  });
  return calls;
}

let nonce = 0;
function signature(price: number, payTo = TREASURY) {
  nonce += 1;
  const payload = {
    x402Version: 2,
    payload: { authorization: { from: "0xpayer", nonce: `0x${nonce.toString(16).padStart(64, "0")}` }, signature: "0xsig" },
    accepted: {
      scheme: "exact",
      network: pw.ARC_NETWORK,
      asset: pw.ARC_USDC,
      amount: String(Math.round(price * 1e6)),
      payTo,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

before(() => {
  store.upsertUser({ id: "ada", email: "ada@example.com", handle: "ada", evmAddress: "0x1111111111111111111111111111111111111111" });
});

describe("a paywall asks software to pay", () => {
  it("answers 402 with terms an x402 client can pay", async () => {
    const p = await pw.createPaywall("ada", { kind: "text", title: "Lagos rainfall notes", priceUsdc: 0.05, text: "It rained." });
    const res = await pw.handlePaywallRequest({ id: p.id });
    assert.equal(res.status, 402);
    const terms = JSON.parse(Buffer.from(res.headers["payment-required"]!, "base64").toString());
    assert.equal(terms.x402Version, 2);
    assert.equal(terms.accepts[0].amount, "50000");
    assert.equal(terms.accepts[0].payTo, TREASURY);
    assert.equal(terms.accepts[0].extra.name, "GatewayWalletBatched");
    const body = JSON.parse(res.body);
    assert.equal(body.paywall.payAfterProof, true);
    assert.equal(body.paywall.seller, "@ada");
  });
});

describe("pay after proof", () => {
  it("verifies, delivers, and only then takes the money", async () => {
    const calls = fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "text", title: "Notes", priceUsdc: 0.05, text: "The content." });
    const res = await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(0.05) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { title: "Notes", text: "The content." });
    assert.deepEqual(calls, { verify: 1, settle: 1 });
    assert.ok(res.headers["payment-response"]);
  });

  it("charges nothing when the content cannot be delivered", async () => {
    const calls = fakeFacilitator();
    const p = await pw.createPaywall("ada", {
      kind: "file",
      title: "Dataset",
      priceUsdc: 0.1,
      files: [{ name: "rain.csv", mime: "text/csv", base64: Buffer.from("day,mm\n1,4\n").toString("base64") }],
    });
    // Break the stored file: it no longer matches what was uploaded.
    writeFileSync(join(scratch, "data", "paywall-files", p.files![0]!.stored), "tampered");
    const res = await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(0.1) });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).charged, false);
    assert.deepEqual(calls, { verify: 1, settle: 0 });
  });

  it("delivers files whole, with their hashes", async () => {
    fakeFacilitator();
    const content = Buffer.from("day,mm\n1,4\n");
    const p = await pw.createPaywall("ada", {
      kind: "file",
      title: "Dataset 2",
      priceUsdc: 0.1,
      files: [{ name: "rain.csv", mime: "text/csv", base64: content.toString("base64") }],
    });
    const res = await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(0.1) });
    const body = JSON.parse(res.body);
    assert.equal(Buffer.from(body.files[0].base64, "base64").toString(), content.toString());
    assert.equal(body.files[0].sha256, p.files![0]!.sha256);
  });

  it("refuses a payment for the wrong price or to someone else", async () => {
    fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "text", title: "Priced", priceUsdc: 1, text: "x" });
    assert.equal((await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(0.5) })).status, 402);
    assert.equal(
      (await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(1, "0x9999999999999999999999999999999999999999") })).status,
      402,
    );
  });

  it("a signed payment works once", async () => {
    fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "text", title: "Once", priceUsdc: 0.02, text: "x" });
    const sig = signature(0.02);
    assert.equal((await pw.handlePaywallRequest({ id: p.id, paymentSignature: sig })).status, 200);
    assert.equal((await pw.handlePaywallRequest({ id: p.id, paymentSignature: sig })).status, 409);
  });

  it("an invalid signature gets the terms again, and nothing is served", async () => {
    const calls = fakeFacilitator({ valid: false });
    const p = await pw.createPaywall("ada", { kind: "text", title: "Guarded", priceUsdc: 0.02, text: "secret" });
    const res = await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(0.02) });
    assert.equal(res.status, 402);
    assert.doesNotMatch(res.body, /secret/);
    assert.equal(calls.settle, 0);
  });
});

describe("booking a person's time", () => {
  it("holds the payment until they accept, then takes it", async () => {
    const calls = fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "time", title: "An hour of advice", priceUsdc: 30, time: { minutes: 60 } });
    const res = await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(30), message: "Tuesday?" });
    assert.equal(res.status, 202);
    const { booking } = JSON.parse(res.body);
    assert.equal(calls.settle, 0);
    assert.equal(pw.bookingStatus(p.id, booking)!.status, "waiting_for_seller");
    await pw.answerBooking("ada", booking, { accept: true, details: "Tuesday 10:00, meet.example/ada" });
    assert.equal(calls.settle, 1);
    const status = pw.bookingStatus(p.id, booking)!;
    assert.equal(status.status, "accepted");
    assert.equal(status.details, "Tuesday 10:00, meet.example/ada");
  });

  it("drops the payment if they decline — nothing is charged", async () => {
    const calls = fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "time", title: "Call", priceUsdc: 10, time: { minutes: 30 } });
    const { booking } = JSON.parse((await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(10) })).body);
    await pw.answerBooking("ada", booking, { accept: false });
    assert.equal(calls.settle, 0);
    assert.equal(pw.bookingStatus(p.id, booking)!.charged, false);
  });

  it("drops bookings nobody answered", async () => {
    fakeFacilitator();
    const p = await pw.createPaywall("ada", { kind: "time", title: "Late", priceUsdc: 5, time: { minutes: 30 } });
    const { booking } = JSON.parse((await pw.handlePaywallRequest({ id: p.id, paymentSignature: signature(5) })).body);
    assert.ok(pw.expireBookings(Date.now() + pw.BOOKING_ANSWER_MS + 1) >= 1);
    assert.equal(pw.bookingStatus(p.id, booking)!.status, "expired");
  });
});

describe("payouts", () => {
  const sale = (owner: string, amount: number, at: string) => ({
    type: "sale" as const, id: `s${Math.random()}`, paywallId: "p", ownerId: owner, payer: "0x", amountUsdc: amount,
    nonce: String(Math.random()), status: "settled" as const, createdAt: at, decidedAt: at,
  });

  it("pays out at a dollar, or a day after the oldest sale", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const due = pw.duePayouts([
      sale("big", 0.6, "2026-09-19T11:00:00Z"),
      sale("big", 0.5, "2026-09-19T11:30:00Z"),
      sale("old", 0.3, "2026-09-18T10:00:00Z"),
      sale("new", 0.3, "2026-09-19T11:00:00Z"),
      sale("dust", 0.01, "2026-09-10T10:00:00Z"),
    ], now);
    assert.deepEqual([...due.keys()].sort(), ["big", "old"]);
  });
});

describe("evidence bundles", () => {
  it("hash over canonical JSON, independent of key order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("chain per agent, and an edited bundle no longer matches its hash", () => {
    const draft = {
      agentId: "agent_ev",
      ownerId: "ada",
      paymentKey: "key-0000000000000001",
      authorised: {
        owner: "@ada", agent: { id: "agent_ev", label: "Research", handle: null },
        allowance: "$20.00 this week, research services only", tier: "silent" as const,
        approval: null, remainingBeforeUsdc: 20, at: "2026-09-19T00:00:00.000Z",
      },
      asked: { method: "GET" as const, url: "https://seller.example/data", at: "2026-09-19T00:00:00.000Z" },
      cameBack: cameBackFrom({ status: 200, contentType: "application/json", body: '{"rows":[1]}' }),
      payment: { amountUsdc: 0.05, payTo: null, network: null, settlement: "proof" as const, outcome: "paid" as const, settleReference: null },
    };
    const first = recordEvidence(draft);
    const second = recordEvidence({ ...draft, paymentKey: "key-0000000000000002" });
    assert.equal(first.prevHash, null);
    assert.equal(second.prevHash, first.hash);
    assert.equal(bundleHash(first), first.hash);
    assert.notEqual(bundleHash({ ...first, payment: { ...first.payment, amountUsdc: 5 } }), first.hash);
    const exported = exportEvidence("agent_ev", "key-0000000000000001");
    assert.equal(exported.bundles.length, 1);
    assert.equal(exported.bundles[0]!.hashMatches, true);
    assert.match(exported.howToVerify, /SHA-256/);
  });

  it("judges responses the way a person would", () => {
    assert.equal(judgeResponse({ status: 200, contentType: "application/json", body: '{"price":3}' }).usable, true);
    assert.equal(judgeResponse({ status: 500, body: "oops" }).usable, false);
    assert.equal(judgeResponse({ status: 200, body: "   " }).usable, false);
    assert.equal(judgeResponse({ status: 200, contentType: "application/json", body: "{}" }).usable, false);
    assert.equal(judgeResponse({ status: 200, contentType: "application/json", body: "[]" }).usable, false);
    assert.equal(judgeResponse({ status: 200, contentType: "application/json", body: '{"error":"rate limited"}' }).usable, false);
    assert.equal(judgeResponse({ status: 200, contentType: "application/json", body: "<html>" }).usable, false);
    assert.equal(judgeResponse({ status: 200, contentType: "text/plain", body: "hello" }).usable, true);
  });
});
