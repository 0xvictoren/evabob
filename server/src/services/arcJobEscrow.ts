/**
 * Arc job escrow — Circle Developer Controlled Wallets + ERC-8183-style jobs.
 *
 * Ports the arc-escrow sample lifecycle:
 *   create+fund → submit deliverable → complete | reject
 *
 * On-chain target (Arc Testnet Refund Protocol / ERC-8183 reference):
 *   0x0747EEf0706327138c69792bF28Cd525089e4583
 *
 * Phase 1: server ledger + optional agent wallet lock (same as agentEscrow).
 * Ready for contract writes when AGENT_ESCROW_ADDRESS / PAYMENT_ESCROW is set.
 *
 * Ref: https://github.com/circlefin/arc-escrow
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dirname } from "node:path";
import { config } from "../config.js";
import { dataPath } from "../utils/data-path.js";
import { store } from "../store/db.js";

export type ArcJobStatus =
  | "open"
  | "funded"
  | "submitted"
  | "completed"
  | "rejected"
  | "expired";

export type ArcJob = {
  id: string;
  userId: string;
  /** Payer */
  client: string;
  /** Payee handle / address / user id */
  recipient: string;
  evaluator: string;
  description: string;
  amountUsdc: number;
  lockedUsdc: number;
  status: ArcJobStatus;
  requireAiValidation: boolean;
  deliverableHash?: string;
  deliverableSummary?: string;
  rejectReason?: string;
  requestId?: string;
  createdAt: string;
  fundedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  rejectedAt?: string;
  /** Live Arc Testnet reference contract */
  contractAddress: string;
  onChainJobId?: string;
  /** Address that holds locked USDC (platform DC wallet). */
  holdAddress?: string;
  /** Payer UCW → hold transfer (client-confirmed). */
  fundTxHash?: string;
  fundActivityId?: string;
  /** Hold → payee (or refund → payer) on complete/reject. */
  releaseTxHash?: string;
  /** Payer EVM address for refunds. */
  payerAddress?: string;
  /**
   * After this ISO time, unreleased jobs refund to the payer.
   * Funds are never sent to the payee on expiry.
   */
  expiresAt?: string;
  /** Who received the hold on unwind: payee (release) or payer (refund). */
  releasedTo?: "payee" | "payer";
  invoiceId?: string;
  threadId?: string;
};

const DATA_PATH = dataPath("arc-job-escrow.json");

/** ERC-8183 reference on Arc Testnet (from Circle sample). */
export const ARC_ESCROW_REF =
  process.env.AGENT_ESCROW_ADDRESS ||
  process.env.ARC_JOB_ESCROW ||
  "0x0747EEf0706327138c69792bF28Cd525089e4583";

function load(): ArcJob[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8")) as ArcJob[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(jobs: ArcJob[]) {
  writeJsonAtomic(DATA_PATH, jobs.slice(0, 500));
}

function persist(job: ArcJob): ArcJob {
  const jobs = load();
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.unshift(job);
  save(jobs);
  return job;
}

/** Platform address that holds chat escrow USDC until release/refund. */
export function escrowHoldAddress(): `0x${string}` {
  const fromEnv =
    process.env.ESCROW_HOLD_ADDRESS?.trim() ||
    process.env.APP_KIT_DC_WALLET?.trim() ||
    process.env.CIRCLE_DC_WALLET?.trim() ||
    config.appKit.dcWalletAddress;
  if (!fromEnv || !fromEnv.startsWith("0x") || fromEnv.length !== 42) {
    throw new Error(
      "Escrow hold address not configured (APP_KIT_DC_WALLET / ESCROW_HOLD_ADDRESS)",
    );
  }
  return fromEnv as `0x${string}`;
}

function norm(id: string): string {
  return id.trim().replace(/^@/, "").toLowerCase();
}

export function isJobPayer(job: ArcJob, userId: string): boolean {
  const uid = norm(userId);
  return (
    norm(job.client) === uid ||
    norm(job.userId) === uid ||
    norm(job.evaluator) === uid
  );
}

export function isJobRecipient(job: ArcJob, userId: string): boolean {
  const user = store.getUser(userId);
  const recipient = norm(job.recipient);
  if (!recipient) return false;
  return [userId, user?.handle, user?.email, user?.evmAddress]
    .filter((value): value is string => Boolean(value))
    .map(norm)
    .includes(recipient);
}

/**
 * Hard rule: only the payer may release or refund locked funds.
 * Recipients can mark delivered; they cannot move the money.
 */
export function assertPayerCanRelease(job: ArcJob, userId?: string): void {
  if (!userId) {
    throw new Error("Payer identity required to release or refund escrow");
  }
  if (isJobRecipient(job, userId) && !isJobPayer(job, userId)) {
    throw new Error(
      "Only the payer can release escrow. Funds stay locked until they confirm the job is done.",
    );
  }
  if (!isJobPayer(job, userId)) {
    throw new Error(
      "Only the payer can release escrow. Funds stay locked until they confirm the job is done.",
    );
  }
}

