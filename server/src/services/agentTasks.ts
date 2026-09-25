/**
 * An agent can hire a person — with the money locked first.
 *
 * Of 37 completed bounties in one documented case, 35 were never paid: the
 * work was done and the poster vanished. When the payer is software there is
 * not even a person to chase, and no card network can serve it, because the
 * payer is not a person. So here the fee is set aside before anyone starts:
 *
 *   1. The agent posts a task, for a named person or open to anyone.
 *   2. Before the person starts, the fee is locked on chain in the same job
 *      hold people use with each other (PaymentEscrowV3), for that person.
 *      They are told "the money is set aside before you start".
 *   3. They deliver and mark it delivered. The agent (or its owner) confirms,
 *      or says nothing for 7 days, and the hold releases to them.
 *   4. Nothing delivered by the deadline, and the hold expires: the fee goes
 *      back to the agent's wallet and into its balance again.
 *
 * Every rule after the lock is the job-hold rule set the product owner chose
 * (docs/HELD_PAYMENTS.md): the same release, refund and review code runs,
 * with the agent's owner as the payer of record. An agent disputing after
 * delivery sends it to a person for review, exactly as a person would.
 *
 * Money path: the agent's balance lives in Circle Gateway (it is what x402
 * payments spend). Locking withdraws the fee to the agent's own wallet on Arc,
 * approves the escrow, and creates the hold — each a Circle-signed call,
 * resumable from whatever step a restart interrupted.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { config } from "../config.js";
import { store, type AgentWallet } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { decide, allowanceOf } from "./agentAllowance.js";
import { findApproval, liveMeter, onApprovalDecided, pushAgentUpdate, requestApproval } from "./agentControls.js";
import { agentByline, agentRecord, registerTaskOutcomes } from "./agentNames.js";
import { alertUser } from "./notifyUser.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";

export const DEFAULT_DELIVERY_DAYS = 7;
export const MAX_DELIVERY_DAYS = 60;
export const DEFAULT_OPEN_DAYS = 7;
/** Gas for the approve, lock and fee calls from the agent's own wallet. */
export const LOCK_NETWORK_USDC = 0.05;
/** A floor only: the allowance and the owner's approval decide how big a hire can be. */
export const MIN_TASK_USDC = 0.05;
export const MAX_TASK_USDC = 5_000;

export type TaskStatus =
  | "awaiting_approval"
  | "open"
  | "locking"
  | "held"
  | "paid"
  | "returning"
  | "returned"
  | "declined"
  | "cancelled"
  | "failed";

export type AgentTask = {
  id: string;
  agentId: string;
  ownerId: string;
  title: string;
  description?: string;
  amountUsdc: number;
  feeUsdc: number;
  deliveryDays: number;
  open: boolean;
  /** The person, as the hold is locked for them: "@handle" or an email. */
  recipient?: string;
  takerUserId?: string;
  status: TaskStatus;
  openUntil?: string;
  approvalId?: string;
  /** The agent's idempotency key, so a retried post makes one task. */
  requestKey?: string;
  lock: {
    step: "withdraw" | "approve" | "create" | "fee" | "record" | "done";
    withdrawStartedAt?: string;
    gatewayTransferId?: string;
    mintTx?: string;
    approveId?: string;
    createId?: string;
    createTx?: string;
    feeId?: string;
    keys: { approve: string; create: string; fee: string };
  };
  transferId?: string;
  holdRecordId?: string;
  returnDeposit?: { approveKey: string; depositKey: string; error?: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export class TaskError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400, readonly code?: string) {
    super(message);
  }
}

const DATA_PATH = dataPath("agent-tasks.json");
let tasks: AgentTask[] = load();

function load(): AgentTask[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as AgentTask[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, tasks);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  tasks = load();
});

export function getTask(id: string): AgentTask | null {
  return tasks.find((t) => t.id === id) ?? null;
}

function touch(task: AgentTask, patch: Partial<AgentTask> = {}) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  save();
}

const taskKey = (task: AgentTask) => `task:${task.id}`;
const costKey = (task: AgentTask) => `task-cost:${task.id}`;

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

// ─── Record, for agentNames.ts ───────────────────────────────────────────

