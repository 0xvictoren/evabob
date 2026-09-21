import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch data directory: nothing here touches the real server/data.
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-sign-in-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
const { store } = await import("./db.js");

after(() => {
  process.chdir(originalCwd);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows */ }
});

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("which account a sign-in opens", () => {
  it("a new person gets a new account", () => {
    assert.equal(store.accountIdForSignIn("dyn-new", "new@example.com"), "dyn-new");
  });

  it("an existing account opens itself", () => {
    store.upsertUser({ id: "dyn-1", email: "ada@example.com", evmAddress: WALLET_A });
    assert.equal(store.accountIdForSignIn("dyn-1", "ada@example.com"), "dyn-1");
  });

  it("a recreated sign-in id never inherits an account from matching email", () => {
    assert.equal(store.accountIdForSignIn("dyn-2", "Ada@Example.com"), "dyn-2");
    assert.equal(store.getUser("dyn-1")?.authIds, undefined);
  });

  it("matching several wallet accounts still creates a separate subject account", () => {
    store.upsertUser({ id: "old", email: "bola@example.com", evmAddress: WALLET_A, createdAt: "2026-07-01T00:00:00.000Z" } as never);
    store.upsertUser({ id: "newer", email: "bola@example.com", evmAddress: WALLET_B, createdAt: "2026-09-01T00:00:00.000Z" } as never);
    store.upsertUser({ id: "no-wallet", email: "bola@example.com", createdAt: "2026-06-01T00:00:00.000Z" } as never);
    assert.equal(store.accountIdForSignIn("dyn-bola-3", "bola@example.com"), "dyn-bola-3");
  });

  it("recent sign-in history cannot turn email into an account credential", () => {
    store.upsertUser({ id: "dyn-dee-1", email: "dee@example.com", evmAddress: WALLET_A });
    store.upsertUser({ id: "dyn-dee-2", email: "dee@example.com", evmAddress: WALLET_B });
    // Dee has been signing into the newer account.
    assert.equal(store.accountIdForSignIn("dyn-dee-2", "dee@example.com"), "dyn-dee-2");
    // Dynamic recreates Dee again: back to the account Dee was using.
    assert.equal(store.accountIdForSignIn("dyn-dee-3", "dee@example.com"), "dyn-dee-3");
  });

  it("an account without a wallet is not reused", () => {
    store.upsertUser({ id: "half", email: "chi@example.com" });
    assert.equal(store.accountIdForSignIn("dyn-chi-2", "chi@example.com"), "dyn-chi-2");
  });

  it("a sign-in id can be moved to another account, and then opens that one", () => {
    store.attachSignInId("newer", "dyn-bola-3");
    assert.equal(store.accountIdForSignIn("dyn-bola-3", "bola@example.com"), "newer");
    assert.equal(Boolean(store.getUser("old")?.authIds?.includes("dyn-bola-3")), false);
  });
});

describe("signing in never undoes a profile change", () => {
  it("keeps the display name the person chose, whatever the app sends", () => {
    store.upsertUser({ id: "dyn-eve", email: "eve@example.com", displayName: "eve" });
    const eve = store.getUser("dyn-eve")!;
    eve.displayName = "Maxi";
    // The app signs in again with its old cached name.
    store.upsertUser({ id: "dyn-eve", email: "eve@example.com", displayName: "eve" });
    assert.equal(store.getUser("dyn-eve")?.displayName, "Maxi");
    // A missing name never blanks it either.
    store.upsertUser({ id: "dyn-eve", email: "eve@example.com", displayName: undefined });
    assert.equal(store.getUser("dyn-eve")?.displayName, "Maxi");
  });
});
