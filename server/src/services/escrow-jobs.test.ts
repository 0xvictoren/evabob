/**
 * Pending escrow holds must survive a restart.
 *
 * They did not. The tracking Map lived only in memory, despite a comment
 * promising a JSON fallback, so every restart forgot every pending hold. With
 * Mongo unavailable the record was gone permanently and the auto-refund job
 * then ran hourly against an empty list while the contract kept the money.
 * Three real transfers sat unrefunded from July until they were swept by hand.
 *
 * The sweep now reads the contract directly so a lost record cannot strand
 * funds again, but persistence is still what keeps the refund attributable to
 * a user and their activity row, so it is worth pinning.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-escrow-jobs-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { trackProtectedEscrow, listLocalPending } = await import(
  "./escrow-jobs.js"
);

const FILE = join(scratch, "data", "protected-escrows.json");

before(() => {
  trackProtectedEscrow({
    onChainTransferId: "7",
    fromUserId: "payer",
    recipientKind: "email",
    recipientId: "someone@example.com",
    amountUsdc: 2.5,
    memo: "",
    createTx: "0x" + "a".repeat(64),
  });
});

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on the store file; a stray temp dir is not worth
    // failing a green suite over.
  }
});

describe("tracked protected escrows", () => {
  it("writes the hold to disk as soon as it is tracked", () => {
    assert.ok(existsSync(FILE), "should have written a tracking file");
    const rows = JSON.parse(readFileSync(FILE, "utf8"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].onChainTransferId, "7");
    assert.equal(rows[0].status, "pending");
  });

  it("lists it as pending in this process", () => {
    const pending = listLocalPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.amountUsdc, 2.5);
  });

  it("still knows about it after a restart", async () => {
    // A fresh module instance is what a restarted server sees. Before the fix
    // this came back empty and the money was unreachable by the refund job.
    const reloaded = await import(`./escrow-jobs.js?restart=${Date.now()}`);
    const pending = reloaded.listLocalPending();
    assert.equal(
      pending.length,
      1,
      "a restarted process must still see the pending hold",
    );
    assert.equal(pending[0]!.onChainTransferId, "7");
  });

  it("records the on-chain transfer id, which is what a refund needs", () => {
    // Without this the sweep cannot call refund(id) for a tracked row.
    for (const row of listLocalPending()) {
      assert.ok(row.onChainTransferId, "every pending hold needs its transfer id");
    }
  });
});
