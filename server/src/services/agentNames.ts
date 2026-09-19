/**
 * Agents with names, and reputations.
 *
 * An agent gets a handle from the same namespace as people — "@name" always
 * means one payee — and is registered in the identity registry as an Agent
 * identity: a type appended after Phone, Email and Handle, so no existing key
 * changes. Anyone can pay it by handle, and wherever it appears its owner is
 * shown with it: "Research agent · owned by @ada".
 *
 * Its record accumulates the way a human seller's does, from what actually
 * happened: people it hired and paid, fees that went back because nothing was
 * delivered, holds a reviewer had to settle, and paid calls — delivered,
 * failed their check at no cost, or paid for nothing.
 *
 * Money paid to an agent lands in its own wallet on chain. The income sweep
 * moves it into the agent's spendable balance, leaving the owner's own
 * top-ups (which the owner's app deposits itself) alone.
 */

import type { Address } from "viem";
import { store, type AgentWallet } from "../store/db.js";
import { validateHandle } from "../utils/handles.js";
import { alertUser } from "./notifyUser.js";

export class AgentNameError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export function ownerLabel(agent: AgentWallet): string {
  const owner = store.getUser(agent.userId);
  return owner?.handle ? `@${owner.handle}` : owner?.displayName || "its owner";
}

/** "Research agent · owned by @ada" — how an agent is always shown. */
export function agentByline(agent: AgentWallet): string {
  return `${agent.label} · owned by ${ownerLabel(agent)}`;
}

/**
 * Gives an agent its payable handle and registers it on chain. The name is
 * reserved at once; the registry link follows and is retried by the tick if
 * the chain is slow, since only paying *by handle through the registry*
 * needs it.
 */
export async function claimAgentHandle(agent: AgentWallet, raw: string): Promise<AgentWallet> {
  if (agent.handle) throw new AgentNameError("This agent already has a name. Names are permanent, so payers are never redirected.", 409);
  if (!agent.custodyAddress || agent.custodyMode !== "circle-eoa") {
    throw new AgentNameError("This agent has no wallet of its own to be paid into.", 409);
  }
  const valid = validateHandle(raw);
  if (!valid.ok) throw new AgentNameError(valid.error);
  if (store.isHandleTaken(valid.handle, undefined, agent.id)) {
    throw new AgentNameError("That name is taken.", 409);
  }
  agent.handle = valid.handle;
  store.save();
  void linkAgentHandle(agent).catch((e) =>
    console.warn(`[agent-name] link @${valid.handle} pending:`, e instanceof Error ? e.message : e),
  );
  return agent;
}

/** Registers the handle as an Agent identity. Safe to repeat. */
export async function linkAgentHandle(agent: AgentWallet): Promise<void> {
  if (!agent.handle || !agent.custodyAddress || agent.handleLinkTx) return;
  const { adminLinkIdentity } = await import("./identity.js");
  const result = await adminLinkIdentity({
    account: agent.custodyAddress as Address,
    kind: "agent",
    identifier: agent.handle,
  });
  agent.handleLinkTx = result.status === "linked" ? result.txHash : "already-current";
  store.save();
}

/** Retries registry links that did not go through the first time. */
export async function linkPendingAgentHandles(): Promise<number> {
  let n = 0;
  for (const agent of store.listAllAgents()) {
    if (!agent.handle || agent.handleLinkTx) continue;
    try {
      await linkAgentHandle(agent);
      n += 1;
    } catch {
      /* next tick */
    }
  }
  return n;
}

// ─── Record ──────────────────────────────────────────────────────────────

export type AgentRecord = {
  /** People it hired whose fee reached them. */
  hiredAndPaid: number;
  /** Fees that went back because nothing was delivered in time. */
  hiredNotDelivered: number;
  /** Holds a reviewer settled after a dispute. */
  hiredReviewed: number;
  /** Hires still in progress. */
  hiring: number;
  /** Paid calls whose response passed its check. */
  callsDelivered: number;
  /** Calls whose response failed its check; nothing was charged. */
  callsNotCharged: number;
  /** Calls a seller was paid for and returned nothing usable. */
  callsPaidNotDelivered: number;
};

