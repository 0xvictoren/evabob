import { decodeEventLog, parseAbi, parseUnits, type Hex } from "viem";
import { config } from "../config.js";
import { getPublicClient } from "./arc-wallet.js";
import type { ReceiptReader } from "./agentFunding.js";

const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const address = /^0x[\da-f]{40}$/i;
/**
 * True when a transaction succeeded and moved exactly [amount] of [token] out
 * of [sender]'s wallet — the proof a conversion was spent, whoever received
 * it (a router, a pool).
 */
export async function verifySpendEvidence(input: {
  txHash: string; sender: string; token: string; amount: number;
  notBefore?: string | number;
}, client: ReceiptReader & {
  getBlock?: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
} = getPublicClient() as unknown as ReceiptReader & {
  getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
}): Promise<boolean> {
  if (!/^0x[\da-f]{64}$/i.test(input.txHash) || !address.test(input.sender)) return false;
  const asset = input.token === "USDC"
    ? { address: config.arc.usdc, decimals: 6 }
    : input.token === "EURC"
      ? { address: config.arc.eurc, decimals: 6 }
      : input.token === "CIRBTC"
        ? { address: config.arc.cirbtc, decimals: 8 }
        : undefined;
  if (!asset || !Number.isFinite(input.amount) || input.amount <= 0) return false;
  try {
    const receipt = await client.getTransactionReceipt({ hash: input.txHash as Hex });
    if (receipt.status !== "success") return false;
    if (input.notBefore != null && client.getBlock) {
      const blockNumber = (receipt as { blockNumber?: bigint }).blockNumber;
      const minimum = Date.parse(String(input.notBefore));
      if (blockNumber != null && Number.isFinite(minimum)) {
        const block = await client.getBlock({ blockNumber });
        if (Number(block.timestamp) * 1000 + 60_000 < minimum) return false;
      }
    }
    const want = parseUnits(input.amount.toFixed(asset.decimals), asset.decimals);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== asset.address.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (event.args.from.toLowerCase() === input.sender.toLowerCase() && event.args.value === want) return true;
      } catch { /* unrelated event */ }
    }
    return false;
  } catch { return false; }
}

export async function verifyPaymentEvidence(input: {
  txHash: string; sender: string; recipient: string; token: string; amount: number;
  /** Reject a transaction mined before this operation existed. */
  notBefore?: string | number;
}, client: ReceiptReader & {
  getBlock?: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
} = getPublicClient() as unknown as ReceiptReader & {
  getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
}): Promise<boolean> {
  if (!/^0x[\da-f]{64}$/i.test(input.txHash) || !address.test(input.sender) || !address.test(input.recipient)) return false;
  const asset = input.token === "USDC"
    ? { address: config.arc.usdc, decimals: 6 }
    : input.token === "EURC"
      ? { address: config.arc.eurc, decimals: 6 }
      : input.token === "CIRBTC"
        ? { address: config.arc.cirbtc, decimals: 8 }
        : undefined;
  if (!asset || !Number.isFinite(input.amount) || input.amount <= 0) return false;
  // Reject excess precision rather than silently rounding the intended payment.
  const amount = String(input.amount);
  if (!new RegExp(`^\\d+(\\.\\d{1,${asset.decimals}})?$`).test(amount)) return false;
  try {
    const receipt = await client.getTransactionReceipt({ hash: input.txHash as Hex });
    if (receipt.status !== "success") return false;
    if (input.notBefore != null) {
      const minimum = typeof input.notBefore === "number"
        ? input.notBefore
        : Date.parse(input.notBefore);
      const blockNumber = (receipt as { blockNumber?: bigint }).blockNumber;
      if (!Number.isFinite(minimum) || blockNumber == null || !client.getBlock) return false;
      const block = await client.getBlock({ blockNumber });
      // Permit one minute of clock skew between the API host and chain time.
      if (Number(block.timestamp) * 1000 + 60_000 < minimum) return false;
    }
    let total = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== asset.address.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (event.args.from.toLowerCase() === input.sender.toLowerCase()
          && event.args.to.toLowerCase() === input.recipient.toLowerCase()) total += event.args.value;
      } catch { /* unrelated event */ }
    }
    return total === parseUnits(amount, asset.decimals);
  } catch { return false; }
}
