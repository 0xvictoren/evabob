/**
 * /v1/circle/cctp/finish spends the ops wallet's gas, so it only finishes
 * burns from the caller's own wallet. When ownership cannot be told, it must
 * never refuse a person's own retry — only a readable burn from someone else's
 * wallet is refused. These cases need no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { burnBelongsTo } = await import("./cctp.js");

const HASH = `0x${"1".repeat(64)}`;
const WALLET = `0x${"a".repeat(40)}`;

describe("burnBelongsTo", () => {
  it("refuses something that is not a transaction hash", async () => {
    assert.equal(await burnBelongsTo(26, "0x1234", [WALLET]), false);
  });

  it("cannot tell on a network it does not know", async () => {
    assert.equal(await burnBelongsTo(999, HASH, [WALLET]), null);
  });

  it("cannot tell with no wallet to compare against", async () => {
    assert.equal(await burnBelongsTo(26, HASH, ["", "not-an-address"]), null);
  });
});
