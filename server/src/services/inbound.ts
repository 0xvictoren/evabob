/**
 * Inbound transfer detection.
 *
 * Receiving was previously only an address on a screen: nothing watched the
 * chain, so USDC sent from outside the app never appeared. Activity showed 21
 * "receive" rows and every one of the real ones had no transaction hash,
 * because they were written by in-app flows rather than observed on chain.
 *
 * This scans Arc for ERC-20 Transfer events crediting a user's wallet and
 * turns each into an activity row.
 *
 * Two properties of Arc shape the design. Blocks are about half a second, so
 * a day is roughly 169,000 blocks; and the public RPC rejects a getLogs range
 * of 100,000 blocks while serving 10,000 happily. Scanning is therefore
 * chunked, and each wallet carries a watermark so a scan only covers new
 * ground.
 */

import { formatUnits, parseAbiItem, type Address } from "viem";
import { config } from "../config.js";
import { getPublicClient } from "./arc-wallet.js";
import { store } from "../store/db.js";
import { alertUser } from "./notifyUser.js";
import { flushPrimaryStore } from "./primary-store.js";
import { memoForTransfer } from "./memo.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * Blocks per log query. Small, because the public Arc RPC answers larger
 * queries with "Request exceeds defined limit" when it is under load; a node
 * that says outright the range is too large gets it halved (`logsInRange`).
 */
const CHUNK_BLOCKS = 1_000n;

/**
 * How far back to look the first time a wallet is scanned. About four hours
 * of Arc blocks — enough to catch a deposit made while onboarding, without
 * walking the chain back to genesis for every new user.
 */
const FIRST_SCAN_LOOKBACK = 30_000n;

/**
 * Overlap re-scanned on every run. A credit near the tip could otherwise be
 * missed if the chain reorganises just after it was read; `hasInboundActivity`
 * makes the repeat harmless.
 */
const REORG_SAFETY_BLOCKS = 200n;

/**
 * How recent a transfer must be to be worth a notification.
 *
 * The scanner records history as well as news. A first scan, or one after the
 * app has been closed a while, can find a dozen transfers at once — and every
 * one of them used to raise its own notification, so catching up on the past
 * arrived as a burst of alerts about money that landed hours ago.
 *
 * Anything older than this is still recorded; it just does not interrupt
 * anyone. Arc blocks are about half a second, so this is roughly fifteen
 * minutes.
 */
const ALERT_WINDOW_BLOCKS = 1_800n;

/** Ceiling on one sync so a long-idle wallet cannot stall a balance refresh. */
const MAX_BLOCKS_PER_SYNC = 30_000n;

/**
 * The public Arc RPC rate-limits chunked getLogs, answering -32005
 * "rate limit exceeded" when chunks arrive back to back. Pacing them and
 * retrying with backoff keeps a scan alive instead of losing the whole run to
 * one throttled request.
 */
const CHUNK_PAUSE_MS = 120;
const RATE_LIMIT_RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The RPC is pushing back on how much we ask of it. The public Arc RPC says
 * "Request exceeds defined limit" (code -32005) when its quota is used up —
 * for every range, however small — so this is backed off, never split.
 */
export function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /rate limit|-32005|too many requests|429|exceeds defined limit/i.test(text);
}

/**
 * Where Arc reports a native USDC movement: a Transfer event from this system
 * address, in 18 decimals. A plain "send" from another wallet emits only this
 * one — it was never watched, so money sent into Evabob that way was never
 * recorded. A USDC token transfer emits both this and the token's own event,
 * so the pair is collapsed to one (see `pairNativeWithToken`).
 */
export const ARC_NATIVE_TRANSFER_SOURCE = "0xfffffffffffffffffffffffffffffffffffffffe" as Address;

const TOKENS: Array<{ address: Address; symbol: string; decimals: number }> = [
  { address: config.arc.usdc as Address, symbol: "USDC", decimals: 6 },
  { address: config.arc.eurc as Address, symbol: "EURC", decimals: 6 },
  { address: config.arc.cirbtc as Address, symbol: "CIRBTC", decimals: 8 },
  { address: ARC_NATIVE_TRANSFER_SOURCE, symbol: "USDC", decimals: 18 },
];

export type InboundTransfer = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: Address;
  token: string;
  amount: number;
  /** Base units, for matching the transfer's exact calldata to a memo. */
  units: bigint;
  tokenAddress: Address;
};

/**
 * The memo a sender attached to this transfer, read from its receipt.
 *
 * Best-effort by design: a receipt the RPC will not serve right now costs the
 * row its memo, never the row itself.
 */