type TaskOutcome = "paid" | "returned" | "reviewed" | "in_progress" | "none";
let taskOutcomes: (agentId: string) => TaskOutcome[] = () => [];

/** agentTasks.ts supplies how each of an agent's hires ended. */
export function registerTaskOutcomes(fn: (agentId: string) => TaskOutcome[]): void {
  taskOutcomes = fn;
}

/** Pure: an agent's record from its payment history and its hires. */
export function countAgentRecord(
  history: NonNullable<AgentWallet["paymentHistory"]>,
  hires: TaskOutcome[],
): AgentRecord {
  const r: AgentRecord = {
    hiredAndPaid: 0,
    hiredNotDelivered: 0,
    hiredReviewed: 0,
    hiring: 0,
    callsDelivered: 0,
    callsNotCharged: 0,
    callsPaidNotDelivered: 0,
  };
  for (const h of hires) {
    if (h === "paid") r.hiredAndPaid += 1;
    else if (h === "returned") r.hiredNotDelivered += 1;
    else if (h === "reviewed") r.hiredReviewed += 1;
    else if (h === "in_progress") r.hiring += 1;
  }
  for (const p of history) {
    // Hires (task:) and their fee and network cost (task-cost:) are not calls.
    if (p.key.startsWith("task:") || p.key.startsWith("task-cost:")) continue;
    if (p.status === "settled") r.callsDelivered += 1;
    else if (p.status === "refunded") r.callsNotCharged += 1;
    else if (p.status === "disputed") r.callsPaidNotDelivered += 1;
  }
  return r;
}

export function agentRecord(agent: AgentWallet): AgentRecord {
  return countAgentRecord(agent.paymentHistory ?? [], taskOutcomes(agent.id));
}

/** What anyone sees about a named agent. Nothing about its balance. */
export function publicAgentProfile(handle: string) {
  const agent = store.findAgentByHandle(handle);
  if (!agent?.handle) return null;
  const owner = store.getUser(agent.userId);
  return {
    kind: "agent" as const,
    handle: `@${agent.handle}`,
    label: agent.label,
    byline: agentByline(agent),
    owner: {
      handle: owner?.handle ? `@${owner.handle}` : null,
      name: owner?.displayName ?? null,
    },
    address: agent.custodyAddress ?? null,
    onChain: Boolean(agent.handleLinkTx),
    since: agent.createdAt,
    active: !agent.revokedAt,
    record: agentRecord(agent),
  };
}

// ─── Income ──────────────────────────────────────────────────────────────

/** Left in the agent's own wallet to pay for the deposit transactions. */
export const INCOME_GAS_RESERVE_USDC = 0.05;
/** Below this, income waits for more before paying to deposit it. */
export const INCOME_MIN_USDC = 0.1;
const INCOME_LOOKBACK_BLOCKS = 50_000n;

/**
 * Which inbound transfers to an agent are income. Pure. The owner's own
 * top-ups are left for the owner's deposit; mints are Gateway withdrawals the
 * agent made itself; the escrow's refunds are hires coming back, handled by
 * agentTasks.ts.
 */
export function incomeTransfers<T extends { from: string; txHash: string; token: string }>(
  found: T[],
  exclude: { owner?: string; escrow?: string; self?: string; used: (txHash: string) => boolean },
): T[] {
  const skip = new Set(
    [exclude.owner, exclude.escrow, exclude.self, "0x0000000000000000000000000000000000000000"]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase()),
  );
  return found.filter(
    (t) => t.token === "USDC" && !skip.has(t.from.toLowerCase()) && !exclude.used(t.txHash),
  );
}

/**
 * Credits money paid to named agents. For each, reads USDC transfers to its
 * wallet since the last pass, deposits the income into its Gateway balance
 * (what it spends from), and records who paid.
 */
