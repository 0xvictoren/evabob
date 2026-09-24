/**
 * High-level money movement via Circle App Kit.
 *
 * - Ops / agent / treasury: developer-controlled Circle Wallets or viem PRIVATE_KEY
 * - End-user UCW: createCircleUserWalletAdapter + onChallenge job relay
 * - Compose: Unified Balance spend → Swap → Bridge in one flow
 */

import { createCircleUserWalletAdapter } from "@circle-fin/adapter-circle-wallets";
import { createTokenRegistry } from "@circle-fin/adapter-viem-v2/next";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dirname } from "node:path";
import { config } from "../config.js";
import { dataPath } from "../utils/data-path.js";
import { store } from "../store/db.js";
import {
  type AdapterMode,
  type AppKitChain,
  appKitConfigured,
  buildBridgeFee,
  buildCustomFee,
  buildSwapFeeConfig,
  getAppKit,
  pickAdapter,
  resolveAppKitChain,
  resolveDcWalletAddress,
  serializeAppKitResult,
  withPatientConfirmations,
} from "./appKit.js";
import { readChainTokenBalance } from "./arc-balances.js";
import {
  flushPrimaryStore,
  markPrimaryStoreDirty,
  registerPrimaryStoreReloader,
} from "./primary-store.js";
import {
  abandonedBridgeDue,
  bridgeAbandonWindowMs,
  bridgeRelayRecord,
  decideExpiredJobAbandon,
  decideRunnerFailure,
  fundsIntactFromSnapshot,
  fundsIntactMessage,
  heldJobDecision,
  isTokenMessengerAddress,
  NO_PIN_MESSAGE,
  pinWasEntered,
  landedAfterFastFee,
  parseBalance,
  sourceFundsMoved,
  type BridgeRelayRecord,
  type ChallengeExpiryState,
  type JobStage,
} from "./appKitJobExpiry.js";
import {
  assertMintRecipient,
  hopNote,
  parseBridgeAmount,
  planBridgeHop,
} from "./appKitBridgeRoute.js";
import { circleAppId, readChallengeSettlement } from "./circle-ucw.js";
import {
  cctpCompleteBridge,
  fastTransferFeeBps,
  fetchCctpAttestation,
  readOpsGasBalance,
  readTxTimestampMs,
} from "./cctp.js";
import { alertUser } from "./notifyUser.js";
import { platformFeeEnabled } from "./platformFee.js";

// ─── Job store (UCW challenge relay for long-running kit ops) ──────────────

export type AppKitJobChallenge = {
  challengeId: string;
  at: string;
  /** Circle challenge type, e.g. CONTRACT_EXECUTION or SIGN_TYPEDDATA. */
  type?: string;
  /**
   * True when the strategy is blocked waiting for the browser SDK to hand
   * back a typed-data signature. Only the client that ran `sdk.execute` ever
   * sees it — a completed challenge read from the server does not carry it.
   */
  needsSignature?: boolean;
};

export type AppKitJobMeta = {
  amount?: string;
  fromChain?: string;
  toChain?: string;
  tokenIn?: string;
  tokenOut?: string;
  walletAddress?: string;
  activityId?: string;
  txHash?: string;
  lastTxHash?: string;
  label?: string;
  recoverHint?: string;
  /** Source-token units captured before the kit op started. */
  balanceBefore?: string;
  balanceBeforeAt?: string;
  balanceNow?: string;
  /** True when an expired PIN was dropped because funds never left. */
  abandoned?: boolean;
  fundsIntact?: boolean;
  /** Every transaction the job broadcast, in order (approve, burn, mint…). */
  txHashes?: string[];
  /** The source-chain burn Circle's attestation service recognised. */
  burnTxHash?: string;
  /** Last stage recorded for the app; see jobStage() for the live value. */
  stage?: JobStage;
  /** A failed bridge was re-checked for a stranded burn (checked once). */
  reviveCheckedAt?: string;
  /** Block time of the burn on the source chain. */
  burnAt?: string;
  /**
   * When the server learned the person had entered their first PIN. Stored
   * with the job (which survives restarts), so a server that slept through
   * the wait still knows when the 40-minute clock started.
   */
  firstPinAt?: string;
  /** The person left and the server finished the bridge for them. */
  serverCompletedAt?: string;
  /** What finishing it cost, and the charge that was waived. */
  relay?: BridgeRelayRecord;
};

export type AppKitJob = {
  id: string;
  userId: string;
  op:
    | "send"
    | "bridge"
    | "swap"
    | "deposit"
    | "spend"
    | "compose";
  status: "running" | "succeeded" | "failed";
  challenges: AppKitJobChallenge[];
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  meta?: AppKitJobMeta;
};

/** Durable job store — survives restarts (JSON file + in-memory cache). */
const JOBS_PATH = dataPath("app-kit-jobs.json");
const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const jobs = new Map<string, AppKitJob>();
/** Jobs whose kit.bridge/swap runner is still alive in this process. */
const liveRunners = new Set<string>();

function loadJobsFromDisk() {
  try {
    if (!existsSync(JOBS_PATH)) return;
    const raw = JSON.parse(readFileSync(JOBS_PATH, "utf8")) as AppKitJob[];
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const j of raw) {
      if (!j?.id) continue;
      const updated = new Date(j.updatedAt || j.createdAt).getTime();
      if (Number.isFinite(updated) && now - updated > JOB_TTL_MS) continue;
      jobs.set(j.id, j);
    }
  } catch (e) {
    console.warn("app-kit jobs load:", e instanceof Error ? e.message : e);
  }
}

function persistJobs() {
  try {
    const list = [...jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 500);
    writeJsonAtomic(JOBS_PATH, list);
    markPrimaryStoreDirty();
  } catch (e) {
    console.warn("app-kit jobs persist:", e instanceof Error ? e.message : e);
  }
}

// Warm cache on module load
loadJobsFromDisk();
// Another instance saved: take its view of every job this process is not
// itself driving. A runner alive here holds the freshest state of its own job.
registerPrimaryStoreReloader(() => {
  for (const id of [...jobs.keys()]) {
    if (!liveRunners.has(id)) jobs.delete(id);
  }
  const live = new Map([...jobs.entries()]);
  loadJobsFromDisk();
  for (const [id, job] of live) jobs.set(id, job);
});

function upsertJob(job: AppKitJob) {
  jobs.set(job.id, job);
  // Soft cap + drop expired
  if (jobs.size > 500) {
    const oldest = [...jobs.entries()]
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
      .slice(0, jobs.size - 500);
    for (const [k] of oldest) jobs.delete(k);
  }
  persistJobs();
}

export function getAppKitJob(id: string): AppKitJob | undefined {
  if (!jobs.has(id)) loadJobsFromDisk();
  return jobs.get(id);
}

export function isJobLive(id: string): boolean {
  return liveRunners.has(id);
}

export function listAppKitJobsForUser(userId: string): AppKitJob[] {
  if (jobs.size === 0) loadJobsFromDisk();
  return [...jobs.values()]
    .filter((j) => j.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function patchJobMeta(id: string, patch: AppKitJobMeta) {
  const j = jobs.get(id);
  if (!j) return;
  // A transaction hash only exists once a PIN was entered, so the first one
  // is as good a record of that moment as the app's own report.
  const firstPinAt =
    !j.meta?.firstPinAt &&
    !patch.firstPinAt &&
    (patch.txHash || patch.lastTxHash || (patch.txHashes && patch.txHashes.length))
      ? { firstPinAt: new Date().toISOString() }
      : {};
  j.meta = { ...(j.meta || {}), ...patch, ...firstPinAt };
  j.updatedAt = new Date().toISOString();
  persistJobs();
}

function finishJobActivity(
  job: AppKitJob,
  status: "completed" | "failed" | "cancelled",
  txHash?: string,
  description?: string,
) {
  const activityId = job.meta?.activityId;
  if (!activityId) return;
  store.updateActivity(activityId, {
    status,
    ...(txHash ? { txHash } : {}),
    ...(description ? { description } : {}),
  });
}

function touchJob(
  id: string,
  patch: Partial<Pick<AppKitJob, "status" | "result" | "error">>,
) {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch, { updatedAt: new Date().toISOString() });
  persistJobs();
}

function pushChallenge(
  jobId: string,
  challenge: { challengeId?: string; id?: string; type?: string },
) {
  const j = jobs.get(jobId);
  if (!j) return;
  const challengeId = challenge.challengeId || challenge.id;
  if (!challengeId) return;
  if (j.challenges.some((c) => c.challengeId === challengeId)) return;
  j.challenges.push({
    challengeId,
    at: new Date().toISOString(),
    ...(challenge.type ? { type: String(challenge.type) } : {}),
  });
  j.updatedAt = new Date().toISOString();
  persistJobs();
}

function markChallenge(
  jobId: string,
  challengeId: string,
  patch: Partial<AppKitJobChallenge>,
) {
  const j = jobs.get(jobId);
  if (!j) return;
  const row = j.challenges.find((c) => c.challengeId === challengeId);
  if (!row) return;
  Object.assign(row, patch);
  j.updatedAt = new Date().toISOString();
  persistJobs();
}

// ─── Typed-data signature relay ────────────────────────────────────────────
//
// Circle's UCW strategy reads transaction outcomes back by polling, but a
// typed-data *signature* is delivered only to the client that executed the
// challenge (in the W3S browser SDK result). Without a
// `resolveTypedDataSignature` handler the strategy does not advertise the
// `evm-typed-data` family at all, so App Kit silently drops to a slower
// on-chain alternative — or stalls with the challenge sitting at PENDING.

type SignatureWaiter = {
  resolve: (signature: `0x${string}`) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const signatureWaiters = new Map<string, SignatureWaiter>();

const waiterKey = (jobId: string, challengeId: string) =>
  `${jobId}:${challengeId}`;

/** Wait for the app to relay the signature produced by `sdk.execute`. */
function awaitTypedDataSignature(input: {
  jobId: string;
  challengeId: string;
  timeoutMs?: number;
}): Promise<`0x${string}`> {
  const key = waiterKey(input.jobId, input.challengeId);
  const existing = signatureWaiters.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error("Superseded by a newer signature request"));
    signatureWaiters.delete(key);
  }
  markChallenge(input.jobId, input.challengeId, { needsSignature: true });

  return new Promise<`0x${string}`>((resolve, reject) => {
    const timer = setTimeout(() => {
      signatureWaiters.delete(key);
      markChallenge(input.jobId, input.challengeId, { needsSignature: false });
      reject(
        new Error(
          `Timed out waiting for typed-data signature (challenge ${input.challengeId.slice(0, 8)}…). ` +
            "The app must POST the W3S result signature to " +
            "/v1/app-kit/jobs/:id/signature after PIN.",
        ),
      );
    }, input.timeoutMs ?? 600_000);

    signatureWaiters.set(key, { resolve, reject, timer });
  });
}

