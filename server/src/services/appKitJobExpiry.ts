/**
 * Decide whether an incomplete App Kit job (usually a bridge PIN) can be
 * dropped because the challenge expired and the source funds never left.
 */

export const CCTP_V2_TOKEN_MESSENGER =
  "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa";
export const CCTP_V1_TOKEN_MESSENGER =
  "0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5";

const BURN_CONTRACTS = new Set([
  CCTP_V2_TOKEN_MESSENGER,
  CCTP_V1_TOKEN_MESSENGER,
]);

export const BALANCE_DUST = 0.0001;
export const OPEN_CHALLENGE_GRACE_MS = 8 * 60 * 1000;
export const STALE_JOB_MS = 12 * 60 * 1000;

export type ChallengeExpiryState = {
  settled: boolean;
  dead: boolean;
};

export type ExpiredJobDecisionInput = {
  challenges: ChallengeExpiryState[];
  live: boolean;
  jobAgeMs: number;
  statusesKnown?: boolean;
  balanceBefore?: number | null;
  balanceNow?: number | null;
  amount?: number | null;
  settledLooksLikeBurn?: boolean;
};

export type ExpiredJobDecision = {
  abandon: boolean;
  fundsIntact: boolean;
  reason: string;
};

export function parseBalance(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function fundsIntactFromSnapshot(
  balanceBefore: number,
  balanceNow: number,
): boolean {
  return balanceNow + BALANCE_DUST >= balanceBefore - BALANCE_DUST;
}

export function isTokenMessengerAddress(addr?: string | null): boolean {
  if (!addr) return false;
  return BURN_CONTRACTS.has(addr.trim().toLowerCase());
}

function snapshotPair(
  before?: number | null,
  now?: number | null,
): { before: number; now: number } | null {
  if (
    typeof before === "number" &&
    Number.isFinite(before) &&
    typeof now === "number" &&
    Number.isFinite(now)
  ) {
    return { before, now };
  }
  return null;
}

export function classifyChallenge(input: {
  status?: string | null;
  txHash?: string | null;
  txState?: string | null;
  contractAddress?: string | null;
}): ChallengeExpiryState & { looksLikeBurn: boolean } {
  const status = (input.status || "PENDING").toUpperCase();
  const txState = (input.txState || "").toUpperCase();
  const hash = (input.txHash || "").trim();
  const hashOk = /^0x[a-fA-F0-9]{64}$/i.test(hash);
  const looksLikeBurn = isTokenMessengerAddress(input.contractAddress);

  if (status === "FAILED" || status === "EXPIRED") {
    return { settled: false, dead: true, looksLikeBurn };
  }
  if (txState === "FAILED" || txState === "DENIED" || txState === "CANCELLED") {
    return { settled: false, dead: true, looksLikeBurn };
  }
  if (status === "COMPLETE") {
    return { settled: true, dead: false, looksLikeBurn };
  }
  if (hashOk && (status === "PENDING" || status === "IN_PROGRESS" || txState === "SENT" || txState === "COMPLETE" || txState === "CONFIRMED")) {
    return { settled: true, dead: false, looksLikeBurn };
  }
  return { settled: false, dead: false, looksLikeBurn };
}

export function decideExpiredJobAbandon(
  input: ExpiredJobDecisionInput,
): ExpiredJobDecision {
  const snap = snapshotPair(input.balanceBefore, input.balanceNow);
  const fundsIntact = snap
    ? fundsIntactFromSnapshot(snap.before, snap.now)
    : false;
  const anySettled = input.challenges.some((c) => c.settled);
  const allDead =
    input.challenges.length > 0 && input.challenges.every((c) => c.dead);
  const anyOpen = input.challenges.some((c) => !c.settled && !c.dead);

  if (input.live && anyOpen && input.jobAgeMs < OPEN_CHALLENGE_GRACE_MS) {
    return { abandon: false, fundsIntact, reason: "open challenge within grace" };
  }
  if (anySettled && input.settledLooksLikeBurn) {
    return { abandon: false, fundsIntact, reason: "burn may have landed" };
  }
  if (anySettled && !fundsIntact) {
    return { abandon: false, fundsIntact, reason: "funds moved" };
  }

  if (snap && fundsIntact) {
    if (allDead || input.jobAgeMs >= STALE_JOB_MS) {
      return {
        abandon: true,
        fundsIntact: true,
        reason: "expired challenge; source balance unchanged",
      };
    }
    if (!anySettled && allDead) {
      return {
        abandon: true,
        fundsIntact: true,
        reason: "unsigned expired PIN; funds intact",
      };
    }
  }

  if (!snap && (input.statusesKnown !== false) && allDead && !anySettled) {
    return {
      abandon: true,
      fundsIntact: true,
      reason: "expired unsigned PIN; no evidence funds left",
    };
  }

  if (
    !snap &&
    (input.statusesKnown !== false) &&
    allDead &&
    anySettled &&
    !input.settledLooksLikeBurn
  ) {
    return {
      abandon: true,
      fundsIntact: true,
      reason: "approve-only then expired; funds likely intact",
    };
  }

  if (!input.live && input.jobAgeMs >= STALE_JOB_MS && snap && fundsIntact) {
    return {
      abandon: true,
      fundsIntact: true,
      reason: "stale job; source balance unchanged",
    };
  }

  return { abandon: false, fundsIntact, reason: "keep" };
}

/** Where a money job stands, in the words the app shows. */
export type JobStage = "waiting_pin" | "sent" | "confirming" | "arrived";

export type RunnerFailureInput = {
  op: string;
  /** Circle's attestation service already has a CCTP message for a job tx. */
  burnFound: boolean;
  /** At least one job transaction was broadcast. */
  anyTxHash: boolean;
  balanceBefore?: number | null;
  balanceNow?: number | null;
  amount?: number | null;
};

export type RunnerFailureDecision = {
  outcome: "failed" | "keep_running" | "succeeded";
  stage?: JobStage;
  reason: string;
};

/**
 * Money left the source wallet. Half the requested amount is the bar so a
 * protocol or platform fee never hides a real movement, while an incoming
 * payment landing at the same time cannot fake one.
 */
export function sourceFundsMoved(input: {
  balanceBefore?: number | null;
  balanceNow?: number | null;
  amount?: number | null;
}): boolean | null {
  const snap = snapshotPair(input.balanceBefore, input.balanceNow);
  if (!snap) return null;
  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount)
      ? input.amount
      : 0;
  return snap.before - snap.now >= Math.max(BALANCE_DUST, amount * 0.5);
}

