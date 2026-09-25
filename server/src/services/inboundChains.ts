/**
 * Money arriving on the other networks an Evabob wallet lives on.
 *
 * Every Evabob wallet has the same address on Arc, Ethereum Sepolia and Base
 * Sepolia, and the app shows balances on all three — but only Arc was ever
 * watched, so USDC or EURC sent to the wallet on Base or Ethereum (from a
 * faucet, an exchange, another wallet) never appeared in Activity and nobody
 * was told. This scans those networks the same way `inbound.ts` scans Arc,
 * with its own progress mark per network.
 */

import { createPublicClient, formatUnits, http, parseAbiItem, type Address } from "viem";
import { store } from "../store/db.js";
import { MULTICHAIN_ASSETS } from "./arc-balances.js";
import { alertUser } from "./notifyUser.js";
import { inboundSender } from "./inbound.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

type Network = {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** Blocks per chunk the public RPCs accept for getLogs. */
  chunk: bigint;
  /** First scan looks back about four hours. */
  lookback: bigint;
  /** Most blocks one sync covers, so a long-idle wallet catches up in steps. */
  maxPerSync: bigint;
  /** Recent enough to be worth a notification (about fifteen minutes). */
  alertWindow: bigint;
  tokens: Array<{ address: Address; symbol: string; decimals: number }>;
};

