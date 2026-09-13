import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-agent-payment-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
const { store } = await import("../store/db.js");

after(() => {
  process.chdir(originalCwd);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows */ }
});

function fundedAgent() {
  const agent = store.createAgent({
    userId: "owner",
    label: "Research",
    dailyLimitUsdc: 2,
    perCallLimitUsdc: 1,
    apiKeyHash: "hash",
    apiKeyPrefix: "sk_evabob_test",
    custodyMode: "circle-eoa",
    custodyAddress: "0x1111111111111111111111111111111111111111",
    circleWalletId: "circle-wallet-id",
  });
  agent.balanceUsdc = 3;
  store.save();
  return agent;
}

test("reserves balance before authorization and enforces idempotency", () => {
  const agent = fundedAgent();
  const first = store.reserveAgentPayment(agent, {
    key: "payment-key-0001",
    url: "https://api.example.com/data",
    amountUsdc: 0.5,
  });
  assert.equal(first.fresh, true);
  assert.equal(agent.balanceUsdc, 2.5);
  assert.equal(agent.spentTodayUsdc, 0.5);
  const retry = store.reserveAgentPayment(agent, {
    key: "payment-key-0001",
    url: "https://api.example.com/data",
    amountUsdc: 0.5,
  });
  assert.equal(retry.fresh, false);
  assert.equal(agent.balanceUsdc, 2.5);
  assert.throws(() => store.reserveAgentPayment(agent, {
    key: "payment-key-0001",
    url: "https://api.example.com/other",
    amountUsdc: 0.5,
  }), /different agent payment/);
});

test("only undisclosed reservations can be released", () => {
  const agent = fundedAgent();
  store.reserveAgentPayment(agent, {
    key: "payment-key-0002",
    url: "https://api.example.com/data",
    amountUsdc: 0.75,
  });
  store.releaseAgentPayment(agent, "payment-key-0002", "signing failed");
  assert.equal(agent.balanceUsdc, 3);

  store.reserveAgentPayment(agent, {
    key: "payment-key-0003",
    url: "https://api.example.com/data",
    amountUsdc: 0.75,
  });
  store.updateAgentPayment(agent, "payment-key-0003", { status: "authorized" });
  assert.throws(
    () => store.releaseAgentPayment(agent, "payment-key-0003", "network failed"),
    /cannot be released automatically/,
  );
});

test("rejects per-call, daily, and balance overruns", () => {
  const agent = fundedAgent();
  assert.throws(() => store.reserveAgentPayment(agent, {
    key: "payment-key-0004",
    url: "https://api.example.com/data",
    amountUsdc: 1.01,
  }), /per-call/);
  agent.spentTodayUsdc = 1.5;
  assert.throws(() => store.reserveAgentPayment(agent, {
    key: "payment-key-0005",
    url: "https://api.example.com/data",
    amountUsdc: 0.75,
  }), /daily limit/);
  agent.spentTodayUsdc = 0;
  agent.balanceUsdc = 0.1;
  assert.throws(() => store.reserveAgentPayment(agent, {
    key: "payment-key-0006",
    url: "https://api.example.com/data",
    amountUsdc: 0.2,
  }), /Insufficient/);
});