/**
 * Fulfil a pending typed-data challenge with the signature the mobile client
 * read out of `sdk.execute(challengeId, (err, result) => result.data.signature)`.
 */
/**
 * The app reports that a PIN for this job went through. Only the first
 * report is kept: it is the moment the hold, and its 40-minute clock, begin.
 */
export function noteJobPinEntered(input: {
  jobId: string;
  userId: string;
  at?: Date;
}): { ok: boolean; firstPinAt?: string } {
  const job = jobs.get(input.jobId);
  if (!job || job.userId !== input.userId) return { ok: false };
  if (!job.meta?.firstPinAt) {
    patchJobMeta(job.id, { firstPinAt: (input.at ?? new Date()).toISOString() });
  }
  return { ok: true, firstPinAt: jobs.get(job.id)?.meta?.firstPinAt };
}

export function submitChallengeSignature(input: {
  jobId: string;
  challengeId: string;
  signature?: string;
  /** Pass a reason instead of a signature when the user declined. */
  rejectedReason?: string;
}): { ok: boolean; error?: string } {
  const key = waiterKey(input.jobId, input.challengeId);
  const waiter = signatureWaiters.get(key);
  if (!waiter) {
    return { ok: false, error: "No challenge is waiting for a signature" };
  }
  clearTimeout(waiter.timer);
  signatureWaiters.delete(key);
  markChallenge(input.jobId, input.challengeId, { needsSignature: false });

  if (input.rejectedReason) {
    waiter.reject(new Error(input.rejectedReason));
    return { ok: true };
  }
  if (!input.signature || !/^0x[a-fA-F0-9]+$/.test(input.signature)) {
    const error = "signature must be a 0x-prefixed hex string";
    waiter.reject(new Error(error));
    return { ok: false, error };
  }
  waiter.resolve(input.signature as `0x${string}`);
  return { ok: true };
}

function cancelJobWaiters(jobId: string, reason: string) {
  for (const [key, waiter] of signatureWaiters) {
    if (!key.startsWith(`${jobId}:`)) continue;
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
    signatureWaiters.delete(key);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * App Kit's send and unified-balance deposit/spend take no custom fee, so
 * with the platform fee on they would move money fee-free. Refuse, pointing
 * at the route that batches the fee into the same PIN.
 */
function assertNoUncollectableFee(what: string, route: string) {
  if (!platformFeeEnabled()) return;
  throw new Error(
    `This ${what} route cannot collect the Evabob fee. Use ${route}.`,
  );
}

function amountStr(n: string | number): string {
  if (typeof n === "number") {
    if (!Number.isFinite(n) || n <= 0) throw new Error("Amount must be positive");
    return n.toFixed(6).replace(/\.?0+$/, "") || String(n);
  }
  const t = n.trim();
  if (!t || Number(t) <= 0) throw new Error("Amount must be positive");
  return t;
}

function withBridgeConfig(amount: string) {
  const customFee = buildBridgeFee(amount);
  return {
    ...(config.appKit.kitKey ? { kitKey: config.appKit.kitKey } : {}),
    ...(customFee ? { customFee } : {}),
  };
}

function withSwapConfig() {
  const customFee = buildSwapFeeConfig();
  return {
    ...(config.appKit.kitKey ? { kitKey: config.appKit.kitKey } : {}),
    ...(customFee ? { customFee } : {}),
  };
}

function recordActivity(input: {
  userId: string;
  kind: "send" | "bridge" | "exchange" | "fund" | "receive";
  title: string;
  description: string;
  amountUsdc?: number;
  token?: string;
  amountToken?: number;
  mode?: string;
  txHash?: string;
  counterparty?: string;
}) {
  return store.addActivity({
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    description: input.description,
    amountUsdc: input.amountUsdc ?? 0,
    counterparty: input.counterparty,
    token: input.token,
    amountToken: input.amountToken,
    mode: input.mode || "app_kit",
    txHash: input.txHash,
    status: "completed",
  });
}

function extractAmountOut(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const key of ["amountOut", "estimatedOutput", "amount"]) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return String(v);
    }
    if (typeof v === "string" && Number(v) > 0) return v.trim();
  }
  return undefined;
}

function extractTxHint(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.txHash === "string") return r.txHash;
  if (typeof r.hash === "string") return r.hash;
  const steps = r.steps;
  if (Array.isArray(steps)) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i] as Record<string, unknown> | undefined;
      if (s && typeof s.txHash === "string") return s.txHash;
      if (s && typeof s.explorerUrl === "string") return s.explorerUrl;
    }
  }
  return undefined;
}

// ─── Adapter builders ──────────────────────────────────────────────────────

export type OpsAdapterInput = {
  mode?: AdapterMode;
  /** Required for circle-wallets adapter */
  address?: string;
  chain?: AppKitChain | string;
};

async function opsFrom(input: OpsAdapterInput) {
  const chain = resolveAppKitChain(input.chain || "Arc_Testnet");
  const { mode, adapter } = pickAdapter(input.mode);
  if (mode === "circle-wallets") {
    const address = resolveDcWalletAddress(input.address);
    return {
      mode,
      chain,
      address,
      context: {
        adapter,
        chain,
        address,
      },
    };
  }
  // viem ops: address is derived from the private-key adapter
  // (user-controlled addressContext — do not pass address)
  return {
    mode,
    chain,
    address: undefined as string | undefined,
    context: {
      adapter,
      chain,
    },
  };
}

export type UcwAdapterInput = {
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  chains: Array<AppKitChain | string>;
  jobId: string;
  /**
   * When true, never bind `walletId` — the factory finds/creates the wallet
   * for `chains[0]`. Binding an Arc SCA onto Eth/Base throws
   * `Action "usdc.name" is not registered in this adapter`.
   */
  chainScoped?: boolean;
};

/** Built-in USDC locators so usdc.name / balanceOf / allowance exist per chain. */
const PRODUCT_USDC_TOKENS = createTokenRegistry({
  tokens: [
    {
      symbol: "USDC",
      decimals: 6,
      locators: {
        Arc_Testnet: "0x3600000000000000000000000000000000000000",
        Ethereum_Sepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        Base_Sepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
    },
  ],
});

function evmAdapterChains(chains: AppKitChain[]): AppKitChain[] {
  return [...new Set(chains)];
}

async function ucwAdapter(input: UcwAdapterInput) {
  if (!config.circle.apiKey) {
    throw new Error("CIRCLE_API_KEY required for UCW App Kit adapter");
  }
  const chains = evmAdapterChains(input.chains.map((c) => resolveAppKitChain(c)));

  const onChallenge = (challenge: { challengeId: string; type?: string }) => {
    pushChallenge(input.jobId, challenge);
  };

  // Fire-and-forget progress: lets the job show attest/mint movement instead
  // of looking frozen between PIN and the landed transaction.
  const onProgress = (progress: {
    challengeId?: string;
    status?: string;
    txHash?: string;
    transactionId?: string;
  }) => {
    if (!progress?.challengeId) return;
    console.info(
      `[app-kit ${input.jobId.slice(0, 8)}] challenge ` +
        `${progress.challengeId.slice(0, 8)}… ${progress.status ?? "?"}` +
        (progress.txHash ? ` tx=${progress.txHash.slice(0, 12)}…` : ""),
    );
    if (progress.txHash && /^0x[a-fA-F0-9]{64}$/i.test(progress.txHash)) {
      // Keep every hash, not just the latest: recovery has to find the burn,
      // and the last hash is often the approve or the destination mint.
      const seen = jobs.get(input.jobId)?.meta?.txHashes ?? [];
      patchJobMeta(input.jobId, {
        txHash: progress.txHash,
        lastTxHash: progress.txHash,
        txHashes: seen.includes(progress.txHash)
          ? seen
          : [...seen, progress.txHash],
      });
    }
  };

  // Without this the strategy reports supportsSignTypedData() === false and
  // App Kit picks a different route (or stalls) for CCTP steps that need an
  // EIP-712 signature. See awaitTypedDataSignature above for the relay.
  const resolveTypedDataSignature = (challenge: { challengeId: string }) =>
    awaitTypedDataSignature({
      jobId: input.jobId,
      challengeId: challenge.challengeId,
    });

  // SDK overloads are strict; cast via unknown after assembling options.
  type UcwOpts = Parameters<typeof createCircleUserWalletAdapter>[0];
  const shared = {
    apiKey: config.circle.apiKey,
    userToken: input.userToken,
    onChallenge,
    onProgress,
    resolveTypedDataSignature,
    tokens: PRODUCT_USDC_TOKENS,
    // Official sepolia.base.org 503s gas/simulation. PublicNode is healthy.
    rpcUrls: {
      5042002: config.arc.rpcUrl,
      84532:
        process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
        "https://base-sepolia-rpc.publicnode.com",
      11155111:
        process.env.ETH_SEPOLIA_RPC_URL?.trim() ||
        "https://ethereum-sepolia-rpc.publicnode.com",
    } as Record<number, string>,
  };

  // Explicit walletId+chain must be the wallet that actually lives on that
  // chain. The session wallet is almost always Arc; binding it to Eth/Base
  // is the usdc.name error on Gateway top-up.
  const evmWallet =
    input.walletAddress && /^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)
      ? (input.walletAddress as `0x${string}`)
      : undefined;

  if (
    !input.chainScoped &&
    input.walletId &&
    evmWallet &&
    chains.length === 1
  ) {
    return withPatientConfirmations(createCircleUserWalletAdapter({
      ...shared,
      walletId: input.walletId,
      walletAddress: evmWallet,
      chain: chains[0]!,
      accountType: "SCA",
    } as unknown as UcwOpts));
  }

  if (chains.length === 1) {
    return withPatientConfirmations(createCircleUserWalletAdapter({
      ...shared,
      chain: chains[0]!,
      accountType: "SCA",
    } as unknown as UcwOpts));
  }

  return withPatientConfirmations(createCircleUserWalletAdapter({
    ...shared,
    chains,
  } as unknown as UcwOpts));
}

// ─── Core ops (server-signed) ──────────────────────────────────────────────

