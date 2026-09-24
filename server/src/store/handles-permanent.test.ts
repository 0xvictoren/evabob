/**
 * An @handle is chosen once, during signup, and is permanent after that.
 *
 * Permanence is what keeps payments safe: the handle is bound on chain to the
 * wallet it was first linked to, and held payments release to that wallet. A
 * handle that could move — to a new owner after a change or an account
 * deletion — would route someone's held money to the previous owner.
 *
 * Runs against a temp working directory: the store resolves its file from
 * process.cwd().
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-handles-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { store, handleIsOpen } = await import("./db.js");

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows holds the store file open; a stray temp dir is not worth a red suite.
  }
});

describe("choosing a handle at signup", () => {
  it("lets a new account choose, and re-choose, until signup finishes", () => {
    const user = store.upsertUser({ id: "signup-1", email: "first@example.com" });
    assert.equal(user.onboardingCompletedAt, null);
    assert.equal(handleIsOpen(user), true);

    const first = store.updateHandle("signup-1", "first_pick");
    assert.equal(first.ok, true);
    // A first choice that fails later in signup can be replaced.
    const second = store.updateHandle("signup-1", "second_pick");
    assert.equal(second.ok, true);
    assert.equal(store.getUser("signup-1")?.handle, "second_pick");
  });

  it("makes the handle permanent once signup finishes", () => {
    store.completeOnboarding("signup-1");
    const change = store.updateHandle("signup-1", "something_else");
    assert.equal(change.ok, false);
    assert.equal(!change.ok && change.code, "HANDLE_PERMANENT");
    assert.equal(store.getUser("signup-1")?.handle, "second_pick");
  });

  it("treats re-submitting the same handle as a no-op, not an error", () => {
    const same = store.updateHandle("signup-1", "@Second_Pick");
    assert.equal(same.ok, true);
    assert.equal(store.getUser("signup-1")?.handle, "second_pick");
  });

  it("locks accounts from before the signup gate (no onboarding marker)", () => {
    const legacy = store.upsertUser({ id: "legacy-1", email: "legacy@example.com" });
    delete legacy.onboardingCompletedAt;
    store.save();
    const change = store.updateHandle("legacy-1", "new_legacy_name");
    assert.equal(!change.ok && change.code, "HANDLE_PERMANENT");
  });
});

describe("a deleted account's handle", () => {
  it("stays reserved so nobody else can take it", () => {
    store.upsertUser({ id: "leaving-1", email: "leaving@example.com" });
    assert.equal(store.updateHandle("leaving-1", "gone_person").ok, true);
    store.completeOnboarding("leaving-1");

    store.anonymizeUser("leaving-1");
    const deleted = store.getUser("leaving-1");
    assert.equal(deleted?.handle, undefined);
    assert.equal(deleted?.retiredHandle, "gone_person");
    assert.equal(store.isHandleTaken("gone_person"), true);
    // Payments by handle no longer find anyone.
    assert.equal(store.findUserByHandle("gone_person"), undefined);

    store.upsertUser({ id: "newcomer-1", email: "newcomer@example.com" });
    const grab = store.updateHandle("newcomer-1", "gone_person");
    assert.equal(grab.ok, false);
  });
});
