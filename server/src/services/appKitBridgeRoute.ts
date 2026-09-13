/**
 * CCTP (App Kit bridge) is USDC-only on product testnets.
 */

import type { AppKitChain } from "./appKit.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const MAX_BRIDGE_AMOUNT = 1_000_000;
/** Leave native Arc USDC for gas when the user taps 100%. */
export const ARC_USDC_GAS_RESERVE = 0.05;

export function parseBridgeAmount(raw: string | number): string {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error("Amount must be a finite positive number");
    }
    if (raw > MAX_BRIDGE_AMOUNT) {
      throw new Error(`Amount exceeds max ${MAX_BRIDGE_AMOUNT}`);
    }
    return raw.toFixed(8).replace(/\.?0+$/, "") || String(raw);
  }
  const t = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) {
    throw new Error("Amount must be a decimal (no scientific notation)");
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Amount must be positive");
  }
  if (n > MAX_BRIDGE_AMOUNT) {
    throw new Error(`Amount exceeds max ${MAX_BRIDGE_AMOUNT}`);
  }
  return t.replace(/^0+(?=\d)/, "") || t;
}

export function assertMintRecipient(addr?: string | null): string | undefined {
  if (addr == null || addr === "") return undefined;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error("Mint recipient must be a 0x EVM address");
  }
  if (addr.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("Mint recipient cannot be the zero address");
  }
  return addr;
}

export function planUsdcCctpHop(input: {
  fromChain: AppKitChain;
  toChain: AppKitChain;
}): { kind: "cctp"; tokenIn: "USDC"; tokenOut: "USDC"; fromChain: AppKitChain; toChain: AppKitChain } {
  if (input.fromChain === input.toChain) {
    throw new Error("Source and destination must differ");
  }
  return {
    kind: "cctp",
    tokenIn: "USDC",
    tokenOut: "USDC",
    fromChain: input.fromChain,
    toChain: input.toChain,
  };
}

/** USDC-only CCTP hop. Non-USDC is rejected (App Kit CCTP does not mint EURC/cirBTC). */
export function planBridgeHop(input: {
  token?: string | null;
  fromChain: AppKitChain;
  toChain: AppKitChain;
}): ReturnType<typeof planUsdcCctpHop> {
  const t = (input.token || "USDC").trim().toUpperCase();
  if (t && t !== "USDC") {
    throw new Error(
      `CCTP is USDC-only. "${input.token}" cannot be bridged — swap to USDC first.`,
    );
  }
  return planUsdcCctpHop({
    fromChain: input.fromChain,
    toChain: input.toChain,
  });
}

export function hopNote(_hop?: { kind: string; toChain?: string }): string {
  return "CCTP mints the same USDC on the destination.";
}

export function approxUsdcOut(_tokenIn: string, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount;
}
