/**
 * Inbound scanning rules.
 *
 * These cover the window arithmetic rather than the RPC, because the bug that
 * mattered was arithmetic: the block cap was first applied to the START of
 * the window, so a wallet idle for longer than the cap had its watermark
 * jumped to the chain head and every transfer in between was skipped for
 * good. Verified against Arc: three real transfers were missed that way and
 * are found once the cap moves the END of the window instead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirrors the window arithmetic in syncInboundForUser. */
function plan(opts: {
  head: bigint;
  watermark?: bigint;
  maxPerSync: bigint;
  reorgSafety: bigint;
  firstScanLookback: bigint;
}) {
  let fromBlock =
    opts.watermark && opts.watermark > 0n
      ? opts.watermark - opts.reorgSafety
      : opts.head - opts.firstScanLookback;
  if (fromBlock < 0n) fromBlock = 0n;
  const toBlock =
    opts.head - fromBlock > opts.maxPerSync
      ? fromBlock + opts.maxPerSync
      : opts.head;
  return { fromBlock, toBlock };
}

const BASE = {
  maxPerSync: 90_000n,
  reorgSafety: 200n,
  firstScanLookback: 30_000n,
};

describe("inbound scan window", () => {
  it("covers a recent lookback for a wallet never scanned", () => {
    const { fromBlock, toBlock } = plan({ head: 1_000_000n, ...BASE });
    assert.equal(fromBlock, 970_000n);
    assert.equal(toBlock, 1_000_000n);
  });

  it("re-reads a little before the watermark so a reorg cannot drop a credit", () => {
    const { fromBlock } = plan({ head: 1_000_000n, watermark: 999_000n, ...BASE });
    assert.equal(fromBlock, 998_800n, "should rewind by the reorg safety margin");
  });

  it("caps the END of the window, never the start", () => {
    // The regression: a wallet 198k blocks behind.
    const head = 60_568_960n;
    const { fromBlock, toBlock } = plan({ head, watermark: 60_370_000n, ...BASE });

    assert.equal(fromBlock, 60_369_800n, "must still start at the watermark");
    assert.equal(toBlock, fromBlock + 90_000n, "and stop one cap later");

    // The three real Arc transfers that the old clamp skipped.
    for (const block of [60_377_508n, 60_380_501n, 60_392_964n]) {
      assert.ok(
        block >= fromBlock && block <= toBlock,
        `block ${block} must fall inside the scanned window`,
      );
    }
    // What the buggy version did instead:
    assert.ok(
      60_377_508n < head - 90_000n,
      "clamping the start would have skipped these blocks entirely",
    );
  });

  it("catches up across several syncs without skipping a block", () => {
    const head = 60_568_960n;
    let watermark = 60_370_000n;
    const covered: Array<[bigint, bigint]> = [];

    for (let i = 0; i < 10 && watermark < head; i++) {
      const { fromBlock, toBlock } = plan({ head, watermark, ...BASE });
      covered.push([fromBlock, toBlock]);
      watermark = toBlock;
    }

    assert.equal(watermark, head, "should reach the head");
    // Each window must start at or before the previous one ended: no gaps.
    for (let i = 1; i < covered.length; i++) {
      assert.ok(
        covered[i]![0] <= covered[i - 1]![1],
        `gap between window ${i - 1} and ${i}`,
      );
    }
  });

  it("does not scan past the head once caught up", () => {
    const head = 1_000_000n;
    const { toBlock } = plan({ head, watermark: 999_990n, ...BASE });
    assert.equal(toBlock, head);
  });
});

describe("native USDC sends on Arc", async () => {
  const { pairNativeWithToken, ARC_NATIVE_TRANSFER_SOURCE } = await import("./inbound.js");
  const usdc = "0x3600000000000000000000000000000000000000" as const;
  const from = "0x00000000000000000000000000000000000000aa" as const;
  const row = (over: Record<string, unknown>) => ({
    txHash: "0x" + "1".repeat(64),
    logIndex: 0,
    blockNumber: 10,
    from,
    token: "USDC",
    amount: 20,
    units: 20_000_000n,
    tokenAddress: usdc,
    ...over,
  }) as import("./inbound.js").InboundTransfer;

  it("records a plain send, which only the native event reports", () => {
    const native = row({ tokenAddress: ARC_NATIVE_TRANSFER_SOURCE, units: 20n * 10n ** 18n, txHash: "0x" + "2".repeat(64) });
    assert.deepEqual(pairNativeWithToken([native]), [native]);
  });

  it("counts a token transfer once, not twice", () => {
    const token = row({ logIndex: 2 });
    const twin = row({ logIndex: 1, tokenAddress: ARC_NATIVE_TRANSFER_SOURCE, units: 20n * 10n ** 18n });
    assert.deepEqual(pairNativeWithToken([twin, token]), [token]);
    // A native event for a different amount in the same transaction is its own money.
    const other = row({ logIndex: 3, tokenAddress: ARC_NATIVE_TRANSFER_SOURCE, units: 5n * 10n ** 18n });
    assert.deepEqual(pairNativeWithToken([twin, token, other]), [token, other]);
  });
});

describe("RPC limits", async () => {
  const { isRangeTooLarge, isRateLimited } = await import("./inbound.js");
  it("tells a too-large range from a quota", () => {
    assert.equal(isRangeTooLarge(new Error("query returned more than 10000 results")), true);
    assert.equal(isRangeTooLarge(new Error("block range is too wide")), true);
    // Arc's quota message fails every range, however small: back off, never split.
    assert.equal(isRangeTooLarge(new Error("Request exceeds defined limit.")), false);
    assert.equal(isRateLimited(new Error("Request exceeds defined limit.")), true);
    assert.equal(isRateLimited(new Error("rate limit exceeded")), true);
    assert.equal(isRangeTooLarge(new Error("connection reset")), false);
  });
});