export function createAndFundJob(input: {
  userId: string;
  amountUsdc: number;
  description: string;
  recipient: string;
  requireAiValidation?: boolean;
  requestId?: string;
  invoiceId?: string;
  threadId?: string;
  /** Required for real lock: tx hash of payer → hold transfer. */
  fundTxHash?: string;
  fundActivityId?: string;
  payerAddress?: string;
  /** When true, allow ledger-only (dev / demos without on-chain fund). */
  allowLedgerOnly?: boolean;
  expiresInMs?: number;
}): ArcJob {
  if (!(input.amountUsdc > 0)) throw new Error("amountUsdc must be positive");
  const hold = escrowHoldAddress();
  if (!input.fundTxHash && !input.fundActivityId && !input.allowLedgerOnly) {
    throw new Error(
      "Escrow fund requires on-chain transfer to hold address (fundTxHash or fundActivityId). " +
        `Send ${input.amountUsdc} USDC to ${hold}, then create the job.`,
    );
  }
  const now = new Date().toISOString();
  const job: ArcJob = {
    id: randomUUID(),
    userId: input.userId,
    client: input.userId,
    recipient: input.recipient,
    evaluator: input.userId,
    description: input.description || "Escrow job",
    amountUsdc: input.amountUsdc,
    lockedUsdc: input.amountUsdc,
    status: "funded",
    requireAiValidation: Boolean(input.requireAiValidation),
    requestId: input.requestId,
    invoiceId: input.invoiceId || input.requestId,
    threadId: input.threadId,
    createdAt: now,
    fundedAt: now,
    expiresAt: new Date(
      Date.now() + (input.expiresInMs ?? 7 * 24 * 60 * 60 * 1000),
    ).toISOString(),
    contractAddress: config.arc.paymentEscrow || ARC_ESCROW_REF,
    holdAddress: hold,
    fundTxHash: input.fundTxHash,
    fundActivityId: input.fundActivityId,
    payerAddress: input.payerAddress,
  };
  return persist(job);
}

export function getJob(id: string): ArcJob | undefined {
  return load().find((j) => j.id === id);
}

export function listJobsForUser(userId: string): ArcJob[] {
  return load().filter(
    (j) => j.userId === userId || j.client === userId || j.recipient === userId,
  );
}

export function submitDeliverable(
  id: string,
  input: {
    summary?: string;
    deliverable?: unknown;
    deliverableUri?: string;
    userId?: string;
  },
): ArcJob {
  const job = getJob(id);
  if (!job) throw new Error("job not found");
  if (job.status !== "funded") {
    throw new Error(`Cannot submit in status ${job.status}`);
  }
  if (!input.userId || !isJobRecipient(job, input.userId)) {
    throw new Error("Only the recipient can mark delivered");
  }
  const payload =
    input.deliverableUri ||
    (typeof input.deliverable === "string"
      ? input.deliverable
      : JSON.stringify(input.deliverable ?? input.summary ?? ""));
  const hash = createHash("sha256").update(payload).digest("hex");
  job.deliverableHash = `0x${hash}`;
  job.deliverableSummary = input.summary || payload.slice(0, 200);
  job.status = "submitted";
  job.submittedAt = new Date().toISOString();
  return persist(job);
}

export function completeJob(
  id: string,
  userId?: string,
  opts?: { releaseTxHash?: string },
): ArcJob {
  const job = getJob(id);
  if (!job) throw new Error("job not found");
  // If the job is not done (from the payer's point of view), money stays locked.
  if (job.status === "completed") {
    throw new Error("Escrow already released");
  }
  if (job.status === "rejected" || job.status === "expired") {
    throw new Error(
      `Cannot release: job is ${job.status}. Funds were refunded to the payer.`,
    );
  }
  if (job.status !== "funded" && job.status !== "submitted") {
    throw new Error(`Cannot complete in status ${job.status}`);
  }
  // PAYER ONLY — recipient "delivered" never moves USDC.
  assertPayerCanRelease(job, userId);
  job.status = "completed";
  job.lockedUsdc = 0;
  job.completedAt = new Date().toISOString();
  job.releasedTo = "payee";
  if (opts?.releaseTxHash) job.releaseTxHash = opts.releaseTxHash;
  return persist(job);
}

export function rejectJob(
  id: string,
  input?: { reason?: string; userId?: string; releaseTxHash?: string },
): ArcJob {
  const job = getJob(id);
  if (!job) throw new Error("job not found");
  if (job.status === "completed") {
    throw new Error("Escrow already released to the payee — cannot refund");
  }
  if (job.status === "rejected" || job.status === "expired") {
    throw new Error(`Job already ${job.status}`);
  }
  if (job.status !== "funded" && job.status !== "submitted") {
    throw new Error(`Cannot reject in status ${job.status}`);
  }
  if (input?.userId) assertPayerCanRelease(job, input.userId);
  job.status = "rejected";
  job.lockedUsdc = 0;
  job.rejectReason = input?.reason;
  job.rejectedAt = new Date().toISOString();
  job.releasedTo = "payer";
  if (input?.releaseTxHash) job.releaseTxHash = input.releaseTxHash;
  return persist(job);
}

/** System expiry: refund payer, never pay the recipient. */
export function expireJob(
  id: string,
  opts?: { releaseTxHash?: string },
): ArcJob {
  const job = getJob(id);
  if (!job) throw new Error("job not found");
  if (job.status === "completed") {
    throw new Error("Escrow already released — cannot expire");
  }
  if (job.status === "rejected" || job.status === "expired") return job;
  if (job.status !== "funded" && job.status !== "submitted") {
    throw new Error(`Cannot expire in status ${job.status}`);
  }
  job.status = "expired";
  job.lockedUsdc = 0;
  job.rejectReason = job.rejectReason || "expired";
  job.rejectedAt = new Date().toISOString();
  job.releasedTo = "payer";
  if (opts?.releaseTxHash) job.releaseTxHash = opts.releaseTxHash;
  return persist(job);
}

export function listFundedJobs(): ArcJob[] {
  return load().filter((j) => j.status === "funded" || j.status === "submitted");
}
