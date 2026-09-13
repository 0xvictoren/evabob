/**
 * Hybrid Escrow (Phase 1) — ERC-8183–style agent jobs on a server ledger.
 *
 * Lifecycle:
 *   Open → Funded → Submitted → Completed
 *                 ↘ Rejected
 *        ↘ Expired (deadline passed while open/funded/submitted)
 *
 * Funding locks USDC on the agent wallet ledger (caller debits balance).
 * Approve releases the lock (budget already spent at fund — agent “earned” it).
 * Reject / expire refunds locked USDC to the agent ledger.
 *
 * Ready for full on-chain ERC-8183 later:
 *   set AGENT_ESCROW_ADDRESS + ABI, swap fund/approve to writeContract.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8183
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dirname } from "node:path";
import { dataPath } from "../utils/data-path.js";

export type AgentJobStatus =
  | "open"
  | "funded"
  | "submitted"
  | "completed"
  | "rejected"
  | "expired";

export type AgentJob = {
  id: string;
  /** Provider agent wallet id */
  agentId: string;
  /** Client (payer / job creator) Evabob user id */
  userId: string;
  client: string;
  provider: string;
  /** Who can approve/reject — defaults to client */
  evaluator: string;
  description: string;
  budgetUsdc: number;
  /** Amount currently locked in escrow (0 after complete/refund) */
  lockedUsdc: number;
  status: AgentJobStatus;
  deadline?: string;
  deliverableHash?: string;
  deliverableSummary?: string;
  deliverableUri?: string;
  rejectReason?: string;
  createdAt: string;
  fundedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  rejectedAt?: string;
  refundedAt?: string;
  expiredAt?: string;
  /** Reserved for on-chain job id */
  onChainJobId?: string;
  createTx?: string;
  fundTx?: string;
  completeTx?: string;
};

const DATA_PATH = dataPath("agent-jobs.json");

function loadJobs(): AgentJob[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8")) as AgentJob[];
    if (!Array.isArray(raw)) return [];
    // Migrate older rows missing Phase-1 fields
    return raw.map((j) => ({
      ...j,
      client: j.client || j.userId,
      provider: j.provider || j.agentId,
      evaluator: j.evaluator || j.userId,
      lockedUsdc:
        typeof j.lockedUsdc === "number"
          ? j.lockedUsdc
          : j.status === "funded" || j.status === "submitted"
            ? j.budgetUsdc
            : 0,
    }));
  } catch {
    return [];
  }
}

function saveJobs(jobs: AgentJob[]) {
  writeJsonAtomic(DATA_PATH, jobs);
}

function persist(job: AgentJob): AgentJob {
  const jobs = loadJobs();
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  saveJobs(jobs.slice(0, 500));
  return job;
}

export function hashDeliverable(payload: unknown): string {
  const body =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return `0x${createHash("sha256").update(body).digest("hex")}`;
}

function isPastDeadline(job: AgentJob, now = new Date()): boolean {
  if (!job.deadline) return false;
  const d = Date.parse(job.deadline);
  return Number.isFinite(d) && d <= now.getTime();
}

/**
 * Mark open/funded/submitted jobs past deadline as expired.
 * Returns jobs that transitioned (caller should refund lockedUsdc).
 */
export function expireOverdueJobs(filter?: {
  agentId?: string;
  userId?: string;
}): AgentJob[] {
  const jobs = loadJobs();
  const expired: AgentJob[] = [];
  const now = new Date();
  for (const job of jobs) {
    if (filter?.agentId && job.agentId !== filter.agentId) continue;
    if (filter?.userId && job.userId !== filter.userId) continue;
    if (
      (job.status === "open" ||
        job.status === "funded" ||
        job.status === "submitted") &&
      isPastDeadline(job, now)
    ) {
      job.status = "expired";
      job.expiredAt = now.toISOString();
      job.refundedAt = now.toISOString();
      expired.push({ ...job });
      // lockedUsdc stays until caller refunds, then zeroed below
    }
  }
  if (expired.length) saveJobs(jobs);
  return expired;
}

/** Create an open job (not funded yet). */
export function createJob(input: {
  agentId: string;
  userId: string;
  description: string;
  budgetUsdc: number;
  /** ISO deadline; default +24h */
  deadline?: string;
  evaluator?: string;
  client?: string;
  provider?: string;
}): AgentJob {
  const deadline =
    input.deadline ||
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const job: AgentJob = {
    id: randomUUID(),
    agentId: input.agentId,
    userId: input.userId,
    client: input.client || input.userId,
    provider: input.provider || input.agentId,
    evaluator: input.evaluator || input.userId,
    description: input.description.slice(0, 500),
    budgetUsdc: Number(input.budgetUsdc.toFixed(6)),
    lockedUsdc: 0,
    status: "open",
    deadline,
    createdAt: new Date().toISOString(),
  };
  const jobs = loadJobs();
  jobs.unshift(job);
  saveJobs(jobs.slice(0, 500));
  return job;
}

/**
 * Lock budget on the agent ledger (caller debits agent.balanceUsdc).
 */
export function fundJob(jobId: string): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  if (job.status === "expired" || isPastDeadline(job)) {
    job.status = "expired";
    job.expiredAt = new Date().toISOString();
    saveJobs(jobs);
    throw new Error("job expired — cannot fund");
  }
  if (job.status !== "open") throw new Error(`cannot fund job in ${job.status}`);
  job.status = "funded";
  job.lockedUsdc = job.budgetUsdc;
  job.fundedAt = new Date().toISOString();
  saveJobs(jobs);
  return job;
}

