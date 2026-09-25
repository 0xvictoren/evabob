/**
 * Circle App Kit — single type-safe interface for Send, Bridge (CCTP),
 * Swap, and Unified Balance (Gateway).
 *
 * Hybrid wallet model:
 * - Circle Wallets adapter: developer-controlled / ops / agent / composition
 * - Viem adapter (PRIVATE_KEY): ops fallback when entity secret / DC wallets
 *   are unavailable
 * - End-user UCW PIN flows stay on /v1/circle/* (see new.md)
 *
 * Docs: https://docs.arc.io/app-kit
 */

import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { arcTransport } from "./arc-wallet.js";
import { currentUsdPerCirbtc, quotePlatformFee } from "./platformFee.js";
import { config } from "../config.js";

/** Product-supported App Kit chains only. */
export type AppKitChain = "Arc_Testnet" | "Ethereum_Sepolia" | "Base_Sepolia";

export const PRODUCT_APPKIT_CHAINS: readonly AppKitChain[] = [
  "Arc_Testnet",
  "Ethereum_Sepolia",
  "Base_Sepolia",
] as const;

export const APP_KIT_CHAINS: Record<string, AppKitChain> = {
  arc: "Arc_Testnet",
  "arc-testnet": "Arc_Testnet",
  "arc_testnet": "Arc_Testnet",
  ethereum: "Ethereum_Sepolia",
  "ethereum-sepolia": "Ethereum_Sepolia",
  "eth-sepolia": "Ethereum_Sepolia",
  ethereum_sepolia: "Ethereum_Sepolia",
  base: "Base_Sepolia",
  "base-sepolia": "Base_Sepolia",
  base_sepolia: "Base_Sepolia",
};

/** CCTP domain → App Kit chain name (product-supported only). */
export const DOMAIN_TO_APPKIT_CHAIN: Record<number, AppKitChain> = {
  0: "Ethereum_Sepolia",
  6: "Base_Sepolia",
  26: "Arc_Testnet",
};

export function resolveAppKitChain(input: string | number): AppKitChain {
  if (typeof input === "number") {
    const c = DOMAIN_TO_APPKIT_CHAIN[input];
    if (!c) {
      throw new Error(
        `Unsupported CCTP domain: ${input}. Product supports 26 (Arc), 0 (Eth Sepolia), 6 (Base Sepolia)`,
      );
    }
    return c;
  }
  const key = input.trim();
  if (key in APP_KIT_CHAINS) return APP_KIT_CHAINS[key]!;
  if ((PRODUCT_APPKIT_CHAINS as readonly string[]).includes(key)) {
    return key as AppKitChain;
  }
  throw new Error(
    `Unsupported chain "${input}". Product supports Arc_Testnet, Ethereum_Sepolia, Base_Sepolia only.`,
  );
}

/** In-memory ring buffer of recent kit events (activity feed / debug). */
const MAX_EVENTS = 200;
const recentEvents: Array<{ at: string; payload: unknown }> = [];

export function getRecentAppKitEvents(limit = 50) {
  return recentEvents.slice(-limit);
}

let kitSingleton: AppKit | null = null;
let circleAdapterSingleton: ReturnType<
  typeof createCircleWalletsAdapter
> | null = null;
let viemAdapterSingleton: ReturnType<
  typeof createViemAdapterFromPrivateKey
> | null = null;
let listenersAttached = false;

export function appKitEnabled(): boolean {
  return config.appKit.enabled;
}

export function appKitConfigured(): {
  enabled: boolean;
  circleWallets: boolean;
  viemOps: boolean;
  kitKey: boolean;
  feeRecipient: boolean;
  dcWallet: string | null;
} {
  return {
    enabled: config.appKit.enabled,
    circleWallets: Boolean(
      config.circle.apiKey && config.circle.entitySecret,
    ),
    viemOps: Boolean(config.arc.privateKey),
    kitKey: Boolean(config.appKit.kitKey),
    feeRecipient: Boolean(config.appKit.feeRecipient),
    dcWallet: config.appKit.dcWalletAddress || null,
  };
}

/** Resolve ops wallet address for Circle Wallets adapter contexts. */
export function resolveDcWalletAddress(explicit?: string | null): string {
  const addr = (explicit || config.appKit.dcWalletAddress || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error(
      "Developer-controlled wallet address required (set APP_KIT_DC_WALLET or pass fromAddress)",
    );
  }
  return addr;
}

