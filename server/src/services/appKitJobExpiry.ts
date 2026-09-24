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

// ─── What counts as "on hold" ─────────────────────────────────────────────

/** Evidence on a job that the person entered a PIN and something was signed. */
export function pinWasEntered(meta?: {
  firstPinAt?: string;
  txHash?: string;
  lastTxHash?: string;
  txHashes?: string[];
  burnTxHash?: string;
  burnAt?: string;
} | null): boolean {
  if (!meta) return false;
  return Boolean(
    meta.firstPinAt ||
      meta.txHash ||
      meta.lastTxHash ||
      meta.burnTxHash ||
      meta.burnAt ||
      (meta.txHashes && meta.txHashes.length > 0),
  );
}

/**
 * Whether an unfinished job is shown to the person as held.
 *
 * The product rule: nothing is held unless money could be in motion. A swap,
 * or a bridge whose first PIN was never entered, moved nothing — it is
 * dropped, not held. While its PIN screen may still be open it is only kept
 * out of sight; once that window has passed it is discarded.
 */
export function heldJobDecision(input: {
  pinEntered: boolean;
  live: boolean;
  jobAgeMs: number;
  graceMs?: number;
}): "show" | "hide" | "discard" {
  if (input.pinEntered) return "show";
  const grace = input.graceMs ?? OPEN_CHALLENGE_GRACE_MS;
  if (input.live && input.jobAgeMs < grace) return "hide";
  return "discard";
}

/** What the app says, if anything, about a job dropped for lack of a PIN. */
export const NO_PIN_MESSAGE = "No PIN was entered, so nothing moved.";

// ─── Abandoned bridges ────────────────────────────────────────────────────

/**
 * How long a person has to finish a burned bridge themselves before the
 * server finishes it for them. Set by the product owner (40 minutes); the
 * environment may lengthen or shorten it for testing.
 */
export function bridgeAbandonWindowMs(
  env: string | undefined = process.env.BRIDGE_ABANDON_WINDOW_MINUTES,
): number {
  const minutes = Number(env);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 40) * 60 * 1000;
}

/**
 * Whether the server should finish a burned bridge now.
 *
 * Timed from the burn itself when its block time is known. Otherwise from
 * when the job was created, which is never later than the burn — so a missing
 * timestamp can only make the server step in sooner, never leave money
 * waiting longer than the window.
 */
export function abandonedBridgeDue(input: {
  burnAtMs: number | null;
  /**
   * When the person entered the first PIN, recorded by the server the
   * moment it heard. The product rule counts 40 minutes from here; the
   * earlier of this and the burn wins, so neither a late report nor a
   * server that was asleep can stretch the wait.
   */
  firstPinAtMs?: number | null;
  jobCreatedAtMs: number;
  nowMs: number;
  windowMs: number;
}): boolean {
  const marks = [input.burnAtMs, input.firstPinAtMs].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const start = marks.length ? Math.min(...marks) : input.jobCreatedAtMs;
  if (!Number.isFinite(start)) return false;
  return input.nowMs - start >= input.windowMs;
}

/** What finishing a bridge cost the platform, and what it would charge. */
export type BridgeRelayRecord = {
  gasCostWei: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** The rule is twice the gas spent, to the platform fee wallet. */
  multiplier: 2;
  wouldChargeWei: string;
  /**
   * Nothing is collected yet. The product owner chose not to charge on
   * testnet, and how to collect from a wallet that needs its owner's PIN is
   * still to be decided before real money.
   */
  charged: false;
  reason: "waived_on_testnet" | "collection_not_decided";
};

export function bridgeRelayRecord(input: {
  gasCostWei: string | bigint;
  nativeSymbol: string;
  nativeDecimals: number;
  deploymentEnv: string;
}): BridgeRelayRecord {
  const gas = BigInt(input.gasCostWei);
  return {
    gasCostWei: gas.toString(),
    nativeSymbol: input.nativeSymbol,
    nativeDecimals: input.nativeDecimals,
    multiplier: 2,
    wouldChargeWei: (gas * 2n).toString(),
    charged: false,
    reason:
      input.deploymentEnv === "production"
        ? "collection_not_decided"
        : "waived_on_testnet",
  };
}

/**
 * What arrives on the other network, in USDC, after Circle's Fast Transfer
 * fee. Bridges run at Fast speed, where CCTP takes a few basis points from the
 * amount itself (the Evabob fee is added on top and never touches it). The
 * fee is rounded up to the sixth decimal so the figure shown is never more
 * than what lands.
 */
export function landedAfterFastFee(amount: number, feeBps: number): { fee: number; landed: number } {
  if (!Number.isFinite(amount) || amount <= 0) return { fee: 0, landed: 0 };
  const bps = Number.isFinite(feeBps) && feeBps > 0 ? feeBps : 0;
  const units = Math.round(amount * 1e6);
  const feeUnits = Math.ceil((units * bps) / 10_000);
  return { fee: feeUnits / 1e6, landed: Math.max(0, units - feeUnits) / 1e6 };
}