export async function sweepAgentIncome(perPass = 2): Promise<{ credited: number; errors: string[] }> {
  const errors: string[] = [];
  let credited = 0;
  const agents = store.listAllAgents().filter(
    (a) => a.handle && a.custodyAddress && a.circleWalletId && a.custodyMode === "circle-eoa",
  );
  if (agents.length === 0) return { credited, errors };
  const { getPublicClient } = await import("./arc-wallet.js");
  const { scanInbound } = await import("./inbound.js");
  const { config } = await import("../config.js");
  const head = await getPublicClient().getBlockNumber();
  // Oldest-scanned first, a couple per pass: the public RPC has a quota.
  const order = [...agents].sort((a, b) => (a.incomeScannedBlock ?? 0) - (b.incomeScannedBlock ?? 0));
  for (const agent of order.slice(0, perPass)) {
    try {
      const from = agent.incomeScannedBlock != null
        ? BigInt(agent.incomeScannedBlock) + 1n
        : head > INCOME_LOOKBACK_BLOCKS ? head - INCOME_LOOKBACK_BLOCKS : 0n;
      if (from > head) continue;
      const found = await scanInbound({ address: agent.custodyAddress as Address, fromBlock: from, toBlock: head });
      const owner = store.getUser(agent.userId);
      const income = incomeTransfers(found, {
        owner: owner?.evmAddress,
        escrow: config.arc.paymentEscrow,
        self: agent.custodyAddress,
        used: (tx) => store.isFundTxUsed(tx) || (agent.incomeTxHashes ?? []).includes(tx.toLowerCase()),
      });
      const total = Number(income.reduce((n, t) => n + t.amount, 0).toFixed(6));
      if (total > 0 && total < INCOME_MIN_USDC) {
        // Leave the cursor so the next pass sees it again with whatever follows.
        continue;
      }
      if (total > 0) {
        await depositIncome(agent, total);
        agent.incomeTxHashes = [...(agent.incomeTxHashes ?? []), ...income.map((t) => t.txHash.toLowerCase())].slice(-500);
        for (const t of income) {
          const payer = store.listUsers().find((u) => u.evmAddress?.toLowerCase() === t.from.toLowerCase());
          const who = payer?.handle ? `@${payer.handle}` : `${t.from.slice(0, 6)}…${t.from.slice(-4)}`;
          store.addActivity({
            userId: agent.userId,
            kind: "agent",
            title: agent.label,
            description: `${who} paid @${agent.handle} ${t.amount} USDC`,
            amountUsdc: 0,
            token: "USDC",
            amountToken: t.amount,
            counterparty: who,
            txHash: t.txHash,
            mode: "agent_income",
            status: "completed",
          });
        }
        alertUser(agent.userId, {
          kind: "money_in",
          title: `@${agent.handle} was paid ${total} USDC`,
          body: `It is in ${agent.label}'s balance now.`,
          amountUsdc: total,
          token: "USDC",
          link: `evabob://agents/${agent.id}`,
        });
        credited += income.length;
      }
      agent.incomeScannedBlock = Number(head);
      store.save();
    } catch (e) {
      errors.push(`${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { credited, errors };
}

async function depositIncome(agent: AgentWallet, amountUsdc: number): Promise<void> {
  const { agentWalletBalance, depositAgentWalletToGateway } = await import("./agentWallet.js");
  const onChain = await agentWalletBalance(agent.circleWalletId!);
  const amount = Number(Math.min(amountUsdc, onChain - INCOME_GAS_RESERVE_USDC).toFixed(6));
  if (!(amount > 0)) throw new Error("Not enough in the agent's wallet to deposit its income yet");
  const { randomUUID } = await import("node:crypto");
  await depositAgentWalletToGateway({
    walletAddress: agent.custodyAddress as Address,
    amountUsdc: amount,
    approveIdempotencyKey: randomUUID(),
    depositIdempotencyKey: randomUUID(),
    async onApproveCreated() {},
    async onDepositCreated() {},
  });
  agent.balanceUsdc = Number((agent.balanceUsdc + amount).toFixed(6));
  store.save();
}
