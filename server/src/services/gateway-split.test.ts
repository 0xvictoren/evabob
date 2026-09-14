import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { carvePlatformFee, splitConfirmedSources } from "./gateway-e2e.js";

describe("splitConfirmedSources", () => {
  it("prefers destination domain when it has the full amount", () => {
    const slices = splitConfirmedSources(
      [
        { domain: 26, raw: parseUnits("4.01", 6) },
        { domain: 0, raw: parseUnits("5", 6) },
        { domain: 6, raw: parseUnits("10", 6) },
      ],
      parseUnits("10", 6),
      6,
    );
    assert.equal(slices.length, 1);
    assert.equal(slices[0]!.domain, 6);
    assert.equal(slices[0]!.amountUsdc, "10");
  });

  it("splits across chains when no single domain has enough", () => {
    const slices = splitConfirmedSources(
      [
        { domain: 26, raw: parseUnits("4.01", 6) },
        { domain: 0, raw: parseUnits("5", 6) },
        { domain: 6, raw: parseUnits("2", 6) },
      ],
      parseUnits("10", 6),
      6,
    );
    const total = slices.reduce((s, x) => s + x.raw, 0n);
    assert.equal(total, parseUnits("10", 6));
    assert.equal(slices[0]!.domain, 6);
    assert.ok(slices.length >= 2);
  });

  it("throws INSUFFICIENT_GATEWAY when confirmed total is short", () => {
    assert.throws(
      () =>
        splitConfirmedSources(
          [
            { domain: 26, raw: parseUnits("1", 6) },
            { domain: 6, raw: parseUnits("1", 6) },
          ],
          parseUnits("10", 6),
          6,
        ),
      (e: unknown) =>
        e instanceof Error &&
        (e as Error & { code?: string }).code === "INSUFFICIENT_GATEWAY",
    );
  });
});

describe("carvePlatformFee", () => {
  const FEE_WALLET = "0x00000000000000000000000000000000000000fe";

  it("takes the fee from the largest source as its own intent", () => {
    const out = carvePlatformFee(
      [
        { domain: 26, value: parseUnits("4", 6) },
        { domain: 6, value: parseUnits("6.005", 6) },
      ],
      { units: parseUnits("0.005", 6), recipient: FEE_WALLET },
    );
    assert.equal(out.length, 3);
    assert.equal(out[1]!.value, parseUnits("6", 6));
    assert.equal(out[2]!.domain, 6);
    assert.equal(out[2]!.value, parseUnits("0.005", 6));
    assert.equal(out[2]!.recipient, FEE_WALLET);
    const total = out.reduce((s, x) => s + x.value, 0n);
    assert.equal(total, parseUnits("10.005", 6));
  });

  it("drops a source the fee empties instead of signing a zero burn", () => {
    const out = carvePlatformFee(
      [
        { domain: 26, value: parseUnits("10", 6) },
        { domain: 6, value: parseUnits("0.005", 6) },
      ],
      { units: parseUnits("0.005", 6), recipient: FEE_WALLET },
    );
    // Largest source (Arc) pays the fee; Base keeps its slice.
    assert.equal(out.length, 3);
    assert.ok(out.every((s) => s.value > 0n));
  });

  it("refuses when the sources cannot cover payment and fee", () => {
    assert.throws(() =>
      carvePlatformFee([{ domain: 26, value: 5n }], { units: 5n, recipient: FEE_WALLET }),
    );
  });
});