export async function appKitSend(input: {
  userId: string;
  fromAddress?: string;
  to: string;
  amount: string | number;
  token?: "USDC" | "EURC" | string;
  chain?: string;
  mode?: AdapterMode;
}) {
  const kit = getAppKit();
  const amount = amountStr(input.amount);
  const token = (input.token || "USDC").toUpperCase();
  const from = await opsFrom({
    mode: input.mode,
    address: input.fromAddress,
    chain: input.chain || "Arc_Testnet",
  });

  const result = await kit.send({
    from: from.context as never,
    to: input.to,
    amount,
    token: token as never,
  });

  const serialized = serializeAppKitResult(result);
  const tx = extractTxHint(serialized);
  const activity = recordActivity({
    userId: input.userId,
    kind: "send",
    title: input.to.slice(0, 12) + (input.to.length > 12 ? "…" : ""),
    description: `App Kit send ${amount} ${token} on ${from.chain}`,
    amountUsdc: token === "USDC" ? -Number(amount) : 0,
    token,
    amountToken: Number(amount),
    mode: `app_kit_send_${from.mode}`,
    txHash: tx,
    counterparty: input.to,
  });

  return {
    ok: true,
    adapter: from.mode,
    chain: from.chain,
    txHash: tx,
    result: serialized,
    activityId: activity.id,
    appId: circleAppId(),
  };
}

export async function appKitBridge(input: {
  userId: string;
  fromAddress?: string;
  toAddress?: string;
  fromChain: string | number;
  toChain: string | number;
  amount: string | number;
  mode?: AdapterMode;
}) {
  const kit = getAppKit();
  const amount = amountStr(input.amount);
  const from = await opsFrom({
    mode: input.mode,
    address: input.fromAddress,
    chain: resolveAppKitChain(input.fromChain),
  });
  const toChain = resolveAppKitChain(input.toChain);
  const { adapter: toAdapter, mode: toMode } = pickAdapter(input.mode);

  // Developer-controlled Circle Wallets need `address` on the adapter context.
  // For viem ops, prefer Circle Forwarder on destination so mint does not
  // require native gas on the destination chain (ops wallet often has 0 ETH
  // on Base/Eth Sepolia). recipientAddress is the final mint recipient.
  let toCtx: Record<string, unknown>;
  if (toMode === "circle-wallets") {
    // Prefer explicit mint recipient; else same DC wallet.
    // Always use Circle Forwarder so destination native gas is not required.
    const destAddr =
      input.toAddress || resolveDcWalletAddress(input.fromAddress);
    toCtx = {
      chain: toChain,
      useForwarder: true,
      recipientAddress: destAddr,
    };
  } else if (input.toAddress) {
    // Forwarder-only destination: Orbit relayer pays destination gas
    toCtx = {
      chain: toChain,
      useForwarder: true,
      recipientAddress: input.toAddress,
    };
  } else {
    toCtx = {
      adapter: toAdapter,
      chain: toChain,
      useForwarder: true,
    };
  }

  const result = await kit.bridge({
    from: from.context as never,
    to: toCtx as never,
    amount,
    config: withBridgeConfig(amount) as never,
  });

  const serialized = serializeAppKitResult(result);
  const tx = extractTxHint(serialized);
  const activity = recordActivity({
    userId: input.userId,
    kind: "bridge",
    title: `${from.chain} → ${toChain}`,
    description: `App Kit bridge ${amount} USDC`,
    amountUsdc: -Number(amount),
    token: "USDC",
    amountToken: Number(amount),
    mode: `app_kit_bridge_${from.mode}`,
    txHash: tx,
  });

  return {
    ok: true,
    adapter: from.mode,
    fromChain: from.chain,
    toChain,
    result: serialized,
    activityId: activity.id,
    fee: buildCustomFee(amount) || null,
  };
}

export async function appKitSwap(input: {
  userId: string;
  fromAddress?: string;
  chain?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn: string | number;
  mode?: AdapterMode;
}) {
  const kit = getAppKit();
  const amountIn = amountStr(input.amountIn);
  const tokenIn = (input.tokenIn || "USDC").toUpperCase();
  const tokenOut = (input.tokenOut || "EURC").toUpperCase();
  const from = await opsFrom({
    mode: input.mode,
    address: input.fromAddress,
    chain: input.chain || "Arc_Testnet",
  });

  const result = await kit.swap({
    from: from.context as never,
    tokenIn: tokenIn as never,
    tokenOut: tokenOut as never,
    amountIn,
    config: withSwapConfig() as never,
  });

  const serialized = serializeAppKitResult(result);
  const tx = extractTxHint(serialized);
  const activity = recordActivity({
    userId: input.userId,
    kind: "exchange",
    title: `${tokenIn} → ${tokenOut}`,
    description: `App Kit swap ${amountIn} ${tokenIn} → ${tokenOut}`,
    amountUsdc: tokenIn === "USDC" ? -Number(amountIn) : 0,
    token: tokenOut,
    amountToken: Number(amountIn),
    mode: `app_kit_swap_${from.mode}`,
    txHash: tx,
  });

  return {
    ok: true,
    adapter: from.mode,
    chain: from.chain,
    tokenIn,
    tokenOut,
    result: serialized,
    activityId: activity.id,
    fee: buildSwapFeeConfig() || null,
  };
}

export async function appKitDeposit(input: {
  userId: string;
  fromAddress?: string;
  chain?: string;
  amount: string | number;
  token?: string;
  mode?: AdapterMode;
}) {
  const kit = getAppKit();
  const amount = amountStr(input.amount);
  const token = (input.token || "USDC").toUpperCase();
  const from = await opsFrom({
    mode: input.mode,
    address: input.fromAddress,
    chain: input.chain || "Base_Sepolia",
  });

  const result = await kit.unifiedBalance.deposit({
    from: from.context as never,
    amount,
    token: token as never,
    allowanceStrategy: "approve" as const,
  } as never);

  const serialized = serializeAppKitResult(result);
  const tx = extractTxHint(serialized);
  const activity = recordActivity({
    userId: input.userId,
    kind: "fund",
    title: "Unified Balance deposit",
    description: `App Kit deposit ${amount} ${token} from ${from.chain}`,
    amountUsdc: token === "USDC" ? Number(amount) : 0,
    token,
    amountToken: Number(amount),
    mode: `app_kit_deposit_${from.mode}`,
    txHash: tx,
  });

  return {
    ok: true,
    adapter: from.mode,
    chain: from.chain,
    result: serialized,
    activityId: activity.id,
  };
}

export async function appKitSpend(input: {
  userId: string;
  /** Spend signer (circle wallets / viem). Optional address for circle-wallets. */
  fromAddress?: string;
  toChain?: string;
  recipientAddress: string;
  amountIn: string | number;
  token?: string;
  mode?: AdapterMode;
  toAddress?: string;
}) {
  const kit = getAppKit();
  const amountIn = amountStr(input.amountIn);
  const token = (input.token || "USDC").toUpperCase();
  const { mode, adapter } = pickAdapter(input.mode);
  const toChain = resolveAppKitChain(input.toChain || "Arc_Testnet");

  const fromCtx: Record<string, unknown> = { adapter };
  if (input.fromAddress) fromCtx.address = input.fromAddress;

  const toCtx: Record<string, unknown> = {
    adapter,
    chain: toChain,
    recipientAddress: input.recipientAddress,
  };
  if (input.toAddress) {
    toCtx.address = input.toAddress;
  }

  const result = await kit.unifiedBalance.spend({
    from: fromCtx as never,
    amountIn,
    to: toCtx as never,
    ...(token !== "USDC" ? { token } : {}),
  } as never);

  const serialized = serializeAppKitResult(result);
  const tx = extractTxHint(serialized);
  const activity = recordActivity({
    userId: input.userId,
    kind: "send",
    title: `Unified spend → ${toChain}`,
    description: `App Kit spend ${amountIn} ${token} to ${input.recipientAddress}`,
    amountUsdc: token === "USDC" ? -Number(amountIn) : 0,
    token,
    amountToken: Number(amountIn),
    mode: `app_kit_spend_${mode}`,
    txHash: tx,
    counterparty: input.recipientAddress,
  });

  return {
    ok: true,
    adapter: mode,
    toChain,
    result: serialized,
    activityId: activity.id,
  };
}

/** App Kit chain → CCTP / Gateway domain (product testnets). */
const APPKIT_CHAIN_TO_DOMAIN: Record<string, number> = {
  Arc_Testnet: 26,
  Ethereum_Sepolia: 0,
  Base_Sepolia: 6,
  Ethereum: 0,
  Base: 6,
  Arc: 26,
};

function toHumanUsdc(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  // App Kit returns human-readable strings; legacy Gateway API uses raw 1e6.
  // Only scale when clearly micro-units (integer >> typical human amounts).
  if (n > 1e9 || (Number.isInteger(n) && Math.abs(n) >= 1e7)) return n / 1e6;
  return n;
}

/**
 * Unified Balance (Gateway) for an EVM address.
 * Parses App Kit's real shape: totalConfirmedBalance / totalPendingBalance + nested breakdown.
 * Always queries product testnets so Arc/Sepolia deposits are not missed (SDK defaults to mainnet).
 */
