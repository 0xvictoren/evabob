/**
 * Synthra trading API — quote + swap (USDC ↔ EURC on Arc).
 * Docs: https://docs.synthra.org/ · trading-api.synthra.org
 *
 * Amounts are **raw integer strings** (6 decimals for USDC/EURC).
 * API key stays server-side only (SYNTHRA_API_KEY).
 */

import { parseUnits } from "viem";
import { config } from "../config.js";

const DEFAULT_BASE = "https://trading-api.synthra.org";

export function synthraConfigured(): boolean {
  return Boolean(config.synthra.apiKey?.trim());
}

function baseUrl(): string {
  return (config.synthra.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
}

async function synthraFetch(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!config.synthra.apiKey?.trim()) {
    return {
      ok: false,
      status: 503,
      data: {
        error: "SYNTHRA_API_KEY not configured",
        hint: "Add SYNTHRA_API_KEY to server/.env (no spaces around =)",
      },
    };
  }
  const url = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": config.synthra.apiKey.trim(),
        ...(init?.headers || {}),
      },
    });
    let data: unknown = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      data: {
        error: e instanceof Error ? e.message : "synthra request failed",
      },
    };
  }
}

export type SwapToken = "USDC" | "EURC" | "CIRBTC" | string;

export type QuoteInput = {
  fromToken: SwapToken;
  toToken: SwapToken;
  /** Human amount, e.g. 1.5 */
  amountIn: string | number;
  /** Slippage bps, e.g. 50 = 0.5% */
  slippageBps?: number;
  chainId?: number;
  /** Override decimals when using custom 0x addresses (default 18 for unknown). */
  fromDecimals?: number;
  toDecimals?: number;
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function tokenAddress(sym: SwapToken): string {
  const s = String(sym).trim();
  if (ADDR_RE.test(s)) return s;
  const u = s.toUpperCase();
  if (u === "EURC") return config.arc.eurc;
  if (u === "CIRBTC" || u === "CIRB" || u === "CBTC") return config.arc.cirbtc;
  return config.arc.usdc;
}

function tokenDecimals(sym: SwapToken, override?: number): number {
  if (override != null && override > 0) return override;
  const s = String(sym).trim();
  if (ADDR_RE.test(s)) return 18; // most ERC-20s; caller can override
  const u = s.toUpperCase();
  if (u === "CIRBTC" || u === "CIRB" || u === "CBTC") return 8;
  return 6;
}

/** Convert human amount → raw integer string (6 dec stablecoins, 8 for cirBTC). */
export function toRawAmount(
  human: string | number,
  decimals = 6,
): string {
  const s =
    typeof human === "number"
      ? human.toFixed(decimals)
      : String(human).trim() || "0";
  return parseUnits(s, decimals).toString();
}

/** Raw integer (or decimal string) → human float. */
export function fromRawAmount(
  raw: string | number | undefined,
  decimals = 6,
): number {
  if (raw == null) return 0;
  if (typeof raw === "number") {
    // Synthra amountOutDecimals is already human
    return raw;
  }
  const t = String(raw).trim();
  if (!t) return 0;
  // Prefer integer raw
  if (/^\d+$/.test(t)) {
    return Number(t) / 10 ** decimals;
  }
  return Number(t) || 0;
}

export type SynthraQuoteResult = {
  ok: boolean;
  status: number;
  amountOut?: number;
  amountOutRaw?: string;
  amountInRaw?: string;
  routeString?: string;
  quote: unknown;
  error?: string;
};

/**
 * Request a swap quote on Arc (POST /v1/quote).
 * Body: { tokenIn, tokenOut, amount, chainId, slippageBps? }
 */
export async function synthraQuote(
  input: QuoteInput,
): Promise<SynthraQuoteResult> {
  const chainId = input.chainId ?? config.arc.chainId;
  const tokenIn = tokenAddress(input.fromToken);
  const tokenOut = tokenAddress(input.toToken);
  const inDec = tokenDecimals(input.fromToken, input.fromDecimals);
  const outDec = tokenDecimals(input.toToken, input.toDecimals);
  const amount = toRawAmount(input.amountIn, inDec);

  const res = await synthraFetch("/v1/quote", {
    method: "POST",
    body: JSON.stringify({
      tokenIn,
      tokenOut,
      amount,
      chainId,
      slippageBps: input.slippageBps ?? 50,
    }),
  });

  const data = res.data as Record<string, unknown> | null;
  if (!res.ok || !data || data.state !== "Success") {
    return {
      ok: false,
      status: res.status,
      quote: data,
      error:
        (data?.error as string) ||
        (data?.code as string) ||
        "Synthra quote failed",
    };
  }

  const amountOutRaw = String(data.amountOut ?? "");
  const amountOut =
    data.amountOutDecimals != null
      ? Number(data.amountOutDecimals)
      : fromRawAmount(amountOutRaw, outDec);

  return {
    ok: true,
    status: res.status,
    amountOut,
    amountOutRaw,
    amountInRaw: amount,
    routeString: data.routeString as string | undefined,
    quote: data,
  };
}

export type SwapInput = QuoteInput & {
  recipient: string;
  /** erc20 is easier for Circle UCW (approve + swap calldata). */
  approvalMode?: "erc20" | "permit2";
};

export type SynthraSwapPlan = {
  ok: boolean;
  status: number;
  amountOut?: number;
  amountOutRaw?: string;
  amountInRaw?: string;
  routeString?: string;
  approval?: {
    mode: string;
    spender?: string;
    approveTo?: string;
    approveData?: string;
    amountRequired?: string;
  };
  transaction?: {
    to: string;
    data: string;
    value?: string;
    chainId?: number;
    gasLimit?: string;
  };
  raw: unknown;
  error?: string;
};

/** Build executable swap plan (approve + swap calldata). */
export async function synthraSwap(input: SwapInput): Promise<SynthraSwapPlan> {
  const chainId = input.chainId ?? config.arc.chainId;
  const tokenIn = tokenAddress(input.fromToken);
  const tokenOut = tokenAddress(input.toToken);
  const inDec = tokenDecimals(input.fromToken, input.fromDecimals);
  const outDec = tokenDecimals(input.toToken, input.toDecimals);
  const amount = toRawAmount(input.amountIn, inDec);
  const approvalMode = input.approvalMode ?? "erc20";

  if (!input.recipient?.startsWith("0x") || input.recipient.length !== 42) {
    return {
      ok: false,
      status: 400,
      raw: null,
      error: "Valid recipient 0x address required for swap",
    };
  }

  const res = await synthraFetch("/v1/swap", {
    method: "POST",
    body: JSON.stringify({
      tokenIn,
      tokenOut,
      amount,
      chainId,
      recipient: input.recipient,
      slippageBps: input.slippageBps ?? 50,
      approvalMode,
    }),
  });

  const data = res.data as Record<string, unknown> | null;
  if (!res.ok || !data || data.state !== "Success") {
    return {
      ok: false,
      status: res.status,
      raw: data,
      error:
        (data?.error as string) ||
        (data?.code as string) ||
        "Synthra swap failed",
    };
  }

  const approval = data.approval as Record<string, unknown> | undefined;
  const tokenApproval = approval?.tokenApproval as
    | Record<string, unknown>
    | undefined;
  const approveTx = tokenApproval?.approveTransaction as
    | Record<string, unknown>
    | undefined;
  const tx = data.transaction as Record<string, unknown> | undefined;

  const amountOutRaw = String(data.amountOut ?? "");
  const amountOut =
    data.amountOutDecimals != null
      ? Number(data.amountOutDecimals)
      : fromRawAmount(amountOutRaw, outDec);

  return {
    ok: true,
    status: res.status,
    amountOut,
    amountOutRaw,
    amountInRaw: amount,
    routeString: data.routeString as string | undefined,
    approval: {
      mode: String(approval?.mode || approvalMode),
      spender: tokenApproval?.spender as string | undefined,
      approveTo: approveTx?.to as string | undefined,
      approveData: approveTx?.data as string | undefined,
      amountRequired: tokenApproval?.amountRequired as string | undefined,
    },
    transaction: tx
      ? {
          to: String(tx.to),
          data: String(tx.data),
          value: tx.value != null ? String(tx.value) : "0",
          chainId: tx.chainId as number | undefined,
          gasLimit: tx.gasLimit != null ? String(tx.gasLimit) : undefined,
        }
      : undefined,
    raw: data,
  };
}

/** Bridge quote scaffold — Synthra CCTP router is limited; prefer Circle CCTP. */
export async function synthraBridgeQuote(input: {
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: string;
  destinationChainId?: number;
}) {
  const amount = toRawAmount(input.amountUsdc);
  return synthraFetch("/v1/cctp/quote", {
    method: "POST",
    body: JSON.stringify({
      amount,
      tokenIn: config.arc.usdc,
      sourceChainId: config.arc.chainId,
      destinationChainId: input.destinationChainId,
      destinationDomain: input.destinationDomain,
      recipient: input.mintRecipient,
      mintRecipient: input.mintRecipient,
    }),
  });
}

export function synthraHealth() {
  return {
    configured: synthraConfigured(),
    baseUrl: baseUrl(),
  };
}
