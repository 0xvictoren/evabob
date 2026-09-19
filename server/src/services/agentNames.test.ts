import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch data, and no chain keys: nothing here can send a transaction.
for (const k of ["IDENTITY_REGISTRY", "PRIVATE_KEY", "IDENTITY_LINKER_PRIVATE_KEY", "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]) {
  delete process.env[k];
}
process.env.PAYMENT_ESCROW = "0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39";
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-agent-names-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { store } = await import("../store/db.js");
const names = await import("./agentNames.js");
const tasks = await import("./agentTasks.js");
const controls = await import("./agentControls.js");
const { resolvePayee } = await import("./resolvePayee.js");
const { checkPayee } = await import("./safeSend.js");

after(() => {
  process.chdir(originalCwd);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows */ }
});

function makeAgent(label = "Research agent") {
  const agent = store.createAgent({
    userId: "ada",
    label,
    dailyLimitUsdc: 50,
    apiKeyHash: `hash-${Math.random()}`,
    apiKeyPrefix: "sk_evabob_test",
    custodyMode: "circle-eoa",
    custodyAddress: `0x${Math.floor(Math.random() * 1e15).toString(16).padStart(40, "a")}`,
    circleWalletId: "w1",
  });
  agent.balanceUsdc = 100;
  agent.allowance = { amountUsdc: 40, window: "week", categories: [], askAboveUsdc: 10, proofOnly: true };
  store.save();
  return agent;
}

before(() => {
  store.upsertUser({ id: "ada", email: "ada@example.com", handle: "ada", evmAddress: "0x1111111111111111111111111111111111111111" });
  store.upsertUser({ id: "bola", email: "bola@example.com", handle: "bola", evmAddress: "0x2222222222222222222222222222222222222222" });
});

describe("agent names", () => {
  it("share one namespace with people", async () => {
    const agent = makeAgent();
    await assert.rejects(names.claimAgentHandle(agent, "ada"), /taken/);
    await names.claimAgentHandle(agent, "@Ada_Research");
    assert.equal(agent.handle, "ada_research");
    // …and a person cannot then take the agent's name.
    assert.equal(store.isHandleTaken("ada_research", "bola"), true);
    // Names are permanent, so payers are never redirected.
    await assert.rejects(names.claimAgentHandle(agent, "other_name"), /permanent/);
  });

  it("are paid by handle, with the owner always shown", () => {
    const agent = store.findAgentByHandle("ada_research")!;
    const payee = resolvePayee("bola", "@ada_research");
    assert.equal(payee.ok, true);
    assert.equal(payee.ok && payee.address, agent.custodyAddress);
    assert.equal(payee.ok && payee.agent?.owner, "@ada");
    const check = checkPayee({ userId: "bola", to: "@ada_research", coolingOffMinutes: 10, holdsEnabled: true });
    assert.equal(check.ok, true);
    if (check.ok) {
      assert.equal(check.displayName, "Research agent · owned by @ada");
      // A hold releases to a person's identity; an agent is paid directly.
      assert.equal(check.coolingOff.available, false);
    }
    const profile = names.publicAgentProfile("ada_research")!;
    assert.equal(profile.byline, "Research agent · owned by @ada");
    assert.equal(profile.owner.handle, "@ada");
  });
});

describe("an agent's record", () => {
  it("counts hires and calls the way a seller's record counts orders", () => {
    const row = (key: string, status: string) => ({ key, url: "u", amountUsdc: 1, status: status as never, createdAt: "", updatedAt: "" });
    const r = names.countAgentRecord(
      [row("a", "settled"), row("b", "refunded"), row("c", "disputed"), row("task:x", "settled"), row("task-cost:x", "settled"), row("d", "released")],
      ["paid", "paid", "returned", "reviewed", "in_progress", "none"],
    );
    assert.deepEqual(r, {
      hiredAndPaid: 2, hiredNotDelivered: 1, hiredReviewed: 1, hiring: 1,
      callsDelivered: 1, callsNotCharged: 1, callsPaidNotDelivered: 1,
    });
  });
});

