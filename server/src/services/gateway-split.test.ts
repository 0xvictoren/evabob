import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnits } from "viem";
import { splitConfirmedSources } from "./gateway-e2e.js";

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