export function getAppKit(): AppKit {
  if (!kitSingleton) {
    kitSingleton = new AppKit();
    if (!listenersAttached) {
      listenersAttached = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kitSingleton.on("*" as any, (payload: any) => {
        const entry = { at: new Date().toISOString(), payload };
        recentEvents.push(entry);
        if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
        const values = payload?.values as
          | { name?: string; state?: string; txHash?: string }
          | undefined;
        const name = values?.name || payload?.method || "event";
        const state = values?.state || "";
        const tx = values?.txHash || "";
        console.log(
          `[AppKit] ${name}${state ? ` (${state})` : ""}${tx ? ` ${String(tx).slice(0, 12)}…` : ""}`,
        );
      });
    }
  }
  return kitSingleton;
}

/**
 * Developer-controlled Circle Wallets adapter.
 * Requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET.
 * Callers must pass wallet `address` per chain in operation context.
 */
export function getCircleWalletsAdapter() {
  if (!config.circle.apiKey) {
    throw new Error("CIRCLE_API_KEY not configured for App Kit");
  }
  if (!config.circle.entitySecret) {
    throw new Error(
      "CIRCLE_ENTITY_SECRET not configured — required for @circle-fin/adapter-circle-wallets",
    );
  }
  if (!circleAdapterSingleton) {
    circleAdapterSingleton = withPatientConfirmations(
      createCircleWalletsAdapter({
        apiKey: config.circle.apiKey,
        entitySecret: config.circle.entitySecret,
      }),
    );
  }
  return circleAdapterSingleton;
}

/**
 * Ops / treasury viem adapter from server PRIVATE_KEY.
 * Useful when developer-controlled Circle wallets are not provisioned,
 * or as destination signer for hybrid flows.
 */
export function getViemOpsAdapter() {
  if (!config.arc.privateKey) {
    throw new Error("PRIVATE_KEY not configured for App Kit viem adapter");
  }
  if (!viemAdapterSingleton) {
    const pk = config.arc.privateKey.startsWith("0x")
      ? config.arc.privateKey
      : `0x${config.arc.privateKey}`;
    viemAdapterSingleton = withPatientConfirmations(
      createViemAdapterFromPrivateKey({
        privateKey: pk as `0x${string}`,
        // Arc goes through the same retrying fallback as the rest of the
        // server rather than App Kit's default public RPC, whose rate limit
        // failed quotes and simulations.
        getPublicClient: ({ chain }) =>
          createPublicClient({
            chain,
            transport: chain.id === config.arc.chainId ? arcTransport() : http(),
          }) as never,
        getWalletClient: ({ chain, account }) =>
          createWalletClient({
            chain,
            account,
            transport: chain.id === config.arc.chainId ? arcTransport() : http(),
          }) as never,
      }),
    );
  }
  return viemAdapterSingleton;
}

/**
 * How long to wait for a transaction to confirm, per chain.
 *
 * A Gateway top-up is two transactions: `increaseAllowance`, then `deposit`.
 * The adapter waits for the first to confirm before sending the second, and
 * the SDK's default wait is tuned for fast chains. On Ethereum Sepolia, with
 * ~12s blocks, the approve had not confirmed before that wait expired, so the
 * deposit was never sent — the run failed with
 * `Timed out while waiting for transaction … to be confirmed` after leaving a
 * raised allowance and no deposit behind.
 *
 * Arc confirms in well under a second; Base Sepolia takes a couple of seconds
 * a block; Ethereum Sepolia is the slow one. These are ceilings, not delays —
 * a confirmation that arrives sooner returns sooner.
 */
const CONFIRMATION_TIMEOUT_MS: Record<number, number> = {
  5042002: 120_000, // Arc Testnet
  84532: 300_000, // Base Sepolia
  11155111: 600_000, // Ethereum Sepolia
};
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 300_000;

function confirmationTimeoutFor(chain: unknown): number {
  const id = (chain as { chainId?: number; id?: number } | null)?.chainId ??
    (chain as { id?: number } | null)?.id;
  return (
    (typeof id === "number" ? CONFIRMATION_TIMEOUT_MS[id] : undefined) ??
    DEFAULT_CONFIRMATION_TIMEOUT_MS
  );
}

/**
 * Gives an adapter a confirmation window that suits the chain it is on.
 *
 * App Kit does not expose the wait config on `deposit`/`send`, and
 * `waitForTransaction` lives on the adapter prototype, so the timeout is
 * raised by shadowing that method on the instance. An explicit longer timeout
 * from a caller is left alone; only a missing or too-short one is widened.
 */