async function inboundMemo(
  client: ReturnType<typeof getPublicClient>,
  t: InboundTransfer,
  to: string,
): Promise<string | undefined> {
  try {
    const receipt = await client.getTransactionReceipt({
      hash: t.txHash as `0x${string}`,
    });
    return memoForTransfer(receipt.logs, {
      token: t.tokenAddress,
      from: t.from,
      to,
      units: t.units,
    });
  } catch {
    return undefined;
  }
}

/**
 * How a sender is named in a receipt.
 *
 * A contact or registered handle if we know one, otherwise a shortened
 * address. The full address stays on the activity record for the details
 * view — it is only kept out of the sentence a person reads.
 */
/**
 * Who sent a transfer, as the receipt names them.
 *
 * A wallet that belongs to an Evabob account is shown by its @handle. Money
 * from anywhere else — MetaMask, an exchange, another app — is "Unknown":
 * the name is the only thing missing, and the sending address, network,
 * amount and hash all stay on the record.
 */
export function inboundSender(from: string): { label: string; userId?: string } {
  const u = store.findUserByRecipient(from);
  if (u?.handle) return { label: `@${u.handle.toLowerCase()}`, userId: u.id };
  return { label: "Unknown" };
}

function short(address: string): string {
  const known =
    store.findUserByRecipient?.(address) ?? undefined;
  const handle = (known as { handle?: string } | undefined)?.handle;
  if (handle) return `@${handle}`;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
function tokenFor(address: string) {
  return TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/** One chunk of Transfer logs, retried when the RPC throttles us. */
async function transferLogsWithRetry(
  client: ReturnType<typeof getPublicClient>,
  to: Address,
  fromBlock: bigint,
  toBlock: bigint,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.getLogs({
        address: TOKENS.map((t) => t.address),
        event: TRANSFER_EVENT,
        args: { to },
        fromBlock,
        toBlock,
      });
    } catch (e) {
      if (!isRateLimited(e) || attempt >= RATE_LIMIT_RETRIES) throw e;
      await sleep(400 * 2 ** attempt); // 0.4s, 0.8s, 1.6s, 3.2s
    }
  }
}

/**
 * Drops the native-USDC twin of a USDC token transfer. Pure.
 *
 * Arc emits two Transfer events for one token transfer — the token's (6
 * decimals) and the native system's (18 decimals) — and only the native one
 * for a plain send. Keeping every token event plus the native events that
 * have no token twin in the same transaction counts each movement once.
 */
export function pairNativeWithToken(found: InboundTransfer[]): InboundTransfer[] {
  const native = ARC_NATIVE_TRANSFER_SOURCE.toLowerCase();
  const tokenTwins = new Set(
    found
      .filter((t) => t.token === "USDC" && t.tokenAddress.toLowerCase() !== native)
      .map((t) => `${t.txHash.toLowerCase()}|${t.from.toLowerCase()}|${t.units}`),
  );
  return found.filter((t) => {
    if (t.tokenAddress.toLowerCase() !== native) return true;
    // 18-decimal native units to the token's 6.
    const asToken = t.units / 1_000_000_000_000n;
    return !tokenTwins.has(`${t.txHash.toLowerCase()}|${t.from.toLowerCase()}|${asToken}`);
  });
}

/** The node refused the range as too large, as opposed to failing. */
export function isRangeTooLarge(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /block range|range too large|too many (?:results|logs)|query returned more than/i.test(text) &&
    !isRateLimited(e);
}

