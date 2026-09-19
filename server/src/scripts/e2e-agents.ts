/**
 * End-to-end check of §8.2 with real money on Arc testnet, run with the
 * server stopped (it takes the financial writer lease the server holds).
 *
 *   npx tsx src/scripts/e2e-agents.ts paywall <agentId> <sellerHandle>
 *   npx tsx src/scripts/e2e-agents.ts hire    <agentId> <workerHandle>
 *   npx tsx src/scripts/e2e-agents.ts deliver <taskId>
 *
 * paywall  the seller gets a $0.01 text paywall; the agent pays it through
 *          x402PayForAgent — the function /v1/x402/pay calls — so Circle
 *          verifies, Evabob delivers and checks, then Circle settles.
 * hire     the agent hires the worker for $0.05; the fee is locked on chain
 *          in a job hold before they start.
 * deliver  the worker marks it delivered and the agent accepts, releasing it.
 */
import { connectMongo } from "../services/mongo.js";
import { acquireFinancialWriterLease } from "../services/financial-writer-lease.js";
import { flushPrimaryStore, initializePrimaryStore } from "../services/primary-store.js";

const [step, a, b] = process.argv.slice(2);
await connectMongo();
const lease = await acquireFinancialWriterLease();
await initializePrimaryStore();

const log = (label: string, value: unknown) =>
  console.log(`[e2e] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const { store } = await import("../store/db.js");

  if (step === "paywall") {
    const agent = store.getAgentById(a!)!;
    const seller = store.findUserByHandle(b!)!;
    const pw = await import("../services/paywalls.js");
    const { x402PayForAgent } = await import("../services/x402Pay.js");
    const { evidenceForPayment, bundleHash } = await import("../services/agentEvidence.js");

    log("agent before", { balance: agent.balanceUsdc });
    const paywall = await pw.createPaywall(seller.id, {
      kind: "text",
      title: "End-to-end check: an agent pays a paywall",
      priceUsdc: 0.01,
      text: "Paid after proof. You are reading this because the payment was taken only after it was checked.",
    });
    const treasury = await pw.ensureTreasury();
    log("paywall", { id: paywall.id, url: pw.paywallUrl(paywall.id), treasury: treasury.address });
    await flushPrimaryStore();

    const key = `e2e-paywall-${Date.now()}`;
    const result = await x402PayForAgent({ agent, url: pw.paywallResourceUrl(paywall.id), idempotencyKey: key });
    log("pay result", {
      ok: result.ok, paid: result.paid, status: result.status, cost: result.costUsdc,
      settlement: result.settlement, code: result.code, error: result.error, evidenceId: result.evidenceId,
    });
    log("body", typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    const row = agent.paymentHistory?.find((p) => p.key === key);
    log("agent payment", { status: row?.status, amount: row?.amountUsdc, settlement: row?.settlement });
    const sale = pw.salesFor(seller.id, paywall.id)[0];
    log("sale", sale);
    for (const bundle of evidenceForPayment(agent.id, key)) {
      log("evidence", { id: bundle.id, outcome: bundle.payment.outcome, bodySha256: bundle.cameBack.sha256, hashMatches: bundleHash(bundle) === bundle.hash });
    }
    log("agent after", { balance: agent.balanceUsdc });
    pw.setPaywallActive(seller.id, paywall.id, false);
  } else if (step === "hire") {
    const agent = store.getAgentById(a!)!;
    const tasks = await import("../services/agentTasks.js");
    log("agent before", { balance: agent.balanceUsdc });
    const task = await tasks.postTask(agent, {
      to: `@${b}`,
      title: "End-to-end check: an agent hires a person",
      description: "Reply 'done' when you see this. The money is set aside before you start.",
      amountUsdc: 0.05,
      deliveryDays: 1,
      idempotencyKey: `e2e-hire-${Date.now()}`,
    });
    log("posted", { id: task.id, status: task.status });
    await flushPrimaryStore();
    for (let i = 0; i < 90 && task.status === "locking"; i++) {
      await sleep(5_000);
      await tasks.advanceTask(task.id);
      await flushPrimaryStore();
      if (i % 3 === 0) log("lock step", { status: task.status, step: task.lock.step, error: task.error });
    }
    log("task", tasks.taskView(task));
    log("lock", { mintTx: task.lock.mintTx, createTx: task.lock.createTx, transferId: task.transferId });
    log("agent after", { balance: agent.balanceUsdc });
  } else if (step === "deliver") {
    const tasks = await import("../services/agentTasks.js");
    const held = await import("../services/heldPayments.js");
    const task = tasks.getTask(a!)!;
    await sleep(1_000); // let escrow-jobs finish loading
    await held.markDelivered({
      transferId: task.transferId!,
      userId: task.takerUserId!,
      note: "Delivered for the end-to-end check.",
    });
    log("marked delivered", tasks.taskView(task).delivered);
    await flushPrimaryStore();
    await tasks.acceptDelivery(task);
    const { findTrackedByTransferId } = await import("../services/escrow-jobs.js");
    const record = findTrackedByTransferId(task.transferId!);
    log("released", { taskStatus: task.status, holdStatus: record?.status, claimTx: record?.claimTx, settledBy: record?.settledBy });
  } else {
    throw new Error("step must be paywall, hire or deliver");
  }
} catch (e) {
  console.error("[e2e] FAILED:", e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
} finally {
  await flushPrimaryStore().catch((e) => console.error("[e2e] flush failed", e));
  await lease.release();
  setTimeout(() => process.exit(), 500);
}