export function submitDeliverable(
  jobId: string,
  deliverable: unknown,
  summary?: string,
  deliverableUri?: string,
): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  if (job.status === "expired" || isPastDeadline(job)) {
    job.status = "expired";
    job.expiredAt = new Date().toISOString();
    saveJobs(jobs);
    throw new Error("job expired — cannot submit");
  }
  if (job.status !== "funded") {
    throw new Error(`cannot submit deliverable in ${job.status}`);
  }
  job.status = "submitted";
  job.deliverableHash = hashDeliverable(deliverable);
  job.deliverableSummary = (summary || "").slice(0, 2000);
  if (deliverableUri) job.deliverableUri = deliverableUri.slice(0, 500);
  job.submittedAt = new Date().toISOString();
  saveJobs(jobs);
  return job;
}

/**
 * Evaluator approves: release payment (budget was locked at fund;
 * lockedUsdc cleared — agent keeps the spend as earnings).
 */
export function approveJob(jobId: string, evaluatorId?: string): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  if (evaluatorId && job.evaluator !== evaluatorId && job.userId !== evaluatorId) {
    throw new Error("not the evaluator for this job");
  }
  if (job.status !== "submitted" && job.status !== "funded") {
    throw new Error(`cannot approve job in ${job.status}`);
  }
  job.status = "completed";
  job.lockedUsdc = 0;
  job.completedAt = new Date().toISOString();
  saveJobs(jobs);
  return job;
}

/** @deprecated use approveJob */
export function completeJob(jobId: string): AgentJob {
  return approveJob(jobId);
}

/**
 * Evaluator rejects: unlock budget for refund to agent ledger.
 * Returns job with lockedUsdc still set until caller refunds then clearLock.
 */
export function rejectJob(
  jobId: string,
  reason?: string,
  evaluatorId?: string,
): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  if (evaluatorId && job.evaluator !== evaluatorId && job.userId !== evaluatorId) {
    throw new Error("not the evaluator for this job");
  }
  if (
    job.status !== "open" &&
    job.status !== "funded" &&
    job.status !== "submitted"
  ) {
    throw new Error(`cannot reject job in ${job.status}`);
  }
  const refundAmount = job.lockedUsdc || (job.status === "open" ? 0 : job.budgetUsdc);
  job.status = "rejected";
  job.rejectReason = (reason || "rejected").slice(0, 500);
  job.rejectedAt = new Date().toISOString();
  job.refundedAt = new Date().toISOString();
  job.lockedUsdc = refundAmount; // caller refunds this, then we zero
  saveJobs(jobs);
  return job;
}

/** Refund path for reject/expire — zero lock after caller credits agent. */
export function clearLock(jobId: string): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  job.lockedUsdc = 0;
  saveJobs(jobs);
  return job;
}

/** Refund locked budget to agent ledger (caller credits agent.balanceUsdc). */
export function refundJob(jobId: string): AgentJob {
  const jobs = loadJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job not found");
  if (job.status === "completed") {
    throw new Error(`cannot refund job in ${job.status}`);
  }
  if (job.status !== "rejected" && job.status !== "expired") {
    // force reject-style refund for open/funded/submitted
    if (job.status === "open" || job.status === "funded" || job.status === "submitted") {
      const refundAmount =
        job.lockedUsdc || (job.status === "open" ? 0 : job.budgetUsdc);
      job.status = "rejected";
      job.rejectReason = job.rejectReason || "refunded";
      job.rejectedAt = new Date().toISOString();
      job.lockedUsdc = refundAmount;
    }
  }
  job.refundedAt = new Date().toISOString();
  // Caller should credit lockedUsdc; we clear it here after acknowledging refund
  const amount = job.lockedUsdc;
  job.lockedUsdc = 0;
  saveJobs(jobs);
  return { ...job, lockedUsdc: amount }; // return amount that was locked for refund
}

export function getJob(jobId: string): AgentJob | undefined {
  return loadJobs().find((j) => j.id === jobId);
}

export function listJobsForAgent(agentId: string, userId: string): AgentJob[] {
  expireOverdueJobs({ agentId, userId });
  return loadJobs().filter(
    (j) => j.agentId === agentId && j.userId === userId,
  );
}

export function listJobsForUser(userId: string): AgentJob[] {
  expireOverdueJobs({ userId });
  return loadJobs().filter((j) => j.userId === userId || j.evaluator === userId);
}

/**
 * Full happy-path: create → fund (debit) → submit → complete.
 */
export function runEscrowJob(input: {
  agentId: string;
  userId: string;
  description: string;
  budgetUsdc: number;
  debit: (amount: number) => void;
  deliverable: unknown;
  summary?: string;
  autoComplete?: boolean;
  deadline?: string;
}): { job: AgentJob; steps: string[] } {
  const steps: string[] = [];
  const job = createJob({
    agentId: input.agentId,
    userId: input.userId,
    description: input.description,
    budgetUsdc: input.budgetUsdc,
    deadline: input.deadline,
  });
  steps.push("created");

  input.debit(input.budgetUsdc);
  fundJob(job.id);
  steps.push("funded");

  const submitted = submitDeliverable(
    job.id,
    input.deliverable,
    input.summary,
  );
  steps.push("submitted");

  if (input.autoComplete !== false) {
    approveJob(job.id);
    steps.push("completed");
  }

  return { job: getJob(job.id) ?? submitted, steps };
}
