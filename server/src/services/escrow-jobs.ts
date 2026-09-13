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
  type ProtectedEscrowRecord,
} from "./mongo.js";
import {
  getDeployerAccount,
  getPublicClient,
  getWalletClient,
  arcTestnet,
} from "./arc-wallet.js";
import type { Address } from "viem";
import { flushPrimaryStore, markPrimaryStoreDirty } from "./primary-store.js";

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

export function trackProtectedEscrow(
  input: Omit<ProtectedEscrowRecord, "id" | "status" | "createdAt" | "expiresAt"> & {
    id?: string;
    expiresInMs?: number;
  },
): ProtectedEscrowRecord & { activityId: string } {
  const now = Date.now();
  const expiresIn = input.expiresInMs ?? 3 * 24 * 60 * 60 * 1000;
  const row: ProtectedEscrowRecord = {
    id: input.id || randomUUID(),
    onChainTransferId: input.onChainTransferId,
    fromUserId: input.fromUserId,
    recipientKind: input.recipientKind,
    recipientId: input.recipientId,
    amountUsdc: input.amountUsdc,
    memo: input.memo,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresIn).toISOString(),
    createTx: input.createTx,
  };
  localEscrows.set(row.id, row);
  saveLocal();
  void mongoSaveEscrow(row);

  const activity = store.addActivity({
    userId: input.fromUserId,
    kind: "send",
    title: input.recipientId,
    description: `Protected transfer · claim by ${row.expiresAt.slice(0, 10)}`,
    amountUsdc: -input.amountUsdc,
    counterparty: input.recipientId,
    txHash: input.createTx,
    mode: "escrow",
    status: "pending",
  });

  return { ...row, activityId: activity.id };
}

export function listLocalPending(): ProtectedEscrowRecord[] {
  return [...localEscrows.values()].filter((e) => e.status === "pending");
}

/** The tracked hold behind an on-chain transfer id, if this server has one. */
export function findTrackedByTransferId(
  transferId: string,
): ProtectedEscrowRecord | undefined {
  return [...localEscrows.values()].find(
    (e) => e.onChainTransferId === transferId,
  );
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
  for (const e of [...fromMongo, ...fromLocal]) byId.set(e.id, e);
  const expired = [...byId.values()];

  for (const e of expired) {
    try {
      let refundTx: string | null = null;
      if (e.onChainTransferId) {
        refundTx = await refundOnChain(e.onChainTransferId);
      }
      e.status = "refunded";
      e.refundTx = refundTx || undefined;
      localEscrows.set(e.id, e);
      saveLocal();
      await mongoUpdateEscrow(e.id, {
        status: "refunded",
        refundTx: e.refundTx,
      });

      store.addActivity({
        userId: e.fromUserId,
        kind: "system",
        title: "Protected transfer refunded",
        description: `${e.amountUsdc} USDC returned — unclaimed by ${e.recipientId}`,
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