function networks(): Network[] {
  const out: Network[] = [];
  for (const a of MULTICHAIN_ASSETS) {
    if (a.family !== "evm" || (a.chainId !== 11155111 && a.chainId !== 84532)) continue;
    const tokens = [
      a.usdc ? { address: a.usdc, symbol: "USDC", decimals: a.usdcDecimals ?? 6 } : null,
      a.eurc ? { address: a.eurc, symbol: "EURC", decimals: a.eurcDecimals ?? 6 } : null,
      a.cirbtc ? { address: a.cirbtc, symbol: "CIRBTC", decimals: a.cirbtcDecimals ?? 8 } : null,
    ].filter((t): t is { address: Address; symbol: string; decimals: number } => t !== null);
    const eth = a.chainId === 11155111; // 12 s blocks; Base Sepolia 2 s
    out.push({
      chainId: a.chainId,
      name: a.name,
      rpcUrl: a.rpcUrl,
      chunk: eth ? 2_000n : 5_000n,
      lookback: eth ? 1_200n : 7_200n,
      maxPerSync: eth ? 6_000n : 30_000n,
      alertWindow: eth ? 75n : 450n,
      tokens,
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Client = ReturnType<typeof createPublicClient>;

/** Logs for a range, halving it for as long as the node says it is too large. */
async function logsInRange(client: Client, net: Network, to: Address, fromBlock: bigint, toBlock: bigint) {
  const { isRangeTooLarge } = await import("./inbound.js");
  const query = () =>
    client.getLogs({
      address: net.tokens.map((t) => t.address),
      event: TRANSFER_EVENT,
      args: { to },
      fromBlock,
      toBlock,
    });
  try {
    return await query();
  } catch (e) {
    if (!isRangeTooLarge(e) || toBlock <= fromBlock) throw e;
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const left: Awaited<ReturnType<typeof query>> = await logsInRange(client, net, to, fromBlock, mid);
    await sleep(150);
    const right: Awaited<ReturnType<typeof query>> = await logsInRange(client, net, to, mid + 1n, toBlock);
    return [...left, ...right];
  }
}

function short(address: string): string {
  const handle = store.findUserByRecipient?.(address)?.handle;
  return handle ? `@${handle}` : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function syncNetwork(
  net: Network,
  input: { userId: string; address: string },
): Promise<number> {
  const client = createPublicClient({ transport: http(net.rpcUrl) });
  const head = await client.getBlockNumber();
  const mark = store.getUser(input.userId)?.inboundScannedBlocks?.[String(net.chainId)];
  let from = mark && mark > 0 ? BigInt(mark) - 20n : head - net.lookback;
  if (from < 0n) from = 0n;
  if (from > head) return 0;
  const to = head - from > net.maxPerSync ? from + net.maxPerSync : head;

  let recorded = 0;
  for (let cursor = from; cursor <= to; ) {
    const end = cursor + net.chunk > to ? to : cursor + net.chunk;
    const logs = await logsInRange(client, net, input.address as Address, cursor, end);
    for (const log of logs) {
      const token = net.tokens.find((t) => t.address.toLowerCase() === log.address.toLowerCase());
      if (!token || log.args.value == null || !log.args.from) continue;
      const logIndex = Number(log.logIndex);
      if (store.hasInboundActivity(log.transactionHash, logIndex)) continue;
      // The wallet's own money coming back is not income: its own send, or a
      // bridge / Gateway Account payment landing that the app already recorded.
      if (log.args.from.toLowerCase() === input.address.toLowerCase()) continue;
      if (store.hasActivityWithTx(input.userId, log.transactionHash)) continue;
      const amount = Number(formatUnits(log.args.value, token.decimals));
      if (!(amount > 0)) continue;
      const shown = (Math.round(amount * 100) / 100).toFixed(2);
      const who = inboundSender(log.args.from);
      store.addActivity({
        userId: input.userId,
        kind: "receive",
        title: "Money received",
        description:
          who.label === "Unknown"
            ? `${shown} on ${net.name} from Unknown (${short(log.args.from)})`
            : `${shown} on ${net.name} from ${who.label}`,
        amountUsdc: token.symbol === "USDC" ? amount : 0,
        token: token.symbol,
        amountToken: amount,
        counterparty: who.label,
        sender: log.args.from,
        receiver: input.address,
        txHash: log.transactionHash,
        logIndex,
        mode: `onchain_inbound_${net.chainId}`,
        status: "completed",
      });
      recorded += 1;
      if (log.blockNumber != null && head - log.blockNumber <= net.alertWindow) {
        alertUser(input.userId, {
          kind: "money_in",
          moneyIn: true,
          title: "Money received",
          body: `${shown} ${token.symbol} arrived on ${net.name}`,
          amountUsdc: token.symbol === "USDC" ? amount : undefined,
          token: token.symbol,
          counterparty: who.label,
          txHash: log.transactionHash,
        });
      }
    }
    cursor = end + 1n;
    if (cursor <= to) await sleep(150);
  }
  store.setInboundScannedBlockFor(input.userId, net.chainId, Number(to));
  return recorded;
}

/** Brings the other networks up to date for one wallet. Never throws per network. */
export async function syncOtherChainsForUser(input: {
  userId: string;
  address: string;
}): Promise<{ recorded: number; errors: string[] }> {
  const out = { recorded: 0, errors: [] as string[] };
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.address)) return out;
  // Tidies rows recorded before the scan checked for the person's own moves.
  store.hideDuplicateInbound(input.userId);
  for (const net of networks()) {
    try {
      out.recorded += await syncNetwork(net, input);
    } catch (e) {
      out.errors.push(`${net.name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return out;
}

let sweepCursor = 0;

/**
 * Runs from the tick, so money arriving while the app is closed is still
 * recorded and announced. A few wallets per pass, in rotation, to stay inside
 * the public RPCs' limits.
 */
export async function runInboundSweep(perPass = 2): Promise<{ scanned: number; recorded: number; errors: string[] }> {
  const users = store.listUsers().filter((u) => /^0x[a-fA-F0-9]{40}$/.test(u.evmAddress ?? ""));
  const out = { scanned: 0, recorded: 0, errors: [] as string[] };
  if (users.length === 0) return out;
  const { syncInboundForUser, claimInboundScan, releaseInboundScan, backfillNativeInbound, isRateLimited } =
    await import("./inbound.js");
  let backedOff = false;
  for (let i = 0; i < Math.min(perPass, users.length); i++) {
    const u = users[(sweepCursor + i) % users.length]!;
    // Already being scanned for an app refresh: that scan covers it.
    if (!claimInboundScan(u.id)) continue;
    try {
      const arc = await syncInboundForUser({ userId: u.id, address: u.evmAddress });
      const other = await syncOtherChainsForUser({ userId: u.id, address: u.evmAddress });
      // A slice of the one-time look back for native sends, until it is done.
      const back = await backfillNativeInbound({ userId: u.id, address: u.evmAddress });
      out.recorded += arc.recorded.length + other.recorded + back.recorded;
      out.errors.push(...other.errors.map((e) => `${u.id.slice(0, 8)} ${e}`));
    } catch (e) {
      out.errors.push(`${u.id.slice(0, 8)} Arc: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      // The RPC is out of patience: stop this pass rather than add to it.
      if (isRateLimited(e)) backedOff = true;
    } finally {
      releaseInboundScan(u.id);
    }
    out.scanned += 1;
    if (backedOff) break;
  }
  sweepCursor = (sweepCursor + Math.min(perPass, users.length)) % users.length;
  return out;
}