registerTaskOutcomes((agentId) =>
  tasks
    .filter((t) => t.agentId === agentId)
    .map((t) => {
      if (t.status === "paid") return "paid";
      if (t.status === "returned" || t.status === "returning") {
        return holdSettledBy(t)?.startsWith("review") ? "reviewed" : "returned";
      }
      if (t.status === "held" || t.status === "locking") return "in_progress";
      return "none";
    }),
);

function holdSettledBy(task: AgentTask) {
  return task.transferId ? holdRecord(task)?.settledBy : undefined;
}

function holdRecord(task: AgentTask) {
  if (!task.transferId) return undefined;
  // Imported lazily: escrow-jobs loads its own file at import.
  return trackedByTransferId?.(task.transferId);
}

let trackedByTransferId: ((id: string) => import("./mongo.js").ProtectedEscrowRecord | undefined) | null = null;
void import("./escrow-jobs.js").then((m) => {
  trackedByTransferId = m.findTrackedByTransferId;
});

// ─── Posting ─────────────────────────────────────────────────────────────

export type NewTask = {
  to?: string;
  title: string;
  description?: string;
  amountUsdc: number;
  deliveryDays?: number;
  openDays?: number;
  idempotencyKey?: string;
};

function clean(text: string | undefined, max: number): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** The identifier a hold is locked for: the person's handle, else email. */
function personFor(raw: string, ownerId: string): { recipient: string; userId: string } {
  const who = raw.trim();
  const user = store.findUserByRecipient(who.startsWith("@") || who.includes("@") ? who : `@${who}`);
  if (!user) {
    if (store.findAgentByHandle(who)) {
      throw new TaskError("That is an agent. An agent can hire a person; to pay an agent, pay it by name.");
    }
    throw new TaskError(`Nobody on Evabob is ${who}. Post it as an open task instead.`, 404);
  }
  if (user.id === ownerId) throw new TaskError("An agent cannot hire its own owner.");
  const recipient = user.handle ? `@${user.handle}` : user.email;
  if (!recipient) throw new TaskError("That person cannot be paid yet.");
  return { recipient, userId: user.id };
}

export function feeFor(amountUsdc: number): number {
  if (!config.platformFee.recipient) return 0;
  const flat = config.platformFee.flatUsd ?? 0;
  if (flat > 0) return amountUsdc > 0 ? flat : 0;
  const bps = config.platformFee.bps;
  return Math.floor(amountUsdc * 1e6 * bps / 10_000) / 1e6;
}

/**
 * Posts a task. The allowance applies like any spend: beyond what is left it
 * is refused, above the owner's limit the owner is asked first. The money is
 * reserved from the agent's balance at once, so a task never promises money
 * the agent does not have.
 */