/**
 * The App Kit runner threw — usually because a PIN was left unanswered.
 *
 * A job used to become "failed" here unconditionally, which removed its
 * Continue button even when the burn had already landed and the money was
 * sitting between chains. A job may only fail when nothing moved.
 *
 * - Bridge: once burned, it stays running so Continue can finish the mint.
 * - Single-transaction ops (send, deposit, swap): money leaving the source
 *   wallet means the one money-moving transaction landed, so it succeeded.
 * - Unknown (balance unreadable but a transaction was broadcast): keep it
 *   running so a later pass can decide. Never guess "failed" over money.
 */
export function decideRunnerFailure(
  input: RunnerFailureInput,
): RunnerFailureDecision {
  const moved = sourceFundsMoved(input);
  if (input.op === "bridge") {
    if (input.burnFound) {
      return { outcome: "keep_running", stage: "sent", reason: "burn landed; mint pending" };
    }
    if (moved === true) {
      return { outcome: "keep_running", stage: "sent", reason: "source balance dropped" };
    }
  } else if (moved === true) {
    return { outcome: "succeeded", stage: "arrived", reason: "source balance dropped" };
  }
  if (moved === null && input.anyTxHash) {
    return { outcome: "keep_running", stage: "sent", reason: "cannot verify; transaction broadcast" };
  }
  return { outcome: "failed", reason: "nothing moved" };
}

export function fundsIntactMessage(
  input?:
    | number
    | null
    | {
        op?: string;
        token?: string | null;
        balanceNow?: number | null;
      },
): string {
  const balanceNow =
    typeof input === "number" || input == null || typeof input === "undefined"
      ? input
      : input.balanceNow;
  const token =
    input && typeof input === "object"
      ? (input.token || "USDC").toString()
      : "USDC";
  if (typeof balanceNow === "number" && Number.isFinite(balanceNow)) {
    return `PIN expired. Your funds were not moved (${balanceNow.toFixed(2)} ${token} still on the source chain).`;
  }
  return "PIN expired. Your funds were not moved.";
}
