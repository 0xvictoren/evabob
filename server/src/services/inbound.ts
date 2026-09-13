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

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Comfortably inside the RPC's range limit. */
const CHUNK_BLOCKS = 9_000n;

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
const MAX_BLOCKS_PER_SYNC = 90_000n;

/**
 * The public Arc RPC rate-limits chunked getLogs, answering -32005
 * "rate limit exceeded" when chunks arrive back to back. Pacing them and
 * retrying with backoff keeps a scan alive instead of losing the whole run to
 * one throttled request.
 */
const CHUNK_PAUSE_MS = 120;
const RATE_LIMIT_RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /rate limit|-32005|too many requests|429/i.test(text);
}

const TOKENS: Array<{ address: Address; symbol: string; decimals: number }> = [
  { address: config.arc.usdc as Address, symbol: "USDC", decimals: 6 },
  { address: config.arc.eurc as Address, symbol: "EURC", decimals: 6 },
];

export type InboundTransfer = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: Address;
  token: string;
  amount: number;
};

/**
 * How a sender is named in a receipt.
 *
 * A contact or registered handle if we know one, otherwise a shortened
 * address. The full address stays on the activity record for the details
 * view — it is only kept out of the sentence a person reads.
 */
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

    const logs = await transferLogsWithRetry(client, input.address, cursor, end);

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
      });
    }
    cursor = end + 1n;
    if (cursor <= input.toBlock) await sleep(CHUNK_PAUSE_MS);
  }
  return found;
}

/** Users with a scan already running, so refreshes cannot stack them up. */
const inFlight = new Set<string>();

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
    .then((r) => {
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

  const recorded: InboundTransfer[] = [];
  for (const t of transfers) {
    if (store.hasInboundActivity(t.txHash, t.logIndex)) continue;
    // A transfer from the user's own wallet is their own send looping back,
    // not money arriving.
    if (t.from.toLowerCase() === address.toLowerCase()) continue;

    // Written in the words a person uses, because this row is the receipt they
    // read. The raw address and hash are still on the record for the details
    // view; they just do not belong in the headline.
    const shown = Math.round(t.amount * 100) / 100;
    store.addActivity({
      userId: input.userId,
      kind: "receive",
      title: "Money received",
      description: `${shown} from ${short(t.from)}`,
      amountUsdc: t.token === "USDC" ? t.amount : 0,
      token: t.token,
      amountToken: t.amount,
      counterparty: t.from,
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
        title: "Money received",
        body: `${t.amount} ${t.token} arrived`,
        amountUsdc: t.token === "USDC" ? t.amount : undefined,
        token: t.token,
        counterparty: t.from,
        txHash: t.txHash,
      });
    }
  }

  // Only ever claim what was actually covered.
  store.setInboundScannedBlock(input.userId, Number(toBlock));
  // This function normally runs after its triggering response has returned,
  // so the global response flush cannot make these activity rows durable.
  await flushPrimaryStore();
  return { scanned: true, recorded, toBlock: Number(toBlock) };
}
