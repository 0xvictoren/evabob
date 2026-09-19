/**
 * The owner's side of an agent allowance: approvals, pausing, one-tap freeze,
 * the loop breaker's trip, and the live meter.
 *
 * The rules live in agentAllowance.ts and are pure; this file applies them to
 * stored agents and tells the owner — a push for anything they must act on
 * (an approval, a pause), and a silent live update for the meter.
 */

import { randomBytes } from "node:crypto";
import { store, type AgentWallet } from "../store/db.js";
import {
  APPROVAL_TTL_MS,
  CATEGORY_LABEL,
  allowanceOf,
  describeAllowance,
  forgetCalls,
  meterFor,
  normalizeCategory,
  type Meter,
} from "./agentAllowance.js";
import { alertUser, USER_CHANNEL_PREFIX } from "./notifyUser.js";

export type Approval = NonNullable<AgentWallet["approvals"]>[number];

function money(n: number): string {
  return `$${n < 1 ? n.toFixed(n < 0.01 ? 4 : 2) : n.toFixed(2)}`;
}

/**
 * The live meter. Fees set aside for people the agent hired are in its
 * payment history too (as `task:` rows), so they count like any payment.
 */
export function liveMeter(agent: AgentWallet, now = Date.now()): Meter {
  return meterFor(agent, now);
}

export function isPaused(agent: AgentWallet): boolean {
  return Boolean(agent.pausedAt);
}

/**
 * Pushes the agent's current state to the owner's open app, without a
 * notification: this is what keeps the meter live while they watch it.
 */
export function pushAgentUpdate(agent: AgentWallet): void {
  void import("./pusher.js").then(({ pusherTrigger }) =>
    // On the alert event with no body: the app's event stream sees it, and a
    // notification is never shown for it.
    pusherTrigger(`${USER_CHANNEL_PREFIX}${agent.userId}`, "alert", {
      kind: "agent_update",
      title: "",
      body: "",
      agentId: agent.id,
      meter: liveMeter(agent),
      pausedAt: agent.pausedAt ?? null,
      pauseReason: agent.pauseReason ?? null,
      balanceUsdc: agent.balanceUsdc,
      pendingApprovals: pendingApprovals(agent).length,
    }),
  ).catch(() => {
    /* a missed live update costs a refresh, nothing more */
  });
}

// ─── Pausing ─────────────────────────────────────────────────────────────

export function pauseAgent(
  agent: AgentWallet,
  reason: "owner" | "loop" | "freeze",
  detail?: string,
): AgentWallet {
  if (agent.pausedAt && agent.pauseReason !== "freeze" && reason === "freeze") {
    // Already paused for its own reason; a freeze must not later be undone
    // into un-pausing something the owner or the breaker stopped.
    return agent;
  }
  agent.pausedAt = new Date().toISOString();
  agent.pauseReason = reason;
  agent.pauseDetail = detail ?? null;
  // Nothing waiting on the owner should go through while it is stopped.
  for (const a of agent.approvals ?? []) {
    if (a.status === "pending") {
      a.status = "declined";
      a.decidedAt = agent.pausedAt;
    }
  }
  store.save();
  pushAgentUpdate(agent);
  return agent;
}

export function resumeAgent(agent: AgentWallet): AgentWallet {
  agent.pausedAt = null;
  agent.pauseReason = null;
  agent.pauseDetail = null;
  forgetCalls(agent.id);
  store.save();
  pushAgentUpdate(agent);
  return agent;
}

/** One tap: every agent this person owns stops spending at once. */
export function freezeAll(userId: string): number {
  let n = 0;
  for (const agent of store.listAgents(userId)) {
    if (agent.pausedAt) continue;
    pauseAgent(agent, "freeze", "Everything frozen by the owner");
    n += 1;
  }
  return n;
}

/** Undoes a freeze. Agents paused for their own reasons stay paused. */
export function unfreezeAll(userId: string): number {
  let n = 0;
  for (const agent of store.listAgents(userId)) {
    if (agent.pauseReason !== "freeze") continue;
    resumeAgent(agent);
    n += 1;
  }
  return n;
}

