/**
 * Evabob platform fee — 0.05% (5 bps) on every money-moving action, gas
 * excluded, added on top of the amount the person typed.
 *
 * Collected inside the same Circle approval as the payment itself: Evabob
 * wallets are Circle smart contract accounts, so the payment call and the fee
 * transfer are wrapped in the wallet's own `executeBatch` and submitted as ONE
 * contract-execution challenge — one PIN, and either both land or neither
 * does. This is the same encoding Circle's App Kit adapter uses for batched
 * steps.
 */

import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { config } from "../config.js";

export type WalletCall = { to: Address; value?: bigint; data: Hex };

/** Circle SCA wallets expose `executeBatch((address,uint256,bytes)[])`. */
export const SCA_EXECUTE_BATCH_ABI = [
  {
    name: "executeBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export type PlatformFeeSettings = {
  recipient: Address | "";
  bps: number;
};

export function platformFeeSettings(): PlatformFeeSettings {
  return config.platformFee;
}

export function platformFeeEnabled(
  settings: PlatformFeeSettings = platformFeeSettings(),
): boolean {
  return Boolean(settings.recipient) && settings.bps > 0;
}

/** Human amount → base units without float drift (0.1 + 0.2 style). */
export function toUnits(amount: number | string, decimals = 6): bigint {
  const text =
    typeof amount === "number" ? amount.toFixed(decimals) : amount.trim();
  return parseUnits(text, decimals);
}

/**
 * Fee in base units, rounded down. There is no minimum: an amount too small
 * to produce one whole base unit of fee is charged nothing.
 */
export function feeUnitsFor(
  amountUnits: bigint,
  settings: PlatformFeeSettings = platformFeeSettings(),
): bigint {
  if (!platformFeeEnabled(settings) || amountUnits <= 0n) return 0n;
  return (amountUnits * BigInt(settings.bps)) / 10_000n;
}

export type PlatformFeeQuote = {
  /** Fee in the token's base units. 0n when nothing is charged. */
  feeUnits: bigint;
  /** Human-readable fee, e.g. "0.05". "0" when nothing is charged. */
  fee: string;
  amountUnits: bigint;
  /** Amount + fee — what the sender's wallet must hold. */
  totalUnits: bigint;
  bps: number;
  recipient: Address | "";
};

export function quotePlatformFee(
  amount: number | string,
  decimals = 6,
  settings: PlatformFeeSettings = platformFeeSettings(),
): PlatformFeeQuote {
  const amountUnits = toUnits(amount, decimals);
  const feeUnits = feeUnitsFor(amountUnits, settings);
  return {
    feeUnits,
    fee: formatUnits(feeUnits, decimals),
    amountUnits,
    totalUnits: amountUnits + feeUnits,
    bps: settings.bps,
    recipient: settings.recipient,
  };
}

export function erc20TransferCall(
  token: Address,
  to: Address,
  units: bigint,
): WalletCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, units],
    }),
  };
}

/** The fee leg for a batch, or null when no fee applies. */
export function feeTransferCall(
  token: Address,
  quote: PlatformFeeQuote,
): WalletCall | null {
  if (quote.feeUnits <= 0n || !quote.recipient) return null;
  return erc20TransferCall(token, quote.recipient, quote.feeUnits);
}

export function encodeWalletBatch(calls: WalletCall[]): Hex {
  if (calls.length === 0) throw new Error("A wallet batch needs at least one call");
  return encodeFunctionData({
    abi: SCA_EXECUTE_BATCH_ABI,
    functionName: "executeBatch",
    args: [
      calls.map((call) => ({
        target: call.to,
        value: call.value ?? 0n,
        data: call.data,
      })),
    ],
  });
}

/** Fee fields recorded on an activity row and shown on the receipt. */
export function feeActivityFields(
  quote: PlatformFeeQuote,
  token: string,
  decimals = 6,
): { platformFee?: number; platformFeeToken?: string } {
  if (quote.feeUnits <= 0n) return {};
  return {
    platformFee: Number(formatUnits(quote.feeUnits, decimals)),
    platformFeeToken: token,
  };
}
