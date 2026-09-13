/**
 * Guards the rule that agent ledger credit must be backed by USDC that
 * actually arrived at the agent's custody address from the depositing user.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";

const USER = "0x1111111111111111111111111111111111111111";
const CUSTODY = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const USDC = "0x3600000000000000000000000000000000000000";
const OTHER_TOKEN = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const TX = `0x${"ab".repeat(32)}`;

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

function pad(addr: string): Hex {
  return `0x${addr.slice(2).padStart(64, "0").toLowerCase()}` as Hex;
}

/** A USDC Transfer log as viem would return it from a receipt. */
function transferLog(opts: {
  token?: string;
  from: string;
  to: string;
  /** whole USDC */
  amount: number;
}) {
  return {
    address: opts.token ?? USDC,
    topics: [TRANSFER_TOPIC, pad(opts.from), pad(opts.to)] as [Hex, Hex, Hex],
    data: encodeAbiParameters(
      [{ type: "uint256" }],
      [BigInt(Math.round(opts.amount * 1e6))],
    ),
  };
}

let receipt: unknown = null;
let receiptError: Error | null = null;

const { verifyAgentFunding, usdcToAtomic, atomicToUsdc } = await import(
  "./agentFunding.js"
);

/** Stands in for the Arc public client so no test touches the network. */
const fakeClient = {
  getTransactionReceipt: async () => {
    if (receiptError) throw receiptError;
    return receipt as never;
  },
};

function ok(logs: unknown[], status = "success") {
  receipt = { status, logs };
  receiptError = null;
}

afterEach(() => {
  receipt = null;
  receiptError = null;
});

const base = {
  txHash: TX,
  custodyAddress: CUSTODY,
  expectedSender: USER,
  minAmountUsdc: 10,
};

describe("verifyAgentFunding", () => {
  it("credits a genuine transfer to custody", async () => {
    ok([transferLog({ from: USER, to: CUSTODY, amount: 10 })]);
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.creditedUsdc, 10);
  });

  it("credits what arrived, not what was claimed", async () => {
    // Sending more than claimed must not credit only the claimed figure.
    ok([transferLog({ from: USER, to: CUSTODY, amount: 25 })]);
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok && r.creditedUsdc, 25);
  });

  it("rejects a transfer smaller than the amount claimed", async () => {
    ok([transferLog({ from: USER, to: CUSTODY, amount: 1 })]);
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /less than the 10 claimed/);
  });

  it("rejects a transfer to a different address", async () => {
    ok([transferLog({ from: USER, to: ATTACKER, amount: 100 })]);
    assert.equal((await verifyAgentFunding(base, fakeClient)).ok, false);
  });

  it("rejects a transfer from someone else's wallet", async () => {
    // Otherwise any real transfer on chain could be cited by any user.
    ok([transferLog({ from: ATTACKER, to: CUSTODY, amount: 100 })]);
    assert.equal((await verifyAgentFunding(base, fakeClient)).ok, false);
  });

  it("ignores transfers of a different token", async () => {
    ok([
      transferLog({ token: OTHER_TOKEN, from: USER, to: CUSTODY, amount: 100 }),
    ]);
    assert.equal((await verifyAgentFunding(base, fakeClient)).ok, false);
  });

  it("rejects a reverted transaction", async () => {
    ok([transferLog({ from: USER, to: CUSTODY, amount: 100 })], "reverted");
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /did not succeed/);
  });

  it("rejects an unknown transaction hash", async () => {
    receiptError = new Error("not found");
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /not found on Arc/);
  });

  it("rejects a malformed hash without touching the chain", async () => {
    const r = await verifyAgentFunding({ ...base, txHash: "0xdeadbeef" }, fakeClient);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /not a transaction hash/);
  });

  it("rejects when the user has no wallet address", async () => {
    ok([transferLog({ from: USER, to: CUSTODY, amount: 100 })]);
    const r = await verifyAgentFunding({ ...base, expectedSender: "" }, fakeClient);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /wallet setup/);
  });

  it("sums split transfers within one transaction", async () => {
    ok([
      transferLog({ from: USER, to: CUSTODY, amount: 4 }),
      transferLog({ from: USER, to: CUSTODY, amount: 6 }),
      // An unrelated leg in the same tx must not count.
      transferLog({ from: USER, to: ATTACKER, amount: 500 }),
    ]);
    const r = await verifyAgentFunding(base, fakeClient);
    assert.equal(r.ok && r.creditedUsdc, 10);
  });
});

describe("USDC unit conversion", () => {
  it("round-trips whole and fractional amounts", () => {
    for (const v of [0.01, 1, 10.5, 1234.567891]) {
      assert.equal(atomicToUsdc(usdcToAtomic(v)), v);
    }
  });

  it("uses 6 decimals", () => {
    assert.equal(usdcToAtomic(1), 1_000_000n);
  });
});
