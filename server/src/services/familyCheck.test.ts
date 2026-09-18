import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data directory, set before the store is first imported, so these
// test users never reach the real database.
const scratch = mkdtempSync(join(tmpdir(), "evabob-family-check-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { store } = await import("../store/db.js");
const {
  DEFAULT_FAMILY_CHECK_ABOVE,
  FamilyCheckError,
  _resetFamilyChecks,
  familyCheckNeeded,
  maskEmail,
  requireFamilyPass,
  startFamilyCheck,
  verifyFamilyCode,
} = await import("./familyCheck.js");

const MUM = "0x1111111111111111111111111111111111111111";
const SHOP = "0x2222222222222222222222222222222222222222";

function setup() {
  _resetFamilyChecks();
  const id = `fam-${Math.random().toString(36).slice(2)}`;
  store.upsertUser({ id, email: `${id}@example.com`, displayName: "Tester", evmAddress: "0x" + "3".repeat(40) });
  const mum = store.addContact({ ownerUserId: id, name: "Mum", address: MUM });
  store.setContactFamily(id, mum.id, true);
  store.addContact({ ownerUserId: id, name: "Shop", address: SHOP });
  return id;
}

/** Starts a check and hands back the code instead of emailing it. */
async function codeFor(pay: { userId: string; dest: string; amount: number; token: string }, now: number) {
  let code = "";
  const started = await startFamilyCheck({
    ...pay,
    now,
    deliver: async (c) => ((code = c), { emailSent: true }),
  });
  assert.equal(started.required, true);
  return code;
}

const isCode = (code: string) => (e: unknown) => e instanceof FamilyCheckError && e.code === code;

test("only family, and only above the amount, needs the code", () => {
  const id = setup();
  const over = DEFAULT_FAMILY_CHECK_ABOVE + 1;
  assert.equal(familyCheckNeeded({ userId: id, dest: MUM, amount: over, token: "USDC" }).needed, true);
  assert.equal(familyCheckNeeded({ userId: id, dest: MUM, amount: DEFAULT_FAMILY_CHECK_ABOVE, token: "USDC" }).needed, false);
  assert.equal(familyCheckNeeded({ userId: id, dest: SHOP, amount: 10_000, token: "USDC" }).needed, false);
  store.setFamilyCheckAbove(id, 20);
  assert.equal(familyCheckNeeded({ userId: id, dest: MUM, amount: 25, token: "USDC" }).needed, true);
  // Bitcoin amounts are always checked for family.
  assert.equal(familyCheckNeeded({ userId: id, dest: MUM, amount: 0.001, token: "CIRBTC" }).needed, true);
});

test("the right code opens that payment, once, even in parts", async () => {
  const id = setup();
  const pay = { userId: id, dest: MUM, amount: 500, token: "USDC" };
  assert.throws(() => requireFamilyPass(pay), isCode("FAMILY_CHECK_REQUIRED"));
  // Payments that need no check go straight through.
  requireFamilyPass({ ...pay, dest: SHOP });

  const now = Date.now();
  const code = await codeFor(pay, now);
  assert.match(code, /^\d{6}$/);
  assert.throws(() => verifyFamilyCode(id, code === "000000" ? "000001" : "000000", now), isCode("FAMILY_CODE_WRONG"));
  verifyFamilyCode(id, code, now);
  // Not for a different amount or payee.
  assert.throws(() => requireFamilyPass({ ...pay, amount: 900 }, now), isCode("FAMILY_CHECK_REQUIRED"));
  requireFamilyPass(pay, now);
  // Used up by the payment it was for.
  assert.throws(() => requireFamilyPass(pay, now), isCode("FAMILY_CHECK_REQUIRED"));

  // Half now and half held, from a chat: one code covers both parts.
  const later = now + 60_000;
  const again = await codeFor(pay, later);
  verifyFamilyCode(id, again, later);
  requireFamilyPass({ ...pay, amount: 250 }, later);
  requireFamilyPass({ ...pay, amount: 250 }, later);
  assert.throws(() => requireFamilyPass({ ...pay, amount: 250 }, later), isCode("FAMILY_CHECK_REQUIRED"));
});

test("codes expire, and lock after five wrong tries", async () => {
  const id = setup();
  const pay = { userId: id, dest: MUM, amount: 500, token: "USDC" };
  const now = Date.now();
  const code = await codeFor(pay, now);
  assert.throws(() => verifyFamilyCode(id, code, now + 11 * 60 * 1000), isCode("FAMILY_CODE_EXPIRED"));

  const later = now + 60 * 60 * 1000;
  const fresh = await codeFor(pay, later);
  const wrong = fresh === "999999" ? "999998" : "999999";
  for (let i = 0; i < 5; i++) assert.throws(() => verifyFamilyCode(id, wrong, later), isCode("FAMILY_CODE_WRONG"));
  assert.throws(() => verifyFamilyCode(id, fresh, later), isCode("FAMILY_CODE_LOCKED"));
});

test("a second code needs a short wait", async () => {
  const id = setup();
  const pay = { userId: id, dest: MUM, amount: 500, token: "USDC" };
  const now = Date.now();
  await codeFor(pay, now);
  await assert.rejects(startFamilyCheck({ ...pay, now: now + 5_000 }), isCode("FAMILY_CODE_TOO_SOON"));
});

test("emails are masked", () => {
  assert.equal(maskEmail("ada@example.com"), "a••@example.com");
  assert.equal(maskEmail("jo@x.io"), "j••@x.io");
});
