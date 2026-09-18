/**
 * Protected-transfer lifecycle: track pending holds + auto-refund after expiry.
 *
 * Two things had to change after three real transfers sat unrefunded for
 * months while this job ran hourly against an empty list.
 *
 * The tracking Map was in memory only, despite the comment promising a JSON
 * fallback, so every restart forgot every pending hold. If Mongo was not
 * connected when the transfer was created, the record was gone for good and
 * the contract kept the money with nobody watching. It is persisted now.
 *
 * More importantly, the sweep no longer trusts local bookkeeping at all: it
 * walks the contract's own transfers and refunds anything expired and still
 * pending. Losing a record must not be able to strand money again, and the
 * chain already knows the truth. `refund` pays the original sender and is
 * callable by anyone, so sweeping an untracked transfer is safe by
 * construction — it can only return money to where it came from.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dataPath } from "../utils/data-path.js";
import { paymentEscrowAbi } from "../abis/escrow.js";
import { config } from "../config.js";
import { store } from "../store/db.js";
import {
  mongoListExpiredPending,
  mongoReady,
  mongoSaveEscrow,
  mongoUpdateEscrow,
  type HeldPurpose,
  type ProtectedEscrowRecord,
} from "./mongo.js";
import {
  getDeployerAccount,
  getPublicClient,
  getWalletClient,
  arcTestnet,
} from "./arc-wallet.js";
import type { Address } from "viem";
import {
  flushPrimaryStore,
  markPrimaryStoreDirty,
  registerPrimaryStoreReloader,
} from "./primary-store.js";

/** JSON-backed fallback when Mongo is off. Survives restarts. */
const ESCROW_FILE = dataPath("protected-escrows.json");

function loadLocal(): Map<string, ProtectedEscrowRecord> {
  try {
    if (!existsSync(ESCROW_FILE)) return new Map();
    const rows = JSON.parse(
      readFileSync(ESCROW_FILE, "utf8"),
    ) as ProtectedEscrowRecord[];
    return new Map(rows.map((r) => [r.id, r]));
  } catch (e) {
    console.warn(
      "[escrow-job] could not read tracked escrows:",
      e instanceof Error ? e.message : e,
    );
    return new Map();
  }
}

const localEscrows = loadLocal();
registerPrimaryStoreReloader(() => {
  localEscrows.clear();
  for (const [id, row] of loadLocal()) localEscrows.set(id, row);
});