describe("income", () => {
  it("is money from others — not the owner's top-ups, mints, or the escrow's refunds", () => {
    const t = (from: string, txHash: string, token = "USDC") => ({ from, txHash, token });
    const out = names.incomeTransfers(
      [
        t("0xB0B0000000000000000000000000000000000000", "0x1"),
        t("0x1111111111111111111111111111111111111111", "0x2"), // owner
        t("0x0000000000000000000000000000000000000000", "0x3"), // Gateway mint
        t("0x37cb011c7a53e52f569b9c388b6208a71cd0df39", "0x4"), // escrow refund
        t("0xB0B0000000000000000000000000000000000000", "0x5", "EURC"),
        t("0xB0B0000000000000000000000000000000000000", "0x6"), // already credited
      ],
      {
        owner: "0x1111111111111111111111111111111111111111",
        escrow: "0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39",
        used: (h) => h === "0x6",
      },
    );
    assert.deepEqual(out.map((x) => x.txHash), ["0x1"]);
  });
});

describe("an agent hires a person", () => {
  it("reserves the fee from its balance the moment the task is posted", async () => {
    const agent = makeAgent("Hiring agent");
    const task = await tasks.postTask(agent, { title: "Photograph 20 shopfronts in Yaba", amountUsdc: 8 });
    assert.equal(task.status, "open");
    assert.equal(agent.balanceUsdc, Number((100 - 8 - tasks.LOCK_NETWORK_USDC).toFixed(6)));
    // The meter counts it like any spend.
    assert.ok(controls.liveMeter(agent).heldUsdc >= 8);
    const view = tasks.publicTaskView(task.id)!;
    assert.equal(view.takeable, true);
    assert.equal(view.agent.byline, "Hiring agent · owned by @ada");
    assert.match(view.statusText, /set aside the moment someone takes it/);
  });

  it("gives the money back if it is cancelled before anyone takes it", async () => {
    const agent = makeAgent("Cancelling agent");
    const task = await tasks.postTask(agent, { title: "Count cars", amountUsdc: 5 });
    await tasks.cancelTask(task);
    assert.equal(task.status, "cancelled");
    assert.equal(agent.balanceUsdc, 100);
  });

  it("above the owner's limit it waits for them; beyond the allowance it is refused", async () => {
    const agent = makeAgent("Asking agent");
    const big = await tasks.postTask(agent, { title: "Survey 100 shops", amountUsdc: 20 });
    assert.equal(big.status, "awaiting_approval");
    assert.equal(agent.balanceUsdc, 100); // nothing reserved yet
    controls.decideApproval(agent, big.approvalId!, true);
    assert.equal(big.status, "open");
    await assert.rejects(tasks.postTask(agent, { title: "Too much", amountUsdc: 30 }), /left of the \$40\.00 allowance/);
  });

  it("the owner cannot take their own agent's task, and a named hire must be a person", async () => {
    const agent = makeAgent("Picky agent");
    const task = await tasks.postTask(agent, { title: "Label photos", amountUsdc: 2 });
    assert.throws(() => tasks.takeTask(task.id, "ada"), /its own owner/);
    await assert.rejects(tasks.postTask(agent, { to: "@ada_research", title: "x", amountUsdc: 2 }), /That is an agent/);
    await assert.rejects(tasks.postTask(agent, { to: "@nobody_here", title: "x", amountUsdc: 2 }), /Nobody on Evabob/);
  });

  it("a paused agent cannot hire", async () => {
    const agent = makeAgent("Paused agent");
    controls.pauseAgent(agent, "owner");
    await assert.rejects(tasks.postTask(agent, { title: "x", amountUsdc: 2 }), /paused/);
    controls.resumeAgent(agent);
    assert.equal((await tasks.postTask(agent, { title: "x", amountUsdc: 2 })).status, "open");
  });

  it("one tap freezes every agent, and unfreezing leaves the others' own pauses alone", () => {
    const a = makeAgent("A");
    const b = makeAgent("B");
    controls.pauseAgent(b, "loop", "Called x 6 times in a minute");
    const frozen = controls.freezeAll("ada");
    assert.ok(frozen >= 1);
    assert.equal(a.pauseReason, "freeze");
    assert.equal(b.pauseReason, "loop");
    controls.unfreezeAll("ada");
    assert.equal(a.pausedAt, null);
    assert.equal(b.pauseReason, "loop");
  });
});
