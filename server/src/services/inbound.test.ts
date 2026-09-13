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