export function withPatientConfirmations<T extends object>(adapter: T): T {
  const target = adapter as T & {
    waitForTransaction?: (
      txHash: string,
      cfg: { timeout?: number } | undefined,
      chain: unknown,
    ) => Promise<unknown>;
  };
  if (typeof target.waitForTransaction !== "function") return adapter;
  if (Object.prototype.hasOwnProperty.call(target, "waitForTransaction")) {
    return adapter; // already patched
  }

  const original = target.waitForTransaction.bind(target);
  Object.defineProperty(target, "waitForTransaction", {
    configurable: true,
    writable: true,
    value: (txHash: string, cfg: { timeout?: number } | undefined, chain: unknown) => {
      const floor = confirmationTimeoutFor(chain);
      const timeout = Math.max(cfg?.timeout ?? 0, floor);
      return original(txHash, { ...(cfg ?? {}), timeout }, chain);
    },
  });
  return adapter;
}

export type AdapterMode = "circle-wallets" | "viem-ops";

export function pickAdapter(mode?: AdapterMode) {
  const preferred = mode || config.appKit.defaultAdapter;
  if (preferred === "circle-wallets") {
    try {
      return {
        mode: "circle-wallets" as const,
        adapter: getCircleWalletsAdapter(),
      };
    } catch (e) {
      if (config.arc.privateKey) {
        console.warn(
          "[AppKit] Circle Wallets adapter unavailable, falling back to viem ops:",
          e instanceof Error ? e.message : e,
        );
        return {
          mode: "viem-ops" as const,
          adapter: getViemOpsAdapter(),
        };
      }
      throw e;
    }
  }
  return { mode: "viem-ops" as const, adapter: getViemOpsAdapter() };
}

/**
 * Bridge-style custom fee (absolute human amount).
 * Swap uses percentageBps via {@link buildSwapFeeConfig}.
 */
export function buildBridgeFee(amountHuman: string):
  | {
      value: string;
      recipientAddress: string;
    }
  | undefined {
  if (!config.appKit.feeRecipient) return undefined;
  const amt = Number(amountHuman);
  if (!Number.isFinite(amt) || amt <= 0) return undefined;
  // Bridges move USDC: the same fee as every other USDC payment (flat, or
  // the percentage when no flat fee is set). No minimum.
  const quote = quotePlatformFee(amt, 6);
  if (quote.feeUnits <= 0n) return undefined;
  return {
    value: formatUnits(quote.feeUnits, 6),
    recipientAddress: config.appKit.feeRecipient,
  };
}

/**
 * The whole-basis-point rate closest to the flat fee on this swap.
 *
 * App Kit takes a swap fee only as whole basis points per transaction (an
 * absolute amount is refused), so the flat ~$0.02 becomes a rate for the
 * amount: exactly $0.02 on a $2 swap, about $0.02 on most. At least 1 bp, so
 * swaps above ~$200 pay a little more; at most 10%, so a swap of a few cents
 * is not eaten by the fee.
 */
export function flatFeeSwapBps(amountUsd: number, flatUsd: number): number {
  if (!(amountUsd > 0) || !(flatUsd > 0)) return 0;
  const bps = Math.round((flatUsd / amountUsd) * 10_000);
  return Math.min(1_000, Math.max(1, bps));
}

/**
 * Swap custom fee: the flat fee expressed as a rate for this amount, or, with
 * no flat fee set, the percentage. A pasted token address has no known price,
 * so it is charged no flat fee.
 */
export function buildSwapFeeConfig(tokenIn = "USDC", amountIn?: string | number):
  | {
      percentageBps: number;
      recipientAddress: string;
    }
  | undefined {
  if (!config.appKit.feeRecipient) return undefined;
  const flat = config.platformFee.flatUsd ?? 0;
  if (flat > 0) {
    const symbol = tokenIn.toUpperCase();
    if (!["USDC", "EURC", "CIRBTC"].includes(symbol)) return undefined;
    const amount = Number(amountIn);
    // Dollars and euros count about one for one; cirBTC at its App Kit price.
    const amountUsd = symbol === "CIRBTC" ? amount * currentUsdPerCirbtc() : amount;
    const bps = flatFeeSwapBps(amountUsd, flat);
    if (bps <= 0) return undefined;
    return { percentageBps: bps, recipientAddress: config.appKit.feeRecipient };
  }
  if (config.appKit.feeBps <= 0) return undefined;
  return {
    percentageBps: config.appKit.feeBps,
    recipientAddress: config.appKit.feeRecipient,
  };
}

/** @deprecated use buildBridgeFee — kept for call sites */
export function buildCustomFee(amountHuman: string) {
  return buildBridgeFee(amountHuman);
}

export function serializeAppKitResult(result: unknown): unknown {
  const scrub = (value: unknown): unknown => {
    if (value == null) return value;
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(scrub);
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Never return kit keys / secrets in API payloads
        if (k === "kitKey" || k === "apiKey" || k === "entitySecret") continue;
        out[k] = scrub(v);
      }
      return out;
    }
    return value;
  };
  return scrub(result);
}
