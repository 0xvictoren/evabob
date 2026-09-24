/**
 * Claim emails go from Evabob to people who have never used it. The sender's
 * note is theirs to write, but a link in it would let a tiny payment deliver
 * phishing from Evabob's own address.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { emailSafeNote } = await import("./notify.js");

describe("emailSafeNote", () => {
  it("keeps an ordinary note", () => {
    assert.equal(emailSafeNote("For the shoes, thanks!"), "For the shoes, thanks!");
  });

  it("removes links, whatever their form", () => {
    assert.equal(
      emailSafeNote("Verify your account at https://evil.example/login now"),
      "Verify your account at [link removed] now",
    );
    assert.equal(emailSafeNote("go to www.evil.example"), "go to [link removed]");
    assert.equal(emailSafeNote("HTTP://EVIL.EXAMPLE"), "[link removed]");
  });

  it("drops an empty note", () => {
    assert.equal(emailSafeNote("   "), undefined);
    assert.equal(emailSafeNote(undefined), undefined);
  });
});
