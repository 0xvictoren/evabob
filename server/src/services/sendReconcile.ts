/**
 * Finishes sends that landed on chain but were never confirmed.
 *
 * A send's activity row starts as a pending draft and becomes a receipt only
 * when the app reports the transaction hash back (confirm-activity). That
 * report is a single call made right after the PIN. If it fails — the hash
 * was not ready yet, the app was closed, the request timed out — the money
 * has still moved, but the sender's row stays "pending" forever and the
 * person paid never gets a receipt that names the sender.
 *
 * The chain already knows the truth, so this asks it: for each stale pending
 * send, find the Transfer from the sender's wallet to the payee for exactly
 * that amount, shortly after the row was opened, and confirm with that hash
 * through the same verification the app's own report uses. A draft whose
 * transfer never appeared within the hour did not go through, and is marked
 * so rather than left looking like it is still on its way.
 */

import { parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { store, type ActivityItem } from "../store/db.js";
import { getPublicClient } from "./arc-wallet.js";
import { confirmPaymentActivity, recordPeerReceipt } from "./confirm-payment.js";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Give the app's own confirmation a moment before second-guessing it. */
const MIN_AGE_MS = 45_000;
/** Older drafts are not worth a chain search. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after the draft opened its transfer can still land. */
const LANDING_WINDOW_MS = 30 * 60 * 1000;
/** A draft with no transfer after this long did not go through. */
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
/** One pass per person per this long; opening Activity repeatedly is free. */
const THROTTLE_MS = 30_000;

const lastRun = new Map<string, number>();

function tokenAsset(token: string | undefined) {
  if (token === "EURC") return { address: config.arc.eurc as Address, decimals: 6 };
  if (token === "CIRBTC") return { address: config.arc.cirbtc as Address, decimals: 8 };
  if (!token || token === "USDC") return { address: config.arc.usdc as Address, decimals: 6 };
  return null;
}

function isStaleDraft(a: ActivityItem, now: number): boolean {
  if (a.kind !== "send" || a.status !== "pending" || a.settlementVerified) return false;
  if (a.mode !== "direct" && a.mode !== "direct_user") return false;
  if (a.batchId) return false;
  if (!a.counterparty || !/^0x[a-fA-F0-9]{40}$/.test(a.counterparty)) return false;
  const age = now - Date.parse(a.createdAt);
  return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
}

type BlockClock = { head: bigint; headTime: number; secondsPerBlock: number };

async function blockClock(client: ReturnType<typeof getPublicClient>): Promise<BlockClock> {
  const head = await client.getBlock();
  const back = head.number > 20_000n ? 20_000n : head.number;
  const past = await client.getBlock({ blockNumber: head.number - back });
  const span = Number(head.timestamp - past.timestamp);
  return {
    head: head.number,
    headTime: Number(head.timestamp),
    secondsPerBlock: back > 0n && span > 0 ? span / Number(back) : 0.5,
  };
}

/** The block near a moment, with room either side for an uneven block rate. */
function blockNear(clock: BlockClock, ms: number, margin: bigint): bigint {
  const secondsAgo = clock.headTime - ms / 1000;
  const n = clock.head - BigInt(Math.floor(secondsAgo / clock.secondsPerBlock)) + margin;
  if (n < 0n) return 0n;
  return n > clock.head ? clock.head : n;
}

/**
 * Confirms, or closes, one person's stale pending sends. Returns how many
 * rows changed. Never throws: a failed chain read leaves rows as they were.
 */
export async function reconcilePendingSends(userId: string, now = Date.now()): Promise<number> {
  const last = lastRun.get(userId) ?? 0;
  if (now - last < THROTTLE_MS) return 0;
  lastRun.set(userId, now);

  const sender = store.getUser(userId)?.evmAddress;
  if (!sender || !/^0x[a-fA-F0-9]{40}$/.test(sender)) return 0;
  const drafts = store.listActivity(userId, 200).filter((a) => isStaleDraft(a, now));
  if (drafts.length === 0) return 0;

  const client = getPublicClient();
  let clock: BlockClock;
  try {
    clock = await blockClock(client);
  } catch {
    return 0;
  }

  let changed = 0;
  for (const row of drafts) {
    try {
      if (row.txHash && /^0x[a-fA-F0-9]{64}$/.test(row.txHash)) {
        if (await confirmWith(userId, row, row.txHash)) {
          changed += 1;
          continue;
        }
      }
      const asset = tokenAsset(row.token);
      const amount = row.amountToken ?? Math.abs(row.amountUsdc);
      if (!asset || !Number.isFinite(amount) || amount <= 0) continue;
      const units = parseUnits(amount.toFixed(asset.decimals), asset.decimals);
      const opened = Date.parse(row.createdAt);
      const fromBlock = blockNear(clock, opened - 60_000, -2_000n);
      const toBlock = blockNear(clock, opened + LANDING_WINDOW_MS, 2_000n);
      const logs = await client.getLogs({
        address: asset.address,
        event: TRANSFER,
        args: { from: sender as Address, to: row.counterparty as Address },
        fromBlock,
        toBlock,
      });
      let confirmed = false;
      for (const log of logs) {
        if (log.args.value !== units || !log.transactionHash) continue;
        if (store.isPaymentEvidenceUsed(userId, log.transactionHash, row.id)) continue;
        if (await confirmWith(userId, row, log.transactionHash)) {
          confirmed = true;
          break;
        }
      }
      if (confirmed) {
        changed += 1;
      } else if (
        now - opened > GIVE_UP_AFTER_MS &&
        toBlock < clock.head
      ) {
        // The whole window it could have landed in has been searched.
        store.updateActivity(row.id, {
          status: "failed",
          description: "Did not go through. Nothing left your wallet.",
        });
        changed += 1;
      }
    } catch (e) {
      console.warn(
        "[send-reconcile]",
        row.id,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return changed;
}

async function confirmWith(userId: string, row: ActivityItem, hash: string): Promise<boolean> {
  try {
    const out = await confirmPaymentActivity(userId, row.id, hash as Hex);
    if (out.newlyVerified) recordPeerReceipt(out.row, hash);
    return true;
  } catch {
    return false;
  }
}