export async function postTask(agent: AgentWallet, input: NewTask): Promise<AgentTask> {
  if (input.idempotencyKey) {
    const prior = tasks.find((t) => t.agentId === agent.id && t.requestKey === input.idempotencyKey);
    if (prior) return prior;
  }
  if (agent.revokedAt) throw new TaskError("This agent's key is revoked.", 403);
  if (agent.custodyMode !== "circle-eoa" || !agent.custodyAddress || !agent.circleWalletId) {
    throw new TaskError("This agent has no wallet of its own to pay from.", 409);
  }
  if (!config.arc.paymentEscrow) throw new TaskError("Holding money is not available right now.", 409);
  const title = clean(input.title, 120);
  if (!title) throw new TaskError("Say what the task is.");
  const amount = Math.round(input.amountUsdc * 1e6) / 1e6;
  if (!(amount >= MIN_TASK_USDC) || amount > MAX_TASK_USDC) {
    throw new TaskError(`A task pays between ${money(MIN_TASK_USDC)} and ${money(MAX_TASK_USDC)}.`);
  }
  const deliveryDays = Math.round(input.deliveryDays ?? DEFAULT_DELIVERY_DAYS);
  if (deliveryDays < 1 || deliveryDays > MAX_DELIVERY_DAYS) {
    throw new TaskError(`Delivery time must be 1 to ${MAX_DELIVERY_DAYS} days.`);
  }
  const person = input.to?.trim() ? personFor(input.to, agent.userId) : null;
  const fee = feeFor(amount);
  const now = new Date();
  const task: AgentTask = {
    id: `task_${randomBytes(9).toString("hex")}`,
    agentId: agent.id,
    ownerId: agent.userId,
    title,
    description: clean(input.description, 2_000),
    amountUsdc: amount,
    feeUsdc: fee,
    deliveryDays,
    open: !person,
    ...(person ? { recipient: person.recipient, takerUserId: person.userId } : {}),
    status: "awaiting_approval",
    ...(person ? {} : {
      openUntil: new Date(now.getTime() + Math.max(1, Math.min(30, input.openDays ?? DEFAULT_OPEN_DAYS)) * 86_400_000).toISOString(),
    }),
    ...(input.idempotencyKey ? { requestKey: input.idempotencyKey } : {}),
    lock: { step: "withdraw", keys: { approve: randomUUID(), create: randomUUID(), fee: randomUUID() } },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const total = Number((amount + fee + LOCK_NETWORK_USDC).toFixed(6));
  const meter = liveMeter(agent);
  const verdict = decide({
    allowance: allowanceOf(agent),
    paused: Boolean(agent.pausedAt),
    costUsdc: total,
    category: "people",
    waitsForProof: true, // paid only on delivery
    remainingUsdc: meter.remainingUsdc,
  });
  if (verdict.tier === "refuse") throw new TaskError(verdict.reason, 403, verdict.code);
  if (total > agent.balanceUsdc + 1e-9) {
    throw new TaskError(`This agent has ${money(agent.balanceUsdc)}; the task needs ${money(total)} set aside, including the fee.`, 409);
  }
  tasks.push(task);
  save();
  if (verdict.tier === "ask") {
    const approval = requestApproval(agent, {
      key: taskKey(task),
      url: `evabob://task/${task.id}`,
      seller: task.recipient ?? "whoever takes the task",
      category: "people",
      amountUsdc: total,
    });
    touch(task, { approvalId: approval.id });
    return task;
  }
  reserveFor(agent, task, "silent");
  return task;
}

/** Takes the money out of the agent's spendable balance for this task. */
function reserveFor(agent: AgentWallet, task: AgentTask, tier: "silent" | "approved") {
  const remaining = liveMeter(agent).remainingUsdc;
  store.reserveAgentPayment(agent, {
    key: taskKey(task),
    url: `evabob://task/${task.id}`,
    amountUsdc: task.amountUsdc,
    remainingUsdc: remaining,
    category: "people",
    settlement: "proof",
    tier,
    seller: task.recipient ?? "open task",
  });
  store.updateAgentPayment(agent, taskKey(task), { status: "held" });
  store.reserveAgentPayment(agent, {
    key: costKey(task),
    url: `evabob://task/${task.id}`,
    amountUsdc: Number((task.feeUsdc + LOCK_NETWORK_USDC).toFixed(6)),
    remainingUsdc: remaining - task.amountUsdc,
    category: "people",
    tier,
    seller: "Evabob fee and network cost",
  });
  store.updateAgentPayment(agent, costKey(task), { status: "held" });
  pushAgentUpdate(agent);
  if (task.open) {
    touch(task, { status: "open" });
  } else {
    touch(task, { status: "locking" });
    kick(task);
  }
}

onApprovalDecided((agent, approval) => {
  const task = tasks.find((t) => t.approvalId === approval.id && t.status === "awaiting_approval");
  if (!task) return;
  if (approval.status !== "approved") {
    touch(task, { status: "declined", error: "The owner declined" });
    return;
  }
  try {
    reserveFor(agent, task, "approved");
  } catch (e) {
    touch(task, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
});

/** Someone takes an open task. The money is locked for them before they start. */
export function takeTask(taskId: string, userId: string): AgentTask {
  const task = getTask(taskId);
  if (!task) throw new TaskError("No such task", 404);
  if (!task.open || task.status !== "open") throw new TaskError("Someone has already taken this task.", 409);
  if (task.openUntil && Date.parse(task.openUntil) < Date.now()) throw new TaskError("This task has closed.", 409);
  const user = store.getUser(userId);
  if (!user) throw new TaskError("Sign in first.", 403);
  if (user.id === task.ownerId) throw new TaskError("An agent cannot hire its own owner.");
  const recipient = user.handle ? `@${user.handle}` : user.email;
  if (!recipient) throw new TaskError("Pick a username in Profile first, so the money can be locked for you.");
  touch(task, { recipient, takerUserId: user.id, status: "locking" });
  kick(task);
  return task;
}

// ─── Locking ─────────────────────────────────────────────────────────────

const running = new Set<string>();

function kick(task: AgentTask) {
  void advanceTask(task.id).catch((e) =>
    console.warn(`[agent-task] ${task.id} will retry:`, e instanceof Error ? e.message : e),
  );
}

/** Moves a task one or more steps on. Safe to call repeatedly. */
export async function advanceTask(id: string): Promise<AgentTask | null> {
  const task = getTask(id);
  if (!task || running.has(id)) return task;
  running.add(id);
  try {
    if (task.status === "locking") await advanceLock(task);
    else if (task.status === "held") syncHold(task);
    else if (task.status === "returning") await returnToAgent(task);
    return task;
  } finally {
    running.delete(id);
  }
}

async function advanceLock(task: AgentTask) {
  const agent = store.getAgentById(task.agentId);
  if (!agent?.custodyAddress || !agent.circleWalletId) {
    return failBeforeMoney(task, "The agent's wallet is gone");
  }
  const eoa = agent.custodyAddress as Address;
  const escrow = config.arc.paymentEscrow;
  const units = String(Math.round(task.amountUsdc * 1e6));
  const lock = task.lock;
  const { agentContractCall } = await import("./agentWallet.js");

  if (lock.step === "withdraw") {
    if (!lock.gatewayTransferId && !lock.mintTx) {
      if (lock.withdrawStartedAt) {
        // A withdrawal was started and its id never recorded (a crash
        // between the two). Whether it landed is visible on chain.
        const { agentWalletBalance } = await import("./agentWallet.js");
        const onChain = await agentWalletBalance(agent.circleWalletId);
        if (onChain + 1e-9 >= task.amountUsdc + task.feeUsdc) {
          lock.mintTx = "observed-on-chain";
        } else if (Date.now() - Date.parse(lock.withdrawStartedAt) > 30 * 60_000) {
          return touch(task, { status: "failed", error: "The withdrawal to the agent's wallet needs checking by an operator. Nothing was locked." });
        } else {
          return;
        }
      } else {
        lock.withdrawStartedAt = new Date().toISOString();
        touch(task);
        const { gatewayWithdrawFromAgent } = await import("./gateway-e2e.js");
        try {
          const sent = await gatewayWithdrawFromAgent({
            walletId: agent.circleWalletId,
            address: eoa,
            amountUsdc: Number((task.amountUsdc + task.feeUsdc + LOCK_NETWORK_USDC).toFixed(6)),
            destinationAddress: eoa,
          });
          lock.gatewayTransferId = sent.transferId;
          lock.mintTx = sent.mintTx;
          touch(task);
        } catch (e) {
          // Refused before anything moved: give the reservation back.
          return failBeforeMoney(task, e instanceof Error ? e.message : String(e));
        }
      }
    }
    if (!lock.mintTx && lock.gatewayTransferId) {
      const { pollGatewayTransfer } = await import("./gateway-e2e.js");
      const polled = await pollGatewayTransfer(lock.gatewayTransferId, { timeoutMs: 10_000 });
      if (!polled.mintTx) return;
      lock.mintTx = polled.mintTx;
    }
    if (!lock.mintTx) return;
    // The fee and network cost are now spent whatever happens next.
    store.updateAgentPayment(agent, costKey(task), { status: "settled" });
    lock.step = "approve";
    touch(task);
  }

  try {
    if (lock.step === "approve") {
      await agentContractCall({
        walletAddress: eoa,
        contractAddress: config.arc.usdc,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [escrow, units],
        idempotencyKey: lock.keys.approve,
        existingId: lock.approveId,
        onCreated: (id) => {
          lock.approveId = id;
          touch(task);
        },
      });
      lock.step = "create";
      touch(task);
    }
    if (lock.step === "create") {
      const { escrowRecipientKey, readCreatedTransferIds } = await import("./protectedEscrow.js");
      const { key } = escrowRecipientKey(task.recipient!);
      const out = await agentContractCall({
        walletAddress: eoa,
        contractAddress: escrow,
        abiFunctionSignature: "createTransfer(bytes32,uint128,uint64,string)",
        abiParameters: [key, units, String(task.deliveryDays * 86_400), task.title.slice(0, 80)],
        idempotencyKey: lock.keys.create,
        existingId: lock.createId,
        onCreated: (id) => {
          lock.createId = id;
          touch(task);
        },
      });
      if (!out.txHash) throw new Error("The lock has no transaction hash yet");
      const created = (await readCreatedTransferIds(out.txHash)).find(
        (c) => c.sender.toLowerCase() === eoa.toLowerCase(),
      );
      if (!created) throw new Error("The lock transaction created no hold");
      lock.createTx = out.txHash;
      task.transferId = created.transferId;
      lock.step = "fee";
      touch(task);
    }
    if (lock.step === "fee") {
      const units = Math.round(task.feeUsdc * 1e6);
      if (units > 0 && config.platformFee.recipient) {
        try {
          await agentContractCall({
            walletAddress: eoa,
            contractAddress: config.arc.usdc,
            abiFunctionSignature: "transfer(address,uint256)",
            abiParameters: [config.platformFee.recipient, String(units)],
            idempotencyKey: lock.keys.fee,
            existingId: lock.feeId,
            onCreated: (id) => {
              lock.feeId = id;
              touch(task);
            },
          });
        } catch (e) {
          // The person's money is locked; a missed fee must not hold them up.
          console.warn(`[agent-task] ${task.id} fee not taken:`, e instanceof Error ? e.message : e);
        }
      }
      lock.step = "record";
      touch(task);
    }
    if (lock.step === "record") {
      const { trackProtectedEscrow } = await import("./escrow-jobs.js");
      const { escrowRecipientKey, readTransfer } = await import("./protectedEscrow.js");
      const { kind, normalized } = escrowRecipientKey(task.recipient!);
      const onChain = await readTransfer(task.transferId!);
      const record = trackProtectedEscrow({
        onChainTransferId: task.transferId!,
        contractAddress: escrow,
        purpose: "job",
        fromUserId: task.ownerId,
        payerAgentId: task.agentId,
        agentTaskId: task.id,
        recipientKind: kind === "email" ? "email" : "phone",
        recipientId: normalized,
        amountUsdc: task.amountUsdc,
        memo: task.title,
        createTx: lock.createTx,
        expiresInMs: Math.max(0, onChain.expiresAt * 1000 - Date.now()),
      });
      lock.step = "done";
      touch(task, { status: "held", holdRecordId: record.id });
      announceLocked(task, agent);
    }
  } catch (e) {
    // After the withdrawal the money is in the agent's own wallet; a failed
    // step is retried on the next tick rather than abandoned.
    touch(task, { error: e instanceof Error ? e.message : String(e) });
  }
}

function failBeforeMoney(task: AgentTask, reason: string) {
  const agent = store.getAgentById(task.agentId);
  if (agent) {
    for (const key of [taskKey(task), costKey(task)]) {
      try {
        store.refundHeldAgentPayment(agent, key, reason);
      } catch {
        /* already settled or never reserved */
      }
    }
    pushAgentUpdate(agent);
  }
  touch(task, { status: "failed", error: reason });
  alertUser(task.ownerId, {
    kind: "agent_task",
    title: "A hire did not go through",
    body: `${task.title}: ${reason}. Nothing was taken.`,
    link: `evabob://agents/${task.agentId}`,
  });
}

function announceLocked(task: AgentTask, agent: AgentWallet) {
  if (task.takerUserId) {
    alertUser(task.takerUserId, {
      kind: "agent_task",
      title: `${money(task.amountUsdc)} is set aside for you`,
      body: `${agentByline(agent)} hired you: ${task.title}. The money is set aside before you start. Deliver within ${task.deliveryDays} days and mark it delivered to be paid.`,
      amountUsdc: task.amountUsdc,
      token: "USDC",
      transferId: task.transferId,
    });
  }
  alertUser(task.ownerId, {
    kind: "agent_task",
    title: `${agent.label} hired ${task.recipient}`,
    body: `${money(task.amountUsdc)} is set aside for "${task.title}".`,
    transferId: task.transferId,
  });
}

// ─── After the lock ──────────────────────────────────────────────────────

/** Follows the hold: released means paid; refunded means it comes back. */
function syncHold(task: AgentTask) {
  const record = holdRecord(task);
  if (!record) return;
  const agent = store.getAgentById(task.agentId);
  if (record.status === "claimed") {
    if (agent) {
      store.updateAgentPayment(agent, taskKey(task), { status: "settled" });
      pushAgentUpdate(agent);
    }
    touch(task, { status: "paid" });
  } else if (record.status === "refunded") {
    touch(task, { status: "returning" });
    kick(task);
  }
}

/**
 * Puts a returned fee back where the agent can spend it: from its wallet on
 * Arc into its Gateway balance, then into its ledger.
 */
async function returnToAgent(task: AgentTask) {
  const agent = store.getAgentById(task.agentId);
  if (!agent?.custodyAddress || !agent.circleWalletId) return;
  const { agentWalletBalance, depositAgentWalletToGateway } = await import("./agentWallet.js");
  const onChain = await agentWalletBalance(agent.circleWalletId);
  if (onChain + 1e-9 < task.amountUsdc) return; // refund not visible yet
  const keys = task.returnDeposit ?? { approveKey: randomUUID(), depositKey: randomUUID() };
  task.returnDeposit = keys;
  touch(task);
  try {
    await depositAgentWalletToGateway({
      walletAddress: agent.custodyAddress as Address,
      amountUsdc: task.amountUsdc,
      approveIdempotencyKey: keys.approveKey,
      depositIdempotencyKey: keys.depositKey,
      async onApproveCreated() {},
      async onDepositCreated() {},
    });
  } catch (e) {
    task.returnDeposit.error = e instanceof Error ? e.message : String(e);
    touch(task);
    return;
  }
  try {
    store.refundHeldAgentPayment(agent, taskKey(task), "Nothing was delivered; the fee came back");
  } catch {
    /* already credited */
  }
  pushAgentUpdate(agent);
  touch(task, { status: "returned" });
}

/** Tick work: locks in progress, holds to follow, open tasks that closed. */
export async function runAgentTaskWork(now = Date.now()): Promise<{ advanced: number; errors: string[] }> {
  const errors: string[] = [];
  let advanced = 0;
  for (const task of tasks) {
    if (task.status === "open" && task.openUntil && Date.parse(task.openUntil) < now) {
      cancelUnlocked(task, "Nobody took it before it closed");
      advanced += 1;
      continue;
    }
    if (task.status === "awaiting_approval" && task.approvalId) {
      const agent = store.getAgentById(task.agentId);
      const approval = agent ? findApproval(agent, taskKey(task), now) : null;
      if (!approval || approval.status === "expired" || approval.status === "declined") {
        touch(task, { status: "declined", error: "The owner did not approve it" });
        advanced += 1;
      }
      continue;
    }
    if (task.status !== "locking" && task.status !== "held" && task.status !== "returning") continue;
    try {
      await advanceTask(task.id);
      advanced += 1;
    } catch (e) {
      errors.push(`${task.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { advanced, errors };
}

/** Cancels a task whose money never left the agent's balance. */
function cancelUnlocked(task: AgentTask, reason: string) {
  const agent = store.getAgentById(task.agentId);
  if (agent) {
    for (const key of [taskKey(task), costKey(task)]) {
      try {
        store.refundHeldAgentPayment(agent, key, reason);
      } catch {
        /* never reserved */
      }
    }
    pushAgentUpdate(agent);
  }
  touch(task, { status: "cancelled", error: reason });
}

/**
 * The agent (or its owner) cancels. Before anyone took it, nothing was
 * locked and the reservation simply goes back. Once locked, it is the job
 * hold's cancel: straight back before delivery, to review after.
 */
export async function cancelTask(
  task: AgentTask,
  input: { reason?: "no_longer_needed" | "not_as_agreed" | "not_received" | "other"; details?: string } = {},
) {
  if (task.status === "open" || task.status === "awaiting_approval") {
    cancelUnlocked(task, "Cancelled by the agent");
    return task;
  }
  if (task.status !== "held" || !task.transferId) {
    throw new TaskError(`This task is ${task.status.replace("_", " ")} and cannot be cancelled now.`, 409);
  }
  const { cancelHold } = await import("./heldPayments.js");
  await cancelHold({
    transferId: task.transferId,
    userId: task.ownerId,
    reason: input.reason ?? "no_longer_needed",
    details: input.details,
  });
  syncHold(task);
  return task;
}

/** The agent says the work arrived: the person is paid now. */
export async function acceptDelivery(task: AgentTask) {
  if (task.status !== "held" || !task.transferId) throw new TaskError("Nothing is waiting to be paid on this task.", 409);
  const { confirmRelease } = await import("./heldPayments.js");
  await confirmRelease({ transferId: task.transferId, userId: task.ownerId });
  syncHold(task);
  return task;
}

// ─── Views ───────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<TaskStatus, string> = {
  awaiting_approval: "Waiting for the owner to approve",
  open: "Open — the money is set aside the moment someone takes it",
  locking: "Setting the money aside",
  held: "Money set aside — work can start",
  paid: "Paid",
  returning: "Nothing delivered — going back to the agent",
  returned: "Nothing delivered — went back to the agent",
  declined: "The owner declined",
  cancelled: "Cancelled",
  failed: "Did not go through",
};

/** What the agent sees through its API, and the owner in the app. */
export function taskView(task: AgentTask) {
  const record = holdRecord(task);
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    amountUsdc: task.amountUsdc,
    feeUsdc: task.feeUsdc,
    deliveryDays: task.deliveryDays,
    open: task.open,
    person: task.recipient ?? null,
    status: task.status,
    statusText: STATUS_WORDS[task.status],
    moneySetAside: ["held", "paid"].includes(task.status),
    transferId: task.transferId ?? null,
    lockTx: task.lock.createTx ?? null,
    delivered: record?.deliveredAt
      ? { at: record.deliveredAt, note: record.deliveryNote ?? "", links: record.deliveryLinks ?? [] }
      : null,
    autoReleaseAt: record?.autoReleaseAt ?? null,
    underReview: record?.review?.status === "under_review",
    openUntil: task.openUntil ?? null,
    error: task.status === "failed" || task.status === "declined" ? task.error ?? null : null,
    createdAt: task.createdAt,
    publicUrl: `${(config.appPublicUrl || "https://evabob.app").replace(/\/$/, "")}/t/${task.id}`,
  };
}

/** What anyone sees: enough to decide whether to take it, nothing private. */
export function publicTaskView(id: string) {
  const task = getTask(id);
  if (!task) return null;
  const agent = store.getAgentById(task.agentId);
  if (!agent) return null;
  const owner = store.getUser(agent.userId);
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    amountUsdc: task.amountUsdc,
    deliveryDays: task.deliveryDays,
    open: task.open,
    takeable: task.open && task.status === "open" && (!task.openUntil || Date.parse(task.openUntil) > Date.now()),
    status: task.status,
    statusText: STATUS_WORDS[task.status],
    openUntil: task.openUntil ?? null,
    agent: {
      label: agent.label,
      handle: agent.handle ? `@${agent.handle}` : null,
      owner: owner?.handle ? `@${owner.handle}` : owner?.displayName ?? null,
      byline: agentByline(agent),
      record: agentRecord(agent),
    },
    deepLink: `evabob://task/${task.id}`,
  };
}

export function tasksForAgent(agentId: string) {
  return tasks
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
}

/** Open tasks anyone can take, newest first. */
export function openTasks(now = Date.now()) {
  return tasks
    .filter((t) => t.status === "open" && (!t.openUntil || Date.parse(t.openUntil) > now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((t) => publicTaskView(t.id)!)
    .filter(Boolean);
}

/** Tasks a person was hired for or took, for their app. */
export function tasksForPerson(userId: string) {
  return tasks
    .filter((t) => t.takerUserId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((t) => ({ ...publicTaskView(t.id)!, transferId: t.transferId ?? null }));
}
