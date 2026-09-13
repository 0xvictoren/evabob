import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeEmail,
  looksLikeEvm,
  looksLikePhone,
  isSameWallet,
  resolvePayee,
} from "./resolvePayee.js";

describe("resolvePayee classifiers", () => {
  it("detects 0x / email / phone", () => {
    assert.equal(
      looksLikeEvm("0x1234567890abcdef1234567890abcdef12345678"),
      true,
    );
    assert.equal(looksLikeEvm("0x12"), false);
    assert.equal(looksLikeEmail("ada@mail.com"), true);
    assert.equal(looksLikeEmail("@ada"), false);
    assert.equal(looksLikePhone("+2348012345678"), true);
    assert.equal(looksLikePhone("@john"), false);
  });
});

/**
 * The self-send guard. App Kit rejects these anyway, but only after the user
 * has been through a PIN prompt, and with a message about address validity
 * rather than "that's you". Seven real sends failed this way in one session.
 *
 * The sender's address is passed explicitly so these tests never write to the
 * real store — an earlier version of this file seeded users into
 * data/evabob-db.json as a side effect.
 */
describe("resolvePayee refuses the sender's own wallet", () => {
  const me = "selftest-owner";
  const mine = "0x1111111111111111111111111111111111111111";
  const theirs = "0x2222222222222222222222222222222222222222";

  it("refuses my own raw 0x address", () => {
    const r = resolvePayee(me, mine, mine);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "SELF_SEND");
  });

  it("refuses regardless of address casing", () => {
    const r = resolvePayee(me, mine.toUpperCase().replace("0X", "0x"), mine);
    assert.equal(!r.ok && r.code, "SELF_SEND");
  });

  it("allows a different address through", () => {
    const r = resolvePayee(me, theirs, mine);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.address.toLowerCase(), theirs);
  });

  it("does not fire when the sender has no wallet yet", () => {
    const r = resolvePayee(me, theirs, undefined);
    assert.equal(r.ok, true);
  });
});

describe("isSameWallet", () => {
  it("compares case-insensitively and rejects blanks", () => {
    assert.equal(isSameWallet("0xAbC", "0xabc"), true);
    assert.equal(isSameWallet("0xAbC", "0xdef"), false);
    assert.equal(isSameWallet(undefined, "0xabc"), false);
    assert.equal(isSameWallet("0xabc", undefined), false);
  });
});