/** The loop breaker tripped: stop the agent and tell the owner why. */
export function tripLoopBreaker(agent: AgentWallet, endpoint: string, count: number): void {
  let host = endpoint;
  try {
    const u = new URL(endpoint);
    host = `${u.host}${u.pathname}`;
  } catch {
    /* keep as is */
  }
  const detail = `Called ${host} ${count} times in a minute`;
  pauseAgent(agent, "loop", detail);
  alertUser(agent.userId, {
    kind: "agent_paused",
    title: `${agent.label} paused`,
    body: `${detail}. That is how runaway bills start, so it is stopped until you resume it.`,
    link: `evabob://agents/${agent.id}`,
  });
}

// ─── Approvals ───────────────────────────────────────────────────────────

export function pendingApprovals(agent: AgentWallet, now = Date.now()): Approval[] {
  return (agent.approvals ?? []).filter(
    (a) => a.status === "pending" && Date.parse(a.expiresAt) > now,
  );
}

/** The owner's answer for exactly this payment, if there is one. */
export function findApproval(agent: AgentWallet, key: string, now = Date.now()): Approval | null {
  const a = (agent.approvals ?? []).find((x) => x.key === key);
  if (!a) return null;
  if (a.status === "pending" && Date.parse(a.expiresAt) <= now) {
    a.status = "expired";
    store.save();
  }
  return a;
}

/**
 * Asks the owner. One request per payment key: a retry while they are still
 * deciding returns the same request instead of pushing them again.
 */
export function requestApproval(
  agent: AgentWallet,
  input: { key: string; url: string; seller: string; category: string; amountUsdc: number },
  now = Date.now(),
): Approval {
  const existing = findApproval(agent, input.key, now);
  if (existing && existing.status === "pending") return existing;
  const approval: Approval = {
    id: `apv_${randomBytes(9).toString("hex")}`,
    key: input.key,
    url: input.url,
    seller: input.seller,
    category: input.category,
    amountUsdc: input.amountUsdc,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
  // Keep the list short; old answers are in the payment history anyway.
  agent.approvals = [...(agent.approvals ?? []).filter((a) => a.key !== input.key), approval].slice(-50);
  store.save();
  const a = allowanceOf(agent);
  const label = CATEGORY_LABEL[normalizeCategory(input.category)];
  alertUser(agent.userId, {
    kind: "agent_approval",
    title: `${agent.label} wants to spend ${money(input.amountUsdc)}`,
    body: `On ${input.seller} (${label}). That is above your ${money(a.askAboveUsdc)} limit. Approve or decline.`,
    amountUsdc: input.amountUsdc,
    token: "USDC",
    link: `evabob://agents/${agent.id}/approvals/${approval.id}`,
  });
  pushAgentUpdate(agent);
  return approval;
}

export class ApprovalError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
  }
}

type ApprovalListener = (agent: AgentWallet, approval: Approval) => void;
const approvalListeners: ApprovalListener[] = [];

/** agentTasks.ts continues a task the owner just approved. */
export function onApprovalDecided(fn: ApprovalListener): void {
  approvalListeners.push(fn);
}

export function decideApproval(
  agent: AgentWallet,
  approvalId: string,
  approve: boolean,
  now = Date.now(),
): Approval {
  const a = (agent.approvals ?? []).find((x) => x.id === approvalId);
  if (!a) throw new ApprovalError("No such request", 404);
  if (a.status === "pending" && Date.parse(a.expiresAt) <= now) a.status = "expired";
  if (a.status !== "pending") {
    store.save();
    throw new ApprovalError(
      a.status === "expired" ? "That request has expired. The agent can ask again." : "That request has already been answered.",
    );
  }
  if (approve && agent.pausedAt) {
    throw new ApprovalError("Resume this agent first; it cannot spend while paused.");
  }
  a.status = approve ? "approved" : "declined";
  a.decidedAt = new Date(now).toISOString();
  store.save();
  pushAgentUpdate(agent);
  for (const fn of approvalListeners) {
    try {
      fn(agent, a);
    } catch (e) {
      console.warn("[agent-approval] listener failed", e instanceof Error ? e.message : e);
    }
  }
  return a;
}

/** The owner's view of an agent's allowance, meter and state. */
export function allowanceView(agent: AgentWallet, now = Date.now()) {
  const a = allowanceOf(agent);
  return {
    allowance: { ...a, summary: describeAllowance(a), custom: Boolean(agent.allowance) },
    meter: liveMeter(agent, now),
    paused: Boolean(agent.pausedAt),
    pausedAt: agent.pausedAt ?? null,
    pauseReason: agent.pauseReason ?? null,
    pauseDetail: agent.pauseDetail ?? null,
    approvals: pendingApprovals(agent, now),
  };
}