export async function appKitGetBalances(input: {
  address: string;
  token?: string;
  /** Include pending deposits that have not finalized yet. */
  includePending?: boolean;
}) {
  const kit = getAppKit();
  const includePending = input.includePending !== false;
  const result = await kit.unifiedBalance.getBalances({
    token: (input.token || "USDC") as "USDC",
    sources: {
      address: input.address,
      chains: [
        "Arc_Testnet",
        "Ethereum_Sepolia",
        "Base_Sepolia",
      ],
    },
    includePending,
    networkType: "testnet",
  } as never);
  const serialized = serializeAppKitResult(result);
  const raw = serialized as Record<string, unknown>;

  let confirmedUsdc = toHumanUsdc(
    raw.totalConfirmedBalance ?? raw.totalConfirmed ?? raw.confirmedBalance,
  );
  let pendingUsdc = toHumanUsdc(
    raw.totalPendingBalance ?? raw.totalPending ?? raw.pendingBalance,
  );

  type BalanceRow = {
    domain?: number;
    chain?: string;
    name?: string;
    balanceUsdc: number;
    pendingUsdc: number;
    confirmedUsdc: number;
    balance: string;
  };
  const rows: BalanceRow[] = [];

  const accounts = Array.isArray(raw.breakdown) ? raw.breakdown : [];
  for (const acct of accounts) {
    if (!acct || typeof acct !== "object") continue;
    const a = acct as Record<string, unknown>;
    // If root totals missing, sum per-depositor totals.
    if (!confirmedUsdc) confirmedUsdc += toHumanUsdc(a.totalConfirmed);
    if (!pendingUsdc) pendingUsdc += toHumanUsdc(a.totalPending);
    const chains = Array.isArray(a.breakdown) ? a.breakdown : [];
    for (const ch of chains) {
      if (!ch || typeof ch !== "object") continue;
      const c = ch as Record<string, unknown>;
      const chainName = String(c.chain ?? c.name ?? "");
      const conf = toHumanUsdc(
        c.confirmedBalance ?? c.balance ?? c.confirmed,
      );
      const pend = toHumanUsdc(c.pendingBalance ?? c.pending);
      rows.push({
        chain: chainName,
        name: chainName,
        domain: APPKIT_CHAIN_TO_DOMAIN[chainName],
        confirmedUsdc: conf,
        pendingUsdc: pend,
        balanceUsdc: conf + pend,
        balance: String(Math.round((conf + pend) * 1e6)),
      });
    }
  }

  // Legacy / alternate shapes (balances[] flat list)
  if (rows.length === 0) {
    const pickList = (v: unknown): unknown[] => {
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object" && Array.isArray((v as { balances?: unknown }).balances)) {
        return (v as { balances: unknown[] }).balances;
      }
      return [];
    };
    for (const item of pickList(raw.balances ?? raw.data ?? raw)) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const conf = toHumanUsdc(row.balance ?? row.amount ?? row.confirmed ?? row.confirmedBalance);
      const pend = toHumanUsdc(row.pending ?? row.pendingBalance);
      const chainName = String(row.chain ?? row.name ?? "");
      rows.push({
        chain: chainName || undefined,
        name: chainName || undefined,
        domain:
          typeof row.domain === "number"
            ? row.domain
            : APPKIT_CHAIN_TO_DOMAIN[chainName],
        confirmedUsdc: conf,
        pendingUsdc: pend,
        balanceUsdc: conf + pend,
        balance: String(Math.round((conf + pend) * 1e6)),
      });
      if (!confirmedUsdc) confirmedUsdc += conf;
      if (!pendingUsdc) pendingUsdc += pend;
    }
  }

  if (!confirmedUsdc && !pendingUsdc) {
    const total = toHumanUsdc(raw.total ?? raw.totalBalance ?? raw.balance);
    const pend = toHumanUsdc(raw.pending ?? raw.pendingBalance);
    if (total) confirmedUsdc = total;
    if (pend) pendingUsdc = pend;
  }

  return {
    raw: serialized,
    confirmedUsdc,
    pendingUsdc,
    totalUsdc: confirmedUsdc + pendingUsdc,
    includePending,
    balances: rows,
  };
}

/**
 * Multi-step composition: optional unified spend → optional swap → optional bridge.
 * Any subset of steps can be enabled.
 */
export async function appKitCompose(input: {
  userId: string;
  fromAddress?: string;
  mode?: AdapterMode;
  /** Spend from unified balance first */
  spend?: {
    amountIn: string | number;
    recipientAddress?: string;
    toChain?: string;
  };
  /** Then swap on Arc (or spend destination chain) */
  swap?: {
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string | number;
    chain?: string;
  };
  /** Then bridge USDC out */
  bridge?: {
    fromChain?: string;
    toChain: string | number;
    toAddress?: string;
    amount?: string | number;
  };
}) {
  const steps: Array<{ step: string; result: unknown }> = [];
  let workingAmount: string | undefined;

  if (input.spend) {
    const recipient =
      input.spend.recipientAddress ||
      input.fromAddress ||
      (() => {
        throw new Error("spend.recipientAddress or fromAddress required");
      })();
    const spendRes = await appKitSpend({
      userId: input.userId,
      fromAddress: input.fromAddress,
      recipientAddress: recipient,
      amountIn: input.spend.amountIn,
      toChain: input.spend.toChain || "Arc_Testnet",
      mode: input.mode,
    });
    steps.push({ step: "unifiedBalance.spend", result: spendRes });
    workingAmount = amountStr(input.spend.amountIn);
  }

  if (input.swap) {
    const amountIn = amountStr(
      input.swap.amountIn ?? workingAmount ?? "0",
    );
    const swapRes = await appKitSwap({
      userId: input.userId,
      fromAddress: input.fromAddress,
      chain: input.swap.chain || "Arc_Testnet",
      tokenIn: input.swap.tokenIn || "USDC",
      tokenOut: input.swap.tokenOut || "EURC",
      amountIn,
      mode: input.mode,
    });
    steps.push({ step: "swap", result: swapRes });
    workingAmount = amountIn;
  }

  if (input.bridge) {
    const amount = amountStr(input.bridge.amount ?? workingAmount ?? "0");
    const bridgeRes = await appKitBridge({
      userId: input.userId,
      fromAddress: input.fromAddress,
      toAddress: input.bridge.toAddress || input.fromAddress,
      fromChain: input.bridge.fromChain || "Arc_Testnet",
      toChain: input.bridge.toChain,
      amount,
      mode: input.mode,
    });
    steps.push({ step: "bridge", result: bridgeRes });
  }

  if (steps.length === 0) {
    throw new Error("compose requires at least one of: spend, swap, bridge");
  }

  return {
    ok: true,
    steps,
    workingAmount,
    configured: appKitConfigured(),
  };
}

// ─── UCW job runners (PIN via existing challenge WebView) ──────────────────

function activityKindForOp(
  op: AppKitJob["op"],
): "send" | "bridge" | "exchange" | "fund" {
  if (op === "bridge") return "bridge";
  if (op === "swap" || op === "compose") return "exchange";
  if (op === "deposit") return "fund";
  return "send";
}