/** Logs for a range, halving it for as long as the node says it is too large. */
async function logsInRange(
  client: ReturnType<typeof getPublicClient>,
  to: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Awaited<ReturnType<typeof transferLogsWithRetry>>> {
  try {
    return await transferLogsWithRetry(client, to, fromBlock, toBlock);
  } catch (e) {
    if (!isRangeTooLarge(e) || toBlock <= fromBlock) throw e;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const left = await logsInRange(client, to, fromBlock, mid);
    await sleep(CHUNK_PAUSE_MS);
    const right = await logsInRange(client, to, mid + 1n, toBlock);
    return [...left, ...right];
  }
}

/** Reads Transfer events crediting `address`, in RPC-sized chunks. */
export async function scanInbound(input: {
  address: Address;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<InboundTransfer[]> {
  const client = getPublicClient();
  const found: InboundTransfer[] = [];
  let cursor = input.fromBlock;

  while (cursor <= input.toBlock) {
    const end =
      cursor + CHUNK_BLOCKS > input.toBlock ? input.toBlock : cursor + CHUNK_BLOCKS;

    const logs = await logsInRange(client, input.address, cursor, end);

    for (const log of logs) {
      const token = tokenFor(log.address);
      if (!token || log.args.value == null) continue;
      found.push({
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        blockNumber: Number(log.blockNumber),
        from: log.args.from as Address,
        token: token.symbol,
        amount: Number(formatUnits(log.args.value, token.decimals)),
        units: log.args.value,
        tokenAddress: token.address,
      });
    }
    cursor = end + 1n;
    if (cursor <= input.toBlock) await sleep(CHUNK_PAUSE_MS);
  }
  return pairNativeWithToken(found);
}

/**
 * Records transfers found by a scan, once each: skips anything already
 * recorded, the wallet's own money, and payments another Evabob user's receipt
 * already covers. Announces only ones recent enough to be news.
 */
async function recordInboundTransfers(input: {
  userId: string;
  address: string;
  transfers: InboundTransfer[];
  head: bigint;
}): Promise<InboundTransfer[]> {
  const client = getPublicClient();
  const { address, head } = input;
  const recorded: InboundTransfer[] = [];
  for (const t of input.transfers) {
    if (store.hasInboundActivity(t.txHash, t.logIndex)) continue;
    // A transfer from the user's own wallet is their own send looping back,
    // not money arriving.
    if (t.from.toLowerCase() === address.toLowerCase()) continue;
    // Their own bridge, GA payment or released hold, already recorded.
    if (store.hasActivityWithTx(input.userId, t.txHash)) continue;
    // Paid by another Evabob user: their verified send already wrote this
    // receipt, memo and all.
    if (
      store.hasReceiptForTransfer({
        userId: input.userId,
        txHash: t.txHash,
        token: t.token,
        amount: t.amount,
      })
    ) {
      continue;
    }

    const memo = await inboundMemo(client, t, address);

    // Written in the words a person uses, because this row is the receipt they
    // read. The raw address and hash are still on the record for the details
    // view; they just do not belong in the headline.
    const shown = (Math.round(t.amount * 100) / 100).toFixed(2);
    const who = inboundSender(t.from);
    store.addActivity({
      ...(memo ? { memo, memoOnchain: true } : {}),
      userId: input.userId,
      kind: "receive",
      title: "Money received",
      description:
        who.label === "Unknown"
          ? `${shown} from Unknown (${short(t.from)})`
          : `${shown} from ${who.label}`,
      amountUsdc: t.token === "USDC" ? t.amount : 0,
      token: t.token,
      amountToken: t.amount,
      counterparty: who.label,
      sender: t.from,
      receiver: address,
      txHash: t.txHash,
      logIndex: t.logIndex,
      mode: "onchain_inbound",
      status: "completed",
    });
    recorded.push(t);

    // The moment worth telling someone about. Until now this only wrote a row
    // and waited for the next manual refresh to reveal it.
    if (head - BigInt(t.blockNumber) <= ALERT_WINDOW_BLOCKS) {
      alertUser(input.userId, {
        kind: "money_in",
        moneyIn: true,
        title: "Money received",
        body:
          who.label === "Unknown"
            ? `${shown} ${t.token} arrived`
            : `${who.label} sent you ${shown} ${t.token}`,
        amountUsdc: t.token === "USDC" ? t.amount : undefined,
        token: t.token,
        counterparty: who.label,
        txHash: t.txHash,
      });
    }
  }

  return recorded;
}

/**
 * One-time look back for native USDC sends the scanner used to miss.
 *
 * Plain sends into Arc (MetaMask's "send", faucets) emit only the native
 * system event, which was never watched, and each wallet's scan mark had
 * already moved past them. This walks back over the last four days once per
 * wallet, a slice per call, and records what it finds without announcing it.
 */
const BACKFILL_WINDOW_BLOCKS = 700_000n; // about four days of Arc blocks
// Small slices: the public RPC takes about a thousand blocks per query and
// rate-limits bursts, and this runs for several wallets every minute.
const BACKFILL_SLICE_BLOCKS = 5_000n;

export async function backfillNativeInbound(input: {
  userId: string;
  address: string;
}): Promise<{ done: boolean; recorded: number }> {
  const user = store.getUser(input.userId);
  if (!user || user.inboundNativeBackfill?.done) return { done: true, recorded: 0 };
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  const state = user.inboundNativeBackfill ?? {
    // Everything after the scan mark is covered by the normal scan, which now
    // reads native sends too.
    next: String(user.inboundScannedBlock ?? Number(head)),
    floor: String(head > BACKFILL_WINDOW_BLOCKS ? head - BACKFILL_WINDOW_BLOCKS : 0n),
    done: false,
  };
  const next = BigInt(state.next);
  const floor = BigInt(state.floor);
  if (next <= floor) {
    store.setInboundNativeBackfill(input.userId, { ...state, done: true });
    return { done: true, recorded: 0 };
  }
  const from = next - BACKFILL_SLICE_BLOCKS > floor ? next - BACKFILL_SLICE_BLOCKS : floor;
  const transfers = await scanInbound({
    address: input.address as Address,
    fromBlock: from,
    toBlock: next,
  });
  const recorded = await recordInboundTransfers({
    userId: input.userId,
    address: input.address,
    transfers,
    head,
  });
  const done = from <= floor;
  store.setInboundNativeBackfill(input.userId, {
    next: String(from > 0n ? from - 1n : 0n),
    floor: state.floor,
    done,
  });
  if (recorded.length) await flushPrimaryStore();
  return { done, recorded: recorded.length };
}

/** Users with a scan already running, so refreshes cannot stack them up. */
const inFlight = new Set<string>();

/**
 * Takes the per-user scan lock; false when a scan is already running. Shared
 * with the tick's sweep, so the two can never record the same payment twice.
 */
export function claimInboundScan(userId: string): boolean {
  if (inFlight.has(userId)) return false;
  inFlight.add(userId);
  return true;
}

export function releaseInboundScan(userId: string): void {
  inFlight.delete(userId);
}

/**
 * Starts a scan without making the caller wait for it.
 *
 * Balance refresh is the natural moment to look for new deposits, but a
 * catch-up scan can take seconds and the balance response should not be held
 * up by it. Anything found lands in activity, which the app fetches straight
 * after. A failure here is logged and dropped: not noticing a deposit yet is
 * an inconvenience, failing the balance call is not.
 */
export function syncInboundInBackground(input: {
  userId: string;
  address: string;
}): void {
  if (inFlight.has(input.userId)) return;
  inFlight.add(input.userId);
  void syncInboundForUser(input)
    .then(async (r) => {
      const { syncOtherChainsForUser } = await import("./inboundChains.js");
      await syncOtherChainsForUser(input).catch((e) =>
        console.warn("[inbound] other networks:", e instanceof Error ? e.message.split("\n")[0] : e),
      );
      if (r.recorded.length > 0) {
        console.log(
          `[inbound] ${input.userId}: recorded ${r.recorded.length} transfer(s) up to block ${r.toBlock}`,
        );
      }
    })
    .catch((e) => {
      console.warn(
        "[inbound] scan failed:",
        e instanceof Error ? e.message.split("\n")[0] : e,
      );
    })
    .finally(() => inFlight.delete(input.userId));
}

/**
 * Brings one user's inbound history up to date and records anything new.
 *
 * Safe to call often: it resumes from the wallet's watermark, ignores
 * transfers it has already recorded, and never rewinds the watermark.
 */
export async function syncInboundForUser(input: {
  userId: string;
  address: string;
}): Promise<{ scanned: boolean; recorded: InboundTransfer[]; toBlock: number }> {
  const address = input.address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { scanned: false, recorded: [], toBlock: 0 };
  }

  const client = getPublicClient();
  const head = await client.getBlockNumber();

  const watermark = store.getUser(input.userId)?.inboundScannedBlock;
  let fromBlock =
    watermark && watermark > 0
      ? BigInt(watermark) - REORG_SAFETY_BLOCKS
      : head - FIRST_SCAN_LOOKBACK;
  if (fromBlock < 0n) fromBlock = 0n;
  if (fromBlock > head) return { scanned: false, recorded: [], toBlock: Number(head) };

  // The cap moves the END of the window, not the start. Clamping the start
  // instead would scan only the most recent blocks and then set the watermark
  // to the head, silently skipping everything in between — a wallet idle for
  // longer than the cap would lose that inbound history for good. Advancing
  // in bounded steps means a long-idle wallet simply catches up over several
  // syncs without ever stepping over a block.
  const toBlock =
    head - fromBlock > MAX_BLOCKS_PER_SYNC
      ? fromBlock + MAX_BLOCKS_PER_SYNC
      : head;

  const transfers = await scanInbound({
    address: address as Address,
    fromBlock,
    toBlock,
  });

  const recorded = await recordInboundTransfers({
    userId: input.userId,
    address,
    transfers,
    head,
  });

  // Only ever claim what was actually covered.
  store.setInboundScannedBlock(input.userId, Number(toBlock));
  // This function normally runs after its triggering response has returned,
  // so the global response flush cannot make these activity rows durable.
  await flushPrimaryStore();
  return { scanned: true, recorded, toBlock: Number(toBlock) };
}