function saveLocal(): void {
  try {
    mkdirSync(dirname(ESCROW_FILE), { recursive: true });
    writeJsonAtomic(ESCROW_FILE, [...localEscrows.values()]);
    markPrimaryStoreDirty();
  } catch (e) {
    console.warn(
      "[escrow-job] could not persist tracked escrows:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * True when a record's transfer lives on the escrow contract this server is
 * configured for. Transfer ids restart at 1 on every deployment, so acting on
 * a record from an older contract against the current one would touch a
 * different person's hold. Records written before the contract address was
 * stored are treated as belonging to an older contract.
 */
export function isOnCurrentContract(record: ProtectedEscrowRecord): boolean {
  const current = (config.arc.paymentEscrow ?? "").toLowerCase();
  return Boolean(
    current &&
      record.contractAddress &&
      record.contractAddress.toLowerCase() === current,
  );
}

/** How a new hold reads in the payer's activity feed. */
function holdDescription(purpose: HeldPurpose | undefined, row: ProtectedEscrowRecord): string {
  if (purpose === "job" && row.holdLinkId) return "Set aside until your order arrives";
  if (purpose === "job") return "Held until the work arrives";
  if (purpose === "cooling_off") return "Sending in 10 minutes · you can cancel until then";
  return `Waiting for them to join · returns ${row.expiresAt.slice(0, 10)} if unclaimed`;
}

export function trackProtectedEscrow(
  input: Omit<ProtectedEscrowRecord, "id" | "status" | "createdAt" | "expiresAt"> & {
    id?: string;
    expiresInMs?: number;
    /** Platform fee charged in the same batch as the lock (USDC). */
    platformFee?: number;
  },
): ProtectedEscrowRecord & { activityId: string } {
  const now = Date.now();
  const expiresIn = input.expiresInMs ?? 3 * 24 * 60 * 60 * 1000;
  const row: ProtectedEscrowRecord = {
    id: input.id || randomUUID(),
    onChainTransferId: input.onChainTransferId,
    contractAddress: input.contractAddress ?? (config.arc.paymentEscrow || undefined),
    purpose: input.purpose ?? "claim_link",
    fromUserId: input.fromUserId,
    recipientKind: input.recipientKind,
    recipientId: input.recipientId,
    amountUsdc: input.amountUsdc,
    memo: input.memo,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresIn).toISOString(),
    createTx: input.createTx,
    ...(input.releaseAt ? { releaseAt: input.releaseAt } : {}),
    ...(input.holdLinkId ? { holdLinkId: input.holdLinkId } : {}),
  };
  localEscrows.set(row.id, row);
  saveLocal();
  void mongoSaveEscrow(row);

  const activity = store.addActivity({
    userId: input.fromUserId,
    kind: "send",
    title: input.recipientId,
    description: holdDescription(row.purpose, row),
    amountUsdc: -input.amountUsdc,
    counterparty: input.recipientId,
    txHash: input.createTx,
    mode: "escrow",
    status: "pending",
    ...(input.platformFee && input.platformFee > 0
      ? { platformFee: input.platformFee, platformFeeToken: "USDC" }
      : {}),
  });

  return { ...row, activityId: activity.id };
}

/** Every hold this server has recorded, on any contract, for history and reputation. */
export function listAllTracked(): ProtectedEscrowRecord[] {
  return [...localEscrows.values()];
}

/** Pending holds on the current contract — the only ones this server acts on. */
export function listLocalPending(): ProtectedEscrowRecord[] {
  return [...localEscrows.values()].filter(
    (e) => e.status === "pending" && isOnCurrentContract(e),
  );
}

/** Every tracked hold on the current contract, settled or not. */
export function listTrackedOnCurrentContract(): ProtectedEscrowRecord[] {
  return [...localEscrows.values()].filter(isOnCurrentContract);
}

/** The tracked hold behind an on-chain transfer id, if this server has one. */
export function findTrackedByTransferId(
  transferId: string,
): ProtectedEscrowRecord | undefined {
  return [...localEscrows.values()].find(
    (e) => e.onChainTransferId === transferId && isOnCurrentContract(e),
  );
}

/**
 * Applies a change to a tracked hold and persists it locally and in Mongo.
 * Returns the updated record, or undefined when there is no such record.
 */
export function updateTracked(
  id: string,
  patch: Partial<Omit<ProtectedEscrowRecord, "id">>,
): ProtectedEscrowRecord | undefined {
  const row = localEscrows.get(id);
  if (!row) return undefined;
  const next = { ...row, ...patch };
  localEscrows.set(id, next);
  saveLocal();
  void mongoUpdateEscrow(id, patch);
  return next;
}

/**
 * Marks a hold as claimed once the release has settled on chain.
 *
 * Without this the refund sweep would keep seeing it as pending; the contract
 * would reject the refund, but the job would log an error every hour forever.
 */
export function markTrackedClaimed(id: string, claimTx: string): void {
  const row = localEscrows.get(id);
  if (!row) return;
  row.status = "claimed";
  row.claimTx = claimTx;
  localEscrows.set(id, row);
  saveLocal();
  void mongoUpdateEscrow(id, { status: "claimed", claimTx });
}

async function refundOnChain(transferId: string): Promise<string | null> {
  if (!config.arc.paymentEscrow || !config.arc.privateKey) return null;
  try {
    const wallet = getWalletClient();
    const publicClient = getPublicClient();
    const account = getDeployerAccount();
    const hash = await wallet.writeContract({
      address: config.arc.paymentEscrow as Address,
      abi: paymentEscrowAbi,
      functionName: "refund",
      args: [BigInt(transferId)],
      account,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (e) {
    console.warn(
      "[escrow-job] on-chain refund failed",
      transferId,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/** Contract-side view of one transfer, enough to decide whether to refund. */
const TRANSFER_STATUS_PENDING = 1;

/**
 * Refunds every expired, still-pending transfer the contract holds.
 *
 * Independent of local records on purpose. Three transfers were stranded
 * because the server forgot them; the contract had not. Reading its own state
 * means a lost record costs nothing, and since `refund` only ever pays the
 * original sender, sweeping a transfer this server has no record of cannot
 * misdirect funds.
 */
async function sweepOnChainExpired(): Promise<{
  refunded: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let refunded = 0;
  const address = config.arc.paymentEscrow as Address | undefined;
  if (!address || !config.arc.privateKey) return { refunded, errors };

  try {
    const publicClient = getPublicClient();
    const next = (await publicClient.readContract({
      address,
      abi: paymentEscrowAbi,
      functionName: "nextTransferId",
    })) as bigint;

    const now = BigInt(Math.floor(Date.now() / 1000));
    for (let id = 1n; id < next; id++) {
      try {
        const t = (await publicClient.readContract({
          address,
          abi: paymentEscrowAbi,
          functionName: "transfers",
          args: [id],
        })) as readonly unknown[];
        const expiresAt = t[4] as bigint;
        // Index 5, not 6: V2 dropped the password hash from the struct.
        const status = Number(t[5]);
        if (status !== TRANSFER_STATUS_PENDING || expiresAt >= now) continue;

        const hash = await refundOnChain(id.toString());
        if (hash) {
          refunded += 1;
          console.log(`[escrow-job] swept expired transfer ${id}: ${hash}`);
        } else {
          errors.push(`transfer ${id}: refund did not complete`);
        }
      } catch (e) {
        errors.push(
          `transfer ${id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    errors.push(
      `sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { refunded, errors };
}

export async function processExpiredEscrows(): Promise<{
  checked: number;
  refunded: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let refunded = 0;

  const fromMongo = mongoReady() ? await mongoListExpiredPending() : [];
  const fromLocal = listLocalPending().filter(
    (e) => new Date(e.expiresAt).getTime() <= Date.now(),
  );
  const byId = new Map<string, ProtectedEscrowRecord>();
  // Only holds on the current contract: an id from an older deployment names
  // a different transfer here.
  for (const e of [...fromMongo, ...fromLocal]) {
    if (isOnCurrentContract(e)) byId.set(e.id, e);
  }
  const expired = [...byId.values()];

  for (const e of expired) {
    try {
      let refundTx: string | null = null;
      if (e.onChainTransferId) {
        refundTx = await refundOnChain(e.onChainTransferId);
        if (!refundTx) {
          // The record must say what the contract says. This used to mark the
          // hold refunded even when the refund reverted, so the app told the
          // payer their money was back while the contract still held it. Ask
          // the contract, and leave the record pending if it still is.
          const { readTransfer } = await import("./protectedEscrow.js");
          const onChain = await readTransfer(e.onChainTransferId).catch(() => null);
          if (!onChain || onChain.status === "Pending") {
            errors.push(`${e.id}: refund did not complete; still held`);
            continue;
          }
          if (onChain.status === "Claimed") {
            e.status = "claimed";
            localEscrows.set(e.id, e);
            saveLocal();
            await mongoUpdateEscrow(e.id, { status: "claimed" });
            continue;
          }
        }
      }
      e.status = "refunded";
      e.refundTx = refundTx || undefined;
      e.settledBy = "expired";
      e.settledAt = new Date().toISOString();
      localEscrows.set(e.id, e);
      saveLocal();
      await mongoUpdateEscrow(e.id, {
        status: "refunded",
        refundTx: e.refundTx,
        settledBy: e.settledBy,
        settledAt: e.settledAt,
      });

      store.addActivity({
        userId: e.fromUserId,
        kind: "system",
        title: "Money returned",
        description:
          e.purpose === "job"
            ? `${e.amountUsdc} USDC held for ${e.recipientId} came back to you`
            : `${e.amountUsdc} USDC came back — ${e.recipientId} didn't claim it`,
        amountUsdc: e.amountUsdc,
        counterparty: e.recipientId,
        txHash: e.refundTx,
      });
      refunded += 1;
    } catch (err) {
      errors.push(
        `${e.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Then catch anything the records missed. Runs after the tracked pass so a
  // transfer with a record is refunded with its activity row attached, and
  // only genuinely orphaned ones are swept blind.
  const swept = await sweepOnChainExpired();
  refunded += swept.refunded;
  errors.push(...swept.errors);

  // This job runs outside a request, so no response middleware can flush it.
  await flushPrimaryStore();

  return { checked: expired.length, refunded, errors };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Run refund sweep every hour (and once shortly after boot). */
export function startEscrowRefundJob() {
  const run = () => {
    processExpiredEscrows()
      .then((r) => {
        if (r.checked > 0) {
          console.log(
            `[escrow-job] checked=${r.checked} refunded=${r.refunded}`,
          );
        }
      })
      .catch((e) => console.warn("[escrow-job]", e));
  };
  setTimeout(run, 15_000);
  timer = setInterval(run, 60 * 60 * 1000);
}

export function stopEscrowRefundJob() {
  if (timer) clearInterval(timer);
  timer = null;
}
