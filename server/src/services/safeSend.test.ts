/**
 * The checks shown before money leaves: a first payment to someone new gets
 * a cooling-off offer, a raw address gets a plain warning, and an address
 * that only looks like one you have paid gets a stronger one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityItem, UserRecord } from "../store/db.js";

const scratch = mkdtempSync(join(tmpdir(), "evabob-safesend-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { assessPayee, priorPayees, resemblesKnownAddress } = await import(
  "./safeSend.js"
);

const PAID = "0x1111aaaa00000000000000000000000000002222";
const POISON = "0x1111bbbb99999999999999999999999999992222";

function send(patch: Partial<ActivityItem>): ActivityItem {
  return {
    id: "a",
    userId: "me",
    kind: "send",
    title: "",
    description: "",
    amountUsdc: -5,
    status: "completed",
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

const maya = {
  id: "maya",
  email: "maya@example.com",
  handle: "maya",
  displayName: "Maya",
  evmAddress: "0x3333000000000000000000000000000000004444",
} as UserRecord;

describe("payee checks", () => {
  it("offers cooling-off by default for a first payment to someone on Evabob", () => {
    const r = assessPayee({
      kind: "handle",
      address: maya.evmAddress!,
      user: maya,
      inputText: "@maya",
      prior: priorPayees([]),
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.equal(r.paidBefore, false);
    assert.ok(r.warnings.includes("first_payment"));
    assert.deepEqual(r.coolingOff, {
      available: true,
      recipient: "@maya",
      recommended: true,
      minutes: 10,
    });
    assert.equal(r.label, "@maya");
  });

  it("does not slow down someone the sender has paid before", () => {
    const r = assessPayee({
      kind: "handle",
      address: maya.evmAddress!,
      user: maya,
      inputText: "@maya",
      prior: priorPayees([send({ counterparty: "@maya" })]),
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.equal(r.paidBefore, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.coolingOff.recommended, false);
    // Paid before: the wait is not offered for this person again.
    assert.equal(r.coolingOff.available, false);
  });

  it("@name and name are the same payee when deciding whether they were paid", () => {
    const r = assessPayee({
      kind: "handle",
      address: maya.evmAddress!,
      user: maya,
      inputText: "maya",
      // Paid earlier as "maya", without the @.
      prior: priorPayees([send({ counterparty: "maya" })]),
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.equal(r.paidBefore, true);
    assert.equal(r.coolingOff.available, false);
  });

  it("warns plainly on a new raw address and cannot hold for it", () => {
    const r = assessPayee({
      kind: "address",
      address: "0x9999000000000000000000000000000000008888",
      inputText: "0x9999000000000000000000000000000000008888",
      prior: priorPayees([]),
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.ok(r.warnings.includes("raw_address_new"));
    assert.ok(r.warnings.includes("raw_address_not_evabob"));
    assert.equal(r.coolingOff.available, false, "a hold needs an identity to release to");
  });

  it("holds for an Evabob user even when their address was pasted", () => {
    const r = assessPayee({
      kind: "address",
      address: maya.evmAddress!,
      user: maya,
      inputText: maya.evmAddress!,
      prior: priorPayees([]),
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.equal(r.coolingOff.available, true);
    assert.equal(r.coolingOff.recipient, "@maya");
  });

  it("flags an address that only looks like one already paid", () => {
    // Poisoned addresses copy the first and last characters people check.
    const prior = priorPayees([send({ receiver: PAID })]);
    const r = assessPayee({
      kind: "address",
      address: POISON,
      inputText: POISON,
      prior,
      coolingOffMinutes: 10,
      holdsEnabled: true,
    });
    assert.ok(r.warnings.includes("looks_like_known_address"));
    assert.equal(r.resembles, PAID);
  });

  it("does not flag the very address that was paid", () => {
    assert.equal(resemblesKnownAddress(PAID, [PAID]), null);
  });

  it("ignores failed and cancelled payments when deciding who was paid", () => {
    const prior = priorPayees([
      send({ counterparty: "@maya", status: "failed" }),
      send({ counterparty: "@maya", status: "cancelled" }),
    ]);
    assert.equal(prior.identities.has("maya"), false);
  });

  it("offers nothing when holds are switched off", () => {
    const r = assessPayee({
      kind: "handle",
      address: maya.evmAddress!,
      user: maya,
      inputText: "@maya",
      prior: priorPayees([]),
      coolingOffMinutes: 10,
      holdsEnabled: false,
    });
    assert.equal(r.coolingOff.available, false);
    assert.equal(r.coolingOff.recommended, false);
  });
});