function startJob(
  userId: string,
  op: AppKitJob["op"],
  runner: (jobId: string) => Promise<unknown>,
  meta?: AppKitJobMeta,
): AppKitJob {
  const id = randomUUID();
  const now = new Date().toISOString();
  const amount = Number(meta?.amount || 0);
  const label =
    meta?.label ||
    (op === "bridge"
      ? `${meta?.fromChain || "source"} → ${meta?.toChain || "dest"}`
      : op === "swap"
        ? `${meta?.tokenIn || "USDC"} → ${meta?.tokenOut || "EURC"}`
        : op);
  // A caller that already opened a pending row for this payment passes its id
  // here, and the job adopts it. Without that, the send route's row and this
  // one were two entries in the feed for a single send — and only this one
  // ever got its status and hash filled in, so the other sat "pending" for
  // good.
  const existingId = meta?.activityId;
  const activity = existingId
    ? (store.updateActivity(existingId, {
        mode: `app_kit_ucw_${op}`,
        jobId: id,
      }) ?? { id: existingId })
    : store.addActivity({
        userId,
        kind: activityKindForOp(op),
        title: label,
        description: `Waiting for PIN · ${op} ${meta?.amount || ""} ${
          meta?.tokenIn || "USDC"
        }`.trim(),
        amountUsdc: Number.isFinite(amount) && amount > 0 ? -amount : 0,
        token: meta?.tokenIn || "USDC",
        amountToken: Number.isFinite(amount) ? amount : undefined,
        mode: `app_kit_ucw_${op}`,
        status: "pending",
        jobId: id,
      });
  const job: AppKitJob = {
    id,
    userId,
    op,
    status: "running",
    challenges: [],
    createdAt: now,
    updatedAt: now,
    meta: { ...meta, activityId: activity.id, stage: "waiting_pin" },
  };
  upsertJob(job);

  liveRunners.add(id);
  // Fire-and-forget — client polls GET /jobs/:id for challenges + result
  void (async () => {
    try {
      const addr = meta?.walletAddress;
      const chain = meta?.fromChain;
      const token = meta?.tokenIn || "USDC";
      if (addr && chain) {
        try {
          const bal = await readChainTokenBalance({
            address: addr,
            chain,
            token,
          });
          if (bal != null) {
            patchJobMeta(id, {
              balanceBefore: String(bal),
              balanceBeforeAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.warn(
            `[app-kit ${id.slice(0, 8)}] source snapshot:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      const result = await runner(id);
      if (jobs.get(id)?.meta?.abandoned) return;
      const serialized = serializeAppKitResult(result);
      const tx =
        extractTxHint(serialized) || jobs.get(id)?.meta?.lastTxHash;
      touchJob(id, {
        status: "succeeded",
        result: serialized,
      });
      patchJobMeta(id, { stage: "arrived" });
      const done = jobs.get(id);
      if (done) {
        finishJobActivity(
          done,
          "completed",
          tx,
          `${op} complete${tx ? ` · ${tx.slice(0, 10)}…` : ""}`,
        );
      }
    } catch (e) {
      if (jobs.get(id)?.meta?.abandoned) return;
      const err = e instanceof Error ? e.message : String(e);
      const current = jobs.get(id);
      const decision = current
        ? await decideAfterRunnerError(current).catch((inner) => {
            console.warn(
              `[app-kit ${id.slice(0, 8)}] failure check:`,
              inner instanceof Error ? inner.message : inner,
            );
            // Unable to check: never declare failure over possibly-moved money.
            return current.meta?.txHashes?.length
              ? ({ outcome: "keep_running", stage: "sent", reason: "check failed" } as const)
              : ({ outcome: "failed", reason: "check failed" } as const);
          })
        : ({ outcome: "failed", reason: "job missing" } as const);

      if (decision.outcome === "keep_running") {
        console.warn(
          `[app-kit ${id.slice(0, 8)}] runner stopped (${err}); kept open: ${decision.reason}`,
        );
        touchJob(id, { error: err });
        patchJobMeta(id, {
          stage: decision.stage,
          recoverHint:
            op === "bridge"
              ? "Your money has left and is on its way. Tap Continue to finish it."
              : "This payment may have gone through. Tap Continue to check.",
        });
        const activityId = jobs.get(id)?.meta?.activityId;
        if (activityId) {
          store.updateActivity(activityId, {
            status: "pending",
            description: "On hold · tap Continue to finish",
          });
        }
      } else if (decision.outcome === "succeeded") {
        touchJob(id, { status: "succeeded" });
        patchJobMeta(id, { stage: "arrived" });
        const done = jobs.get(id);
        if (done) {
          finishJobActivity(
            done,
            "completed",
            done.meta?.lastTxHash,
            `${op} complete`,
          );
        }
      } else {
        touchJob(id, {
          status: "failed",
          error: err,
        });
        const failed = jobs.get(id);
        if (failed) {
          finishJobActivity(failed, "failed", failed.meta?.lastTxHash, err);
        }
      }
    } finally {
      liveRunners.delete(id);
      // Jobs outlive their creating response, including their activity rows.
      // Flush at the runner boundary so success/failure survives a restart.
      await flushPrimaryStore().catch((e) => {
        console.error(
          `[app-kit ${id.slice(0, 8)}] persistence:`,
          e instanceof Error ? e.message : e,
        );
      });
    }
  })();

  return job;
}

export type DismissedAppKitJob = {
  jobId: string;
  op: AppKitJob["op"];
  fundsIntact: boolean;
  balanceBefore?: number | null;
  balanceNow?: number | null;
  reason: string;
  message: string;
};

async function currentSourceBalance(job: AppKitJob): Promise<number | null> {
  const addr = job.meta?.walletAddress;
  const chain = job.meta?.fromChain;
  const token = job.meta?.tokenIn || "USDC";
  if (!addr || !chain) return null;
  try {
    return await readChainTokenBalance({ address: addr, chain, token });
  } catch (e) {
    console.warn(
      `[app-kit ${job.id.slice(0, 8)}] balance now:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

const TX_HASH = /^0x[a-fA-F0-9]{64}$/;

function jobTxHashes(job: AppKitJob): string[] {
  const set = new Set<string>();
  for (const h of [
    job.meta?.burnTxHash,
    ...(job.meta?.txHashes ?? []),
    job.meta?.txHash,
    job.meta?.lastTxHash,
  ]) {
    if (h && TX_HASH.test(h)) set.add(h);
  }
  return [...set];
}

type BurnLookup = {
  hash: string;
  status: string;
  destinationCaller?: string;
};

/**
 * Ask Circle's attestation service which of the job's transactions was the
 * CCTP burn. An approve or a mint hash simply has no message.
 */
async function findBurnMessage(job: AppKitJob): Promise<BurnLookup | null> {
  const sourceDomain = job.meta?.fromChain
    ? APPKIT_CHAIN_TO_DOMAIN[job.meta.fromChain]
    : undefined;
  if (sourceDomain == null) return null;
  for (const hash of jobTxHashes(job)) {
    try {
      const data = (await fetchCctpAttestation(sourceDomain, hash)) as {
        messages?: Array<{
          status?: string;
          decodedMessage?: { destinationCaller?: string };
        }>;
      };
      const msg = data?.messages?.[0];
      if (!msg) continue;
      if (job.meta?.burnTxHash !== hash) {
        patchJobMeta(job.id, { burnTxHash: hash });
      }
      return {
        hash,
        status: msg.status || "pending",
        destinationCaller: msg.decodedMessage?.destinationCaller,
      };
    } catch (e) {
      console.warn(
        `[app-kit ${job.id.slice(0, 8)}] burn lookup ${hash.slice(0, 10)}…:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return null;
}

async function decideAfterRunnerError(job: AppKitJob) {
  const burn = job.op === "bridge" ? await findBurnMessage(job) : null;
  const balanceNow = await currentSourceBalance(job);
  if (balanceNow != null) {
    patchJobMeta(job.id, { balanceNow: String(balanceNow) });
  }
  return decideRunnerFailure({
    op: job.op,
    burnFound: Boolean(burn),
    anyTxHash: jobTxHashes(job).length > 0,
    balanceBefore: parseBalance(job.meta?.balanceBefore),
    balanceNow,
    amount: parseBalance(job.meta?.amount),
  });
}

/** Bridges whose destination mint the server is currently finishing. */
const bridgeCompletions = new Map<string, Promise<void>>();

/** The stage the app shows for a job right now. */
export function jobStage(job: AppKitJob): JobStage | "failed" {
  if (job.status === "succeeded") return "arrived";
  if (job.status === "failed") return "failed";
  if (bridgeCompletions.has(job.id)) return "confirming";
  if (liveRunners.has(job.id)) {
    return job.meta?.stage === "sent" ? "sent" : "waiting_pin";
  }
  const recorded = job.meta?.stage;
  return recorded && recorded !== "confirming" && recorded !== "arrived"
    ? recorded
    : "waiting_pin";
}

const ZERO_BYTES32 = /^0x0{64}$/i;

/**
 * Finish a burned bridge from the server: wait for Circle's attestation, then
 * submit the destination mint from the ops wallet. Anyone may submit a CCTP
 * mint when the burn set no destination caller, and the USDC still goes to
 * the recipient fixed at burn time.
 *
 * Runs in the background because a Standard attestation from Base or Ethereum
 * takes about 15–19 minutes; the app polls the job for the result.
 */
function startBridgeCompletion(input: {
  jobId: string;
  burnTxHash: string;
  sourceDomain?: number;
  destinationDomain: number;
}): Promise<void> {
  const existing = bridgeCompletions.get(input.jobId);
  if (existing) return existing;
  patchJobMeta(input.jobId, { stage: "confirming" });
  const run = (async () => {
    try {
      const mint = await cctpCompleteBridge({
        burnTxHash: input.burnTxHash,
        destinationDomain: input.destinationDomain,
        sourceDomain: input.sourceDomain,
        timeoutMs: 45 * 60 * 1000,
        pollMs: 10_000,
      });
      // The user (or a previous attempt) already minted it: it has arrived.
      const alreadyMinted =
        !mint.ok && /nonce already used|already (been )?(used|received)/i.test(mint.error || "");
      if (mint.ok || alreadyMinted) {
        touchJob(input.jobId, { status: "succeeded", result: mint });
        patchJobMeta(input.jobId, {
          stage: "arrived",
          recoverHint: undefined,
          ...(mint.ok ? { lastTxHash: mint.mintTx } : {}),
        });
        const live = getAppKitJob(input.jobId);
        if (live) {
          finishJobActivity(
            live,
            "completed",
            mint.ok ? mint.mintTx : input.burnTxHash,
            mint.ok
              ? `Arrived on ${mint.chain}`
              : "Arrived",
          );
        }
        return;
      }
      patchJobMeta(input.jobId, {
        stage: "sent",
        recoverHint:
          mint.status === "pending" || /not complete/i.test(mint.error || "")
            ? "Still confirming on the network. Tap Continue again in a few minutes."
            : "We couldn't finish this yet. Tap Continue to try again.",
      });
      console.warn(
        `[app-kit ${input.jobId.slice(0, 8)}] server mint not finished: ${mint.error}`,
      );
    } catch (e) {
      patchJobMeta(input.jobId, {
        stage: "sent",
        recoverHint: "We couldn't finish this yet. Tap Continue to try again.",
      });
      console.error(
        `[app-kit ${input.jobId.slice(0, 8)}] server mint:`,
        e instanceof Error ? e.message : e,
      );
    } finally {
      bridgeCompletions.delete(input.jobId);
      await flushPrimaryStore().catch(() => undefined);
    }
  })();
  bridgeCompletions.set(input.jobId, run);
  return run;
}

/**
 * Deposits, swaps and spends move money in a single transaction; once the
 * source balance has dropped by the job's amount, that transaction landed.
 */
async function closeIfSourceMoved(job: AppKitJob): Promise<boolean> {
  if (job.op === "bridge" || job.op === "send") return false;
  if (liveRunners.has(job.id)) return false;
  const balanceNow = await currentSourceBalance(job);
  const moved = sourceFundsMoved({
    balanceBefore: parseBalance(job.meta?.balanceBefore),
    balanceNow,
    amount: parseBalance(job.meta?.amount),
  });
  if (moved !== true) return false;
  touchJob(job.id, { status: "succeeded" });
  patchJobMeta(job.id, { stage: "arrived", balanceNow: String(balanceNow) });
  const done = jobs.get(job.id);
  if (done) {
    finishJobActivity(done, "completed", done.meta?.lastTxHash, `${job.op} complete`);
  }
  return true;
}

/**
 * Bridges that failed before this fix could have burned without minting —
 * money stranded between chains with no Continue button. Re-check each
 * failed bridge once; if Circle has its burn, reopen it.
 */
async function reviveStrandedBridges(userId: string): Promise<void> {
  const candidates = listAppKitJobsForUser(userId).filter(
    (j) =>
      j.op === "bridge" &&
      j.status === "failed" &&
      !j.meta?.abandoned &&
      !j.meta?.reviveCheckedAt &&
      jobTxHashes(j).length > 0,
  );
  for (const job of candidates) {
    patchJobMeta(job.id, { reviveCheckedAt: new Date().toISOString() });
    const burn = await findBurnMessage(job);
    if (!burn) continue;
    touchJob(job.id, { status: "running" });
    patchJobMeta(job.id, {
      stage: "sent",
      recoverHint: "Your money has left and is on its way. Tap Continue to finish it.",
    });
    const activityId = job.meta?.activityId;
    if (activityId) {
      store.updateActivity(activityId, {
        status: "pending",
        description: "On hold · tap Continue to finish",
      });
    }
    console.log(`[app-kit] reopened stranded bridge ${job.id} (burn ${burn.hash.slice(0, 12)}…)`);
  }
}

function abandonExpiredJob(
  job: AppKitJob,
  decision: { reason: string; fundsIntact: boolean },
  balanceNow: number | null,
): DismissedAppKitJob {
  const token = job.meta?.tokenIn || "USDC";
  const message = fundsIntactMessage({
    op: job.op,
    token,
    balanceNow,
  });
  cancelJobWaiters(job.id, message);
  touchJob(job.id, {
    status: "failed",
    error: message,
  });
  patchJobMeta(job.id, {
    abandoned: true,
    fundsIntact: decision.fundsIntact,
    recoverHint: message,
    ...(balanceNow != null ? { balanceNow: String(balanceNow) } : {}),
  });
  const live = getAppKitJob(job.id);
  if (live) {
    finishJobActivity(live, "cancelled", undefined, message);
  }
  return {
    jobId: job.id,
    op: job.op,
    fundsIntact: decision.fundsIntact,
    balanceBefore: parseBalance(job.meta?.balanceBefore),
    balanceNow,
    reason: decision.reason,
    message,
  };
}

/**
 * If the PIN/challenge expired and source funds still match the pre-bridge
 * snapshot (or nothing was signed / only an approve landed), drop the job
 * so it no longer sits on Home as an incomplete transfer.
 */
export async function maybeAbandonExpiredJob(
  job: AppKitJob,
  opts?: { userToken?: string },
): Promise<DismissedAppKitJob | null> {
  if (job.status !== "running") return null;
  if (job.meta?.abandoned) {
    return {
      jobId: job.id,
      op: job.op,
      fundsIntact: job.meta.fundsIntact === true,
      balanceBefore: parseBalance(job.meta.balanceBefore),
      balanceNow: parseBalance(job.meta.balanceNow),
      reason: "already_abandoned",
      message:
        job.meta.recoverHint ||
        fundsIntactMessage({
          op: job.op,
          token: job.meta.tokenIn,
          balanceNow: parseBalance(job.meta.balanceNow),
        }),
    };
  }

  const created = new Date(job.createdAt).getTime();
  const jobAgeMs = Number.isFinite(created) ? Date.now() - created : 0;

  const challengeStates: ChallengeExpiryState[] = [];
  let settledLooksLikeBurn = false;
  let statusesKnown = false;

  if (opts?.userToken && job.challenges.length > 0) {
    statusesKnown = true;
    for (const ch of job.challenges) {
      try {
        const s = await readChallengeSettlement({
          userToken: opts.userToken,
          challengeId: ch.challengeId,
        });
        challengeStates.push({ settled: s.settled, dead: s.dead });
        if (s.settled && isTokenMessengerAddress(s.contractAddress)) {
          settledLooksLikeBurn = true;
        }
      } catch (e) {
        console.warn(
          `[app-kit ${job.id.slice(0, 8)}] challenge ${ch.challengeId.slice(0, 8)}:`,
          e instanceof Error ? e.message : e,
        );
        // Don't pretend we know the PIN is still open — a bad userToken
        // would otherwise look like "nothing signed" and hide a real burn.
        statusesKnown = false;
        challengeStates.push({ settled: false, dead: false });
      }
    }
  } else if (job.challenges.length === 0) {
    statusesKnown = true;
  }

  const balanceNow = await currentSourceBalance(job);
  const decision = decideExpiredJobAbandon({
    challenges: challengeStates,
    live: liveRunners.has(job.id),
    jobAgeMs,
    statusesKnown,
    balanceBefore: parseBalance(job.meta?.balanceBefore),
    balanceNow,
    amount: parseBalance(job.meta?.amount),
    settledLooksLikeBurn,
  });

  if (!decision.abandon || !decision.fundsIntact) return null;
  return abandonExpiredJob(job, decision, balanceNow);
}

/**
 * Closes a job whose transaction has already settled on chain.
 *
 * A worker that dies after broadcasting leaves the job "running" forever, even
 * though the money moved and the hash is sitting right there in its meta. The
 * app then shows "Incomplete Send · PIN was started. Continue to finish so
 * funds are not stuck" — about a payment that completed minutes ago. Nagging
 * someone to rescue money that is not in danger is worse than saying nothing.
 *
 * The chain is the authority here, not the worker's own bookkeeping.
 */
async function closeIfSettledOnChain(job: AppKitJob): Promise<boolean> {
  // Only a send is one transaction. For a bridge a settled hash can be the
  // approve or the burn — the money has not arrived until the mint — and for
  // a deposit or swap it can be the approve alone.
  if (job.op !== "send") return false;
  const hash = job.meta?.txHash || job.meta?.lastTxHash;
  if (!hash || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return false;
  try {
    const { getPublicClient } = await import("./arc-wallet.js");
    const receipt = await getPublicClient().getTransactionReceipt({
      hash: hash as `0x${string}`,
    });
    if (receipt.status !== "success") return false;
  } catch {
    // Unmined or unreadable: leave it running so a later pass can decide.
    return false;
  }
  touchJob(job.id, { status: "succeeded" });
  const done = jobs.get(job.id);
  if (done) {
    finishJobActivity(done, "completed", hash, `${job.op} complete`);
  }
  console.log(`[app-kit] closed settled job ${job.id} (${hash.slice(0, 12)}…)`);
  return true;
}

/**
 * Finishes bridges people walked away from.
 *
 * The rule, set by the product owner: once the burn has landed, the person
 * has about 40 minutes to finish it themselves. After that the server submits
 * the destination mint from the ops wallet. CCTP pays the USDC to the
 * recipient fixed at burn time, so finishing someone else's bridge can only
 * deliver their own money to them.
 *
 * One attempt per bridge per call, with no long wait: on a serverless host
 * the function would be cut off mid-poll. An attestation that is not ready
 * yet is simply tried again on the next pass.
 *
 * The rule also says the person pays twice the gas the server spent. Nothing
 * is collected: the product owner waived it on testnet, and collecting from a
 * wallet that needs its owner's PIN is still to be decided. The figure is
 * recorded on the job so the decision can be made from real numbers.
 */
export async function completeAbandonedBridges(opts?: {
  onlyUserId?: string;
  now?: number;
}): Promise<{ checked: number; completed: number; waiting: number; errors: string[] }> {
  const nowMs = opts?.now ?? Date.now();
  const windowMs = bridgeAbandonWindowMs();
  if (jobs.size === 0) loadJobsFromDisk();
  const candidates = [...jobs.values()].filter(
    (j) =>
      j.op === "bridge" &&
      j.status === "running" &&
      !liveRunners.has(j.id) &&
      !bridgeCompletions.has(j.id) &&
      (!opts?.onlyUserId || j.userId === opts.onlyUserId),
  );
  const result = { checked: 0, completed: 0, waiting: 0, errors: [] as string[] };

  for (const job of candidates) {
    result.checked += 1;
    const destDomain = job.meta?.toChain
      ? APPKIT_CHAIN_TO_DOMAIN[job.meta.toChain]
      : undefined;
    const sourceDomain = job.meta?.fromChain
      ? APPKIT_CHAIN_TO_DOMAIN[job.meta.fromChain]
      : undefined;
    if (destDomain == null) continue;
    try {
      const burn = await findBurnMessage(job);
      // Nothing burned means nothing is between chains; the expired-PIN
      // logic in maybeAbandonExpiredJob handles those.
      if (!burn) continue;
      if (burn.destinationCaller && !ZERO_BYTES32.test(burn.destinationCaller)) {
        // Only the person's own wallet may submit this mint.
        patchJobMeta(job.id, {
          stage: "sent",
          recoverHint: "This transfer has to be finished from your wallet. Tap Continue and enter your PIN.",
        });
        continue;
      }

      let burnAtMs = job.meta?.burnAt ? Date.parse(job.meta.burnAt) : null;
      if (burnAtMs == null && sourceDomain != null) {
        burnAtMs = await readTxTimestampMs(sourceDomain, burn.hash);
        if (burnAtMs) patchJobMeta(job.id, { burnAt: new Date(burnAtMs).toISOString() });
      }
      if (
        !abandonedBridgeDue({
          burnAtMs,
          firstPinAtMs: job.meta?.firstPinAt ? Date.parse(job.meta.firstPinAt) : null,
          jobCreatedAtMs: Date.parse(job.createdAt),
          nowMs,
          windowMs,
        })
      ) {
        result.waiting += 1;
        continue;
      }

      const mint = await cctpCompleteBridge({
        burnTxHash: burn.hash,
        destinationDomain: destDomain,
        sourceDomain,
        timeoutMs: 8_000,
        pollMs: 4_000,
      });
      const alreadyMinted =
        !mint.ok && /nonce already used|already (been )?(used|received)/i.test(mint.error || "");
      if (mint.ok || alreadyMinted) {
        touchJob(job.id, { status: "succeeded", result: mint });
        patchJobMeta(job.id, {
          stage: "arrived",
          recoverHint: undefined,
          serverCompletedAt: new Date(nowMs).toISOString(),
          ...(mint.ok
            ? {
                lastTxHash: mint.mintTx,
                relay: bridgeRelayRecord({
                  gasCostWei: mint.gasCostWei,
                  nativeSymbol: mint.nativeSymbol,
                  nativeDecimals: mint.nativeDecimals,
                  deploymentEnv: config.deploymentEnv,
                }),
              }
            : {}),
        });
        const done = getAppKitJob(job.id);
        if (done) {
          finishJobActivity(
            done,
            "completed",
            mint.ok ? mint.mintTx : burn.hash,
            mint.ok ? `Arrived on ${mint.chain} · finished for you` : "Arrived",
          );
        }
        alertUser(job.userId, {
          kind: "bridge_arrived",
          title: "Your money arrived",
          body: `${job.meta?.amount ? `${job.meta.amount} USDC` : "Your money"} is on ${mint.ok ? mint.chain : "the other network"}. You left before it finished, so we finished it for you.`,
          jobId: job.id,
          ...(mint.ok ? { txHash: mint.mintTx } : {}),
        });
        if (mint.ok && config.deploymentEnv === "production") {
          console.warn(
            `[app-kit ${job.id.slice(0, 8)}] finished an abandoned bridge; the 2x gas charge is recorded but NOT collected — collection is not decided yet`,
          );
        }
        result.completed += 1;
        continue;
      }
      patchJobMeta(job.id, {
        stage: "sent",
        recoverHint:
          mint.status === "attested_mint_failed"
            ? "We couldn't finish this yet. We'll keep trying."
            : "Still confirming on the network. It will finish on its own.",
      });
      if (mint.status === "attested_mint_failed") {
        result.errors.push(`${job.id}: ${mint.error}`);
      } else {
        result.waiting += 1;
      }
    } catch (e) {
      result.errors.push(`${job.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/**
 * Least gas the ops wallet must hold on a destination for the server to be
 * able to finish a bridge there. Enough for a few mints, not a precise quote.
 */
const RELAY_GAS_FLOOR_WEI: Record<string, bigint> = {
  ETH: 500_000_000_000_000n, // 0.0005 ETH
  USDC: 50_000_000_000_000_000n, // 0.05 USDC (Arc native, 18 decimals)
};

const relayCache = new Map<number, { atMs: number; funded: boolean | null }>();
const RELAY_CACHE_MS = 2 * 60 * 1000;

/**
 * Whether the server could finish a bridge landing on `toChain`: true, false,
 * or null when the balance could not be read.
 *
 * The person's own wallet signs the destination mint in the normal flow; the
 * ops wallet only finishes bridges someone walked away from. So this never
 * takes a route away from anyone — every configured route stays offered, by
 * the product owner's decision. It exists to tell operators, loudly, that the
 * walk-away rescue for a destination has no gas.
 */
export async function bridgeRelayFunded(
  toChain: string | number,
): Promise<boolean | null> {
  let domain: number | undefined;
  try {
    domain = APPKIT_CHAIN_TO_DOMAIN[resolveAppKitChain(toChain)];
  } catch {
    return null;
  }
  if (domain == null) return null;
  const cached = relayCache.get(domain);
  if (cached && Date.now() - cached.atMs < RELAY_CACHE_MS) return cached.funded;
  const balance = await readOpsGasBalance(domain);
  const floor = balance ? RELAY_GAS_FLOOR_WEI[balance.symbol] : undefined;
  const funded = balance && floor != null ? balance.wei >= floor : null;
  relayCache.set(domain, { atMs: Date.now(), funded });
  return funded;
}

const relayWarnedAt = new Map<string, number>();

/**
 * Tells operators when a bridge starts towards a destination the ops wallet
 * cannot mint on, so they top it up before anyone walks away from one. At
 * most once an hour per destination. Never blocks or changes the bridge.
 */
export async function warnIfRelayUnfunded(toChain: string | number): Promise<void> {
  try {
    if ((await bridgeRelayFunded(toChain)) !== false) return;
    const key = String(toChain);
    const last = relayWarnedAt.get(key) ?? 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    relayWarnedAt.set(key, Date.now());
    console.warn(
      `!! [bridge] ops wallet has no gas on ${key}: a bridge someone abandons there cannot be finished by the server until it is topped up`,
    );
    for (const operator of config.auth.operatorUserIds) {
      alertUser(operator, {
        kind: "review_needed",
        title: "Top up the ops wallet",
        body: `A bridge to ${key} just started and the ops wallet has no gas there to finish it if it is abandoned.`,
      });
    }
  } catch {
    // A warning must never get in the way of the bridge itself.
  }
}

/** Per configured destination: can the server finish an abandoned bridge there? */
export async function bridgeRelayHealth(
  routes: string[],
): Promise<Record<string, boolean | null>> {
  const out: Record<string, boolean | null> = {};
  for (const route of routes) {
    const to = route.split(":")[1];
    if (to && !(to in out)) out[to] = await bridgeRelayFunded(to);
  }
  return out;
}

export async function reconcileStaleAppKitJobs(input: {
  userId: string;
  userToken?: string;
  jobId?: string;
}): Promise<{ jobs: AppKitJob[]; dismissed: DismissedAppKitJob[] }> {
  await reviveStrandedBridges(input.userId).catch((e) =>
    console.warn("[app-kit] revive stranded bridges:", e instanceof Error ? e.message : e),
  );
  // The person is back: finish anything of theirs past its window now rather
  // than waiting for the next scheduled pass.
  await completeAbandonedBridges({ onlyUserId: input.userId }).catch((e) =>
    console.warn("[app-kit] abandoned bridges:", e instanceof Error ? e.message : e),
  );
  await import("./gatewayTracker.js")
    .then((m) => m.runGatewayTracker({ onlyUserId: input.userId }))
    .catch((e) =>
      console.warn("[app-kit] gateway tracker:", e instanceof Error ? e.message : e),
    );
  const running = listAppKitJobsForUser(input.userId).filter((j) => {
    if (j.status !== "running") return false;
    if (input.jobId) return j.id === input.jobId;
    return true;
  });
  const dismissed: DismissedAppKitJob[] = [];
  for (const job of running) {
    // Settled work is finished work, whatever the worker managed to record.
    if (await closeIfSettledOnChain(job)) continue;
    if (await closeIfSourceMoved(job)) continue;
    const dropped = await maybeAbandonExpiredJob(job, {
      userToken: input.userToken,
    });
    if (dropped) dismissed.push(dropped);
  }
  // Only money that could be in motion is held. Anything whose PIN was
  // never entered moved nothing: kept out of sight while its PIN screen may
  // still be open, then dropped.
  const held: AppKitJob[] = [];
  for (const j of listAppKitJobsForUser(input.userId)) {
    if (j.status !== "running") continue;
    const created = Date.parse(j.createdAt);
    const decision = heldJobDecision({
      pinEntered: pinWasEntered(j.meta),
      live: liveRunners.has(j.id),
      jobAgeMs: Number.isFinite(created) ? Date.now() - created : 0,
    });
    if (decision === "show") {
      held.push(j);
      continue;
    }
    if (decision === "discard") {
      const dropped = await discardUnpinnedJob(j);
      if (dropped) dismissed.push(dropped);
      else held.push(j);
    }
  }
  return { jobs: held, dismissed };
}

/**
 * Drops a job no PIN was ever entered for. Before letting go it checks the
 * chain once — a PIN entered just before the app closed may not have been
 * reported — and keeps the job if a burn or a balance change says money did
 * move.
 */
async function discardUnpinnedJob(job: AppKitJob): Promise<DismissedAppKitJob | null> {
  if (job.op === "bridge") {
    const burn = await findBurnMessage(job).catch(() => null);
    if (burn) {
      patchJobMeta(job.id, { burnTxHash: burn.hash, firstPinAt: new Date().toISOString() });
      return null;
    }
  }
  const before = parseBalance(job.meta?.balanceBefore);
  const now = before != null ? await currentSourceBalance(job) : null;
  if (before != null && now != null && !fundsIntactFromSnapshot(before, now)) {
    return null;
  }
  cancelJobWaiters(job.id, NO_PIN_MESSAGE);
  touchJob(job.id, { status: "failed", error: NO_PIN_MESSAGE });
  patchJobMeta(job.id, {
    abandoned: true,
    fundsIntact: true,
    recoverHint: NO_PIN_MESSAGE,
  });
  const live = getAppKitJob(job.id);
  // A cancelled row is left out of the activity feed, so the attempt is
  // simply gone rather than listed as a failure.
  if (live) finishJobActivity(live, "cancelled", undefined, NO_PIN_MESSAGE);
  return {
    jobId: job.id,
    op: job.op,
    // Not a rescue — nothing was ever at risk, so the app shows no notice.
    fundsIntact: false,
    reason: "no_pin",
    message: NO_PIN_MESSAGE,
  };
}

export async function recoverAppKitJob(
  id: string,
  opts?: { userToken?: string },
) {
  const job = getAppKitJob(id);
  if (!job) return { ok: false as const, error: "Job not found" };
  if (job.status === "succeeded") {
    return { ok: true as const, live: false, recovered: "already_done", job };
  }
  const dropped = await maybeAbandonExpiredJob(job, opts);
  if (dropped?.fundsIntact) {
    return {
      ok: false as const,
      live: false,
      abandoned: true,
      fundsIntact: true,
      recovered: "expired_funds_intact",
      message: dropped.message,
      reason: dropped.reason,
      job: getAppKitJob(id),
    };
  }
  if (liveRunners.has(id)) {
    return {
      ok: true as const,
      live: true,
      job,
      hint: "PIN still required — open Continue to finish signing",
    };
  }
  // Collect every transaction hash Circle has for the job's challenges; the
  // burn is rarely the last one.
  if (opts?.userToken && job.challenges.length > 0) {
    const { waitForChallengeTxHash } = await import("./circle-ucw.js");
    for (const ch of job.challenges) {
      const r = await waitForChallengeTxHash({
        userToken: opts.userToken,
        challengeId: ch.challengeId,
        timeoutMs: 12_000,
      });
      if (r.ok && r.txHash && TX_HASH.test(r.txHash)) {
        const seen = jobs.get(id)?.meta?.txHashes ?? [];
        if (!seen.includes(r.txHash)) {
          patchJobMeta(id, { txHashes: [...seen, r.txHash] });
        }
      }
    }
  }
  const destDomain = job.meta?.toChain
    ? APPKIT_CHAIN_TO_DOMAIN[job.meta.toChain]
    : undefined;
  const sourceDomain = job.meta?.fromChain
    ? APPKIT_CHAIN_TO_DOMAIN[job.meta.fromChain]
    : undefined;
  if (job.op === "bridge" && destDomain != null) {
    const burn = await findBurnMessage(getAppKitJob(id) ?? job);
    if (burn) {
      if (burn.destinationCaller && !ZERO_BYTES32.test(burn.destinationCaller)) {
        const hint =
          "This transfer has to be finished from your wallet. Tap Continue and enter your PIN.";
        patchJobMeta(id, { stage: "sent", recoverHint: hint });
        return { ok: false as const, live: false, job: getAppKitJob(id), hint };
      }
      if (job.status !== "running") touchJob(id, { status: "running" });
      const completion = startBridgeCompletion({
        jobId: id,
        burnTxHash: burn.hash,
        sourceDomain,
        destinationDomain: destDomain,
      });
      // Arc attests in about half a second, so most bridges finish while the
      // person is still looking. Slower sources keep confirming in the
      // background and the app shows "Confirming".
      await Promise.race([
        completion,
        new Promise((r) => setTimeout(r, 25_000)),
      ]);
      const latest = getAppKitJob(id);
      if (latest?.status === "succeeded") {
        return {
          ok: true as const,
          live: false,
          recovered: "mint",
          job: latest,
        };
      }
      return {
        ok: false as const,
        live: false,
        recovered: "confirming",
        stage: latest ? jobStage(latest) : "confirming",
        job: latest,
        hint:
          latest?.meta?.recoverHint ||
          "Your money is on its way. It's confirming on the network.",
      };
    }
    const hint =
      "We couldn't find this transfer on the network yet. If your balance hasn't changed, nothing was sent.";
    patchJobMeta(id, { recoverHint: hint });
    return { ok: false as const, live: false, job: getAppKitJob(id), hint };
  }
  if (await closeIfSourceMoved(getAppKitJob(id) ?? job)) {
    return {
      ok: true as const,
      live: false,
      recovered: "settled",
      job: getAppKitJob(id),
    };
  }
  const hint =
    job.op === "swap"
      ? "Swap did not finish. If your balances are unchanged, retry from Exchange."
      : "The PIN worker stopped. If USDC is still in your source wallet, start the bridge again. If it left the wallet, Continue will try to mint.";
  patchJobMeta(id, { recoverHint: hint });
  return {
    ok: false as const,
    live: false,
    job: getAppKitJob(id),
    hint,
  };
}

export function startUcwSendJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  to: string;
  amount: string | number;
  token?: string;
  chain?: string;
  /** An already-open pending row to fill in, instead of adding a second. */
  activityId?: string;
}) {
  assertNoUncollectableFee("send", "/v1/circle/send");
  const amount = amountStr(input.amount);
  const token = (input.token || "USDC").toUpperCase();
  return startJob(
    input.userId,
    "send",
    async (jobId) => {
      const kit = getAppKit();
      const chain = resolveAppKitChain(input.chain || "Arc_Testnet");
      const adapter = await ucwAdapter({
        userToken: input.userToken,
        walletId: input.walletId,
        walletAddress: input.walletAddress,
        chains: [chain],
        jobId,
      });
      const result = await kit.send({
        from: { adapter, chain } as never,
        to: input.to,
        amount,
        token: token as never,
      });
      return serializeAppKitResult(result);
    },
    {
      amount,
      tokenIn: token,
      fromChain: resolveAppKitChain(input.chain || "Arc_Testnet"),
      label: `Send ${amount} ${token}`,
      walletAddress: input.walletAddress,
      activityId: input.activityId,
    },
  );
}

export function startUcwBridgeJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  fromChain: string | number;
  toChain: string | number;
  amount: string | number;
  toAddress?: string;
  token?: string;
}) {
  const fromChain = resolveAppKitChain(input.fromChain);
  const toChain = resolveAppKitChain(input.toChain);
  const amount = parseBridgeAmount(input.amount);
  // Product bridge is USDC/CCTP only. Reject same-chain.
  planBridgeHop({
    token: "USDC",
    fromChain,
    toChain,
  });
  assertMintRecipient(input.toAddress);
  return startJob(
    input.userId,
    "bridge",
    async (jobId) => {
      const kit = getAppKit();
      // Register BOTH chains on the PIN adapter so dest mint (e.g. Eth → Arc)
      // does not throw "chain not supported".
      const adapter = await ucwAdapter({
        userToken: input.userToken,
        walletId: input.walletId,
        walletAddress: input.walletAddress,
        chains: [fromChain, toChain],
        jobId,
      });
      // UCW adapters resolve the destination from the connected wallet.
      // Passing `address` throws: "Address should not be provided for
      // user-controlled adapters."
      // Do NOT pass `token` — BridgeParams is USDC-only and extra/wrong
      // values throw: Invalid literal value, expected "USDC".
      const result = await kit.bridge({
        from: { adapter, chain: fromChain } as never,
        to: { adapter, chain: toChain } as never,
        amount,
        config: withBridgeConfig(amount) as never,
      });
      return serializeAppKitResult(result);
    },
    {
      amount,
      fromChain,
      toChain,
      tokenIn: "USDC",
      tokenOut: "USDC",
      walletAddress: input.walletAddress,
      label: `USDC · ${fromChain} → ${toChain}`,
    },
  );
}

export async function quoteAppKitBridge(input: {
  fromChain: string | number;
  toChain: string | number;
  amount: string | number;
  token?: string;
}): Promise<{
  ok: true;
  bridgeable: true;
  route: "cctp";
  amountIn: string;
  tokenIn: string;
  amountOut: number;
  tokenOut: string;
  /** The Evabob fee, paid on top of the amount. */
  fee?: string;
  /** Circle's Fast Transfer fee, taken from the amount on the way. */
  networkFee: number;
  /** False when Circle's fee table could not be read and amountOut is the amount sent. */
  networkFeeKnown: boolean;
  note: string;
}> {
  const fromChain = resolveAppKitChain(input.fromChain);
  const toChain = resolveAppKitChain(input.toChain);
  const amount = parseBridgeAmount(input.amount);
  const hop = planBridgeHop({
    token: input.token,
    fromChain,
    toChain,
  });
  const usdcToBridge = Number(amount);
  // The Evabob fee is added on top (the wallet signs for amount + fee), so it
  // never reduces what lands. Circle's Fast Transfer fee is taken from the
  // amount itself; that is the only difference between sent and received.
  const fee = buildBridgeFee(String(usdcToBridge));
  const fromDomain = APPKIT_CHAIN_TO_DOMAIN[fromChain];
  const toDomain = APPKIT_CHAIN_TO_DOMAIN[toChain];
  const bps =
    fromDomain != null && toDomain != null
      ? await fastTransferFeeBps(fromDomain, toDomain)
      : null;
  const { fee: networkFee, landed } = landedAfterFastFee(usdcToBridge, bps ?? 0);
  return {
    ok: true,
    bridgeable: true,
    route: hop.kind,
    amountIn: amount,
    tokenIn: hop.tokenIn,
    amountOut: landed,
    tokenOut: hop.tokenOut,
    fee: fee?.value,
    networkFee,
    networkFeeKnown: bps != null,
    note: hopNote(hop),
  };
}

export function startUcwSwapJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  amountIn: string | number;
  tokenIn?: string;
  tokenOut?: string;
  chain?: string;
}) {
  const chain = resolveAppKitChain(input.chain || "Arc_Testnet");
  const amountIn = amountStr(input.amountIn);
  const tokenIn = (input.tokenIn || "USDC").toUpperCase();
  const tokenOut = (input.tokenOut || "EURC").toUpperCase();
  return startJob(
    input.userId,
    "swap",
    async (jobId) => {
      const kit = getAppKit();
      const adapter = await ucwAdapter({
        userToken: input.userToken,
        walletId: input.walletId,
        walletAddress: input.walletAddress,
        chains: [chain],
        jobId,
      });
      const result = await kit.swap({
        from: { adapter, chain } as never,
        tokenIn: tokenIn as never,
        tokenOut: tokenOut as never,
        amountIn,
        config: withSwapConfig() as never,
      });
      return serializeAppKitResult(result);
    },
    {
      amount: amountIn,
      tokenIn,
      tokenOut,
      fromChain: chain,
      walletAddress: input.walletAddress,
      label: `${tokenIn} → ${tokenOut}`,
    },
  );
}

export function startUcwDepositJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  amount: string | number;
  chain?: string;
}) {
  assertNoUncollectableFee("deposit", "/v1/circle/gateway/deposit");
  return startJob(input.userId, "deposit", async (jobId) => {
    const kit = getAppKit();
    const chain = resolveAppKitChain(input.chain || "Arc_Testnet");
    const amount = amountStr(input.amount);

    // Chain-scoped adapter: find/create the UCW on THIS chain. Never reuse
    // the session Arc walletId on Eth/Base — that throws
    // `Action "usdc.name" is not registered in this adapter`.
    const adapter = await ucwAdapter({
      userToken: input.userToken,
      chains: [chain],
      jobId,
      chainScoped: true,
    });
    // Deposit is USDC-only. The UCW /next adapter has no `usdc.name`, so
    // EIP-3009 `authorize` (the SDK default) fails on Eth/Base. `approve`
    // uses increaseAllowance + deposit instead.
    const result = await kit.unifiedBalance.deposit({
      from: { adapter, chain } as never,
      amount,
      allowanceStrategy: "approve",
    } as never);
    return serializeAppKitResult(result);
  });
}

export function startUcwSpendJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  amountIn: string | number;
  recipientAddress: string;
  toChain?: string;
  sourceChains?: string[];
}) {
  assertNoUncollectableFee("GA payment", "/v1/circle/gateway/pay");
  return startJob(input.userId, "spend", async (jobId) => {
    const kit = getAppKit();
    const toChain = resolveAppKitChain(input.toChain || "Arc_Testnet");
    const sourceChains = (input.sourceChains || ["Arc_Testnet"]).map((c) =>
      resolveAppKitChain(c),
    );
    const chains = evmAdapterChains([...sourceChains, toChain]);
    const amountIn = amountStr(input.amountIn);
    const adapter = await ucwAdapter({
      userToken: input.userToken,
      walletId: input.walletId,
      walletAddress: input.walletAddress,
      chains,
      jobId,
    });
    const result = await kit.unifiedBalance.spend({
      from: { adapter },
      amountIn,
      to: {
        adapter,
        chain: toChain,
        recipientAddress: input.recipientAddress,
      } as never,
    } as never);
    return serializeAppKitResult(result);
  });
}

export function startUcwComposeJob(input: {
  userId: string;
  userToken: string;
  walletId?: string;
  walletAddress?: string;
  spend?: {
    amountIn: string | number;
    recipientAddress?: string;
    toChain?: string;
  };
  swap?: {
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string | number;
    chain?: string;
  };
  bridge?: {
    fromChain?: string;
    toChain: string | number;
    toAddress?: string;
    amount?: string | number;
  };
}) {
  // A composed spend step carries no fee; bridge and swap steps on their own
  // routes do. Until compose collects it end to end, keep it closed.
  if (input.spend) assertNoUncollectableFee("composed GA payment", "/v1/circle/gateway/pay");
  return startJob(input.userId, "compose", async (jobId) => {
    const kit = getAppKit();
    const chainSet = new Set<string>(["Arc_Testnet"]);
    if (input.spend?.toChain) chainSet.add(resolveAppKitChain(input.spend.toChain));
    if (input.swap?.chain) chainSet.add(resolveAppKitChain(input.swap.chain));
    if (input.bridge?.fromChain)
      chainSet.add(resolveAppKitChain(input.bridge.fromChain));
    if (input.bridge?.toChain)
      chainSet.add(resolveAppKitChain(input.bridge.toChain));

    const adapter = await ucwAdapter({
      userToken: input.userToken,
      walletId: input.walletId,
      walletAddress: input.walletAddress,
      chains: evmAdapterChains([...chainSet].map((c) => resolveAppKitChain(c))),
      jobId,
    });

    const steps: Array<{ step: string; result: unknown }> = [];
    let workingAmount: string | undefined;

    if (input.spend) {
      const toChain = resolveAppKitChain(input.spend.toChain || "Arc_Testnet");
      const amountIn = amountStr(input.spend.amountIn);
      const recipient =
        input.spend.recipientAddress || input.walletAddress;
      if (!recipient) {
        throw new Error("spend.recipientAddress required for compose");
      }
      const spendResult = await kit.unifiedBalance.spend({
        from: { adapter },
        amountIn,
        to: {
          adapter,
          chain: toChain,
          recipientAddress: recipient,
        } as never,
      } as never);
      steps.push({
        step: "unifiedBalance.spend",
        result: serializeAppKitResult(spendResult),
      });
      workingAmount = amountIn;
    }

    if (input.swap) {
      const chain = resolveAppKitChain(input.swap.chain || "Arc_Testnet");
      const amountIn = amountStr(input.swap.amountIn ?? workingAmount ?? "0");
      const tokenIn = (input.swap.tokenIn || "USDC").toUpperCase();
      const tokenOut = (input.swap.tokenOut || "EURC").toUpperCase();
      const swapResult = await kit.swap({
        from: { adapter, chain } as never,
        tokenIn: tokenIn as never,
        tokenOut: tokenOut as never,
        amountIn,
        config: withSwapConfig() as never,
      });
      steps.push({ step: "swap", result: serializeAppKitResult(swapResult) });
      workingAmount = amountIn;
    }

    if (input.bridge) {
      const fromChain = resolveAppKitChain(
        input.bridge.fromChain || "Arc_Testnet",
      );
      const toChain = resolveAppKitChain(input.bridge.toChain);
      const amount = amountStr(input.bridge.amount ?? workingAmount ?? "0");
      assertMintRecipient(input.bridge.toAddress);
      const bridgeResult = await kit.bridge({
        from: { adapter, chain: fromChain } as never,
        to: { adapter, chain: toChain } as never,
        amount,
        config: withBridgeConfig(amount) as never,
      });
      steps.push({
        step: "bridge",
        result: serializeAppKitResult(bridgeResult),
      });
    }

    if (steps.length === 0) {
      throw new Error("compose requires at least one of: spend, swap, bridge");
    }

    return { steps, workingAmount };
  });
}
