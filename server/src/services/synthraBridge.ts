/**
 * Moving dollars from Arc to another network through Synthra.
 *
 * Synthra has no separate bridge call: a bridge is a quote whose destination
 * network differs from its source (POST /v1/swap/quote on the cross-chain
 * host). The answer is a list of steps, each a transaction the person's own
 * wallet sends in order; Synthra's network does the rest, and
 * GET /v1/swap/status says how it went.
 *
 * OFF unless SYNTHRA_BRIDGE=true, and even then only when Synthra lists the
 * network this server runs on. As checked on 2026-11-12 the cross-chain host
 * lists mainnets only (Arc mainnet 5042 among them), so on Arc Testnet this
 * never runs and bridges stay on App Kit. It has not moved real money: the
 * shapes below come from Synthra's published docs, whose examples disagree
 * with each other in places, and need one supervised mainnet run.
 *
 * What the wallet is asked to sign comes from an outside service, so every
 * step is checked before it reaches a PIN (see `planFromQuote`).
 */

import { config } from "../config.js";

export class SynthraBridgeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400, readonly code?: string) {
    super(message);
  }
}

const DEFAULT_HOST = "https://ghost-trading-api.synthra.org";
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX = /^0x[a-fA-F0-9]*$/;

/** Native USDC on the networks a person can send to. Circle's own deployments. */
export const USDC_BY_CHAIN: Readonly<Record<number, { address: `0x${string}`; label: string }>> = {
  1: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", label: "Ethereum" },
  10: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", label: "Optimism" },
  137: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", label: "Polygon" },
  8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", label: "Base" },
  42161: { address: "0xaf88d065e77c8cC2239327C5EDb3A208aA07E5831", label: "Arbitrum" },
  43114: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9D37d6E", label: "Avalanche" },
};

export function synthraBridgeSwitchedOn(): boolean {
  return process.env.SYNTHRA_BRIDGE?.trim().toLowerCase() === "true" && Boolean(apiKey());
}

function host(): string {
  return (process.env.SYNTHRA_BRIDGE_API_BASE?.trim() || DEFAULT_HOST).replace(/\/+$/, "");
}

/** The cross-chain host may have its own key; otherwise the trading key. */
function apiKey(): string {
  return process.env.SYNTHRA_BRIDGE_API_KEY?.trim() || config.synthra.apiKey || "";
}

async function call(path: string, init?: { method?: string; body?: unknown; keyed?: boolean }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${host()}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.keyed === false ? {} : { "x-api-key": apiKey() }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SynthraBridgeError("The bridge service did not answer. Try again in a moment.", 502);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof body?.code === "string" ? body.code : undefined;
    throw new SynthraBridgeError(
      code === "unsupported_chain"
        ? "That network is not available for this."
        : code === "rate_limited"
          ? "Too many requests just now. Try again in a moment."
          : "The bridge service could not do that right now.",
      res.status === 404 ? 404 : 502,
      code,
    );
  }
  return body;
}

// ─── Networks ────────────────────────────────────────────────────────────

export type SynthraChain = { chainId: number; label: string; crossChain: boolean };

/** Reads the chain list Synthra returns. Pure. */
export function parseChains(body: unknown): SynthraChain[] {
  const rows = (body as { chains?: unknown })?.chains;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const row = r as Record<string, unknown>;
    const chainId = Number(row.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) return [];
    return [{
      chainId,
      label: String(row.label ?? row.key ?? chainId),
      crossChain: row.crossChain === "bidirectional" || row.crossChain === true || row.crossChain === "outbound",
    }];
  });
}

let chainsCache: { at: number; chains: SynthraChain[] } | null = null;

export async function synthraChains(force = false): Promise<SynthraChain[]> {
  if (!force && chainsCache && Date.now() - chainsCache.at < 10 * 60_000) return chainsCache.chains;
  const chains = parseChains(await call("/v1/chains", { keyed: false }));
  chainsCache = { at: Date.now(), chains };
  return chains;
}

/**
 * Where a person can send dollars from here: the networks Synthra bridges
 * between that also have a known USDC, when Synthra serves this network.
 * Empty when it does not — which is the case on Arc Testnet.
 */
export function destinationsFrom(chains: SynthraChain[], homeChainId: number): Array<{ chainId: number; label: string }> {
  const home = chains.find((c) => c.chainId === homeChainId);
  if (!home?.crossChain) return [];
  return chains
    .filter((c) => c.crossChain && c.chainId !== homeChainId && USDC_BY_CHAIN[c.chainId])
    .map((c) => ({ chainId: c.chainId, label: USDC_BY_CHAIN[c.chainId]!.label }));
}

export async function synthraBridgeDestinations(): Promise<Array<{ chainId: number; label: string }>> {
  if (!synthraBridgeSwitchedOn()) return [];
  try {
    return destinationsFrom(await synthraChains(), config.arc.chainId);
  } catch {
    return [];
  }
}

// ─── Quotes ──────────────────────────────────────────────────────────────

export type BridgeStep = { to: `0x${string}`; data: `0x${string}`; value: bigint; description: string };

export type BridgePlan = {
  quoteId: string;
  /** The id to ask Synthra about afterwards. */
  requestId: string;
  expiresAt: number;
  amountInUnits: bigint;
  amountOutUnits: bigint;
  minimumOutUnits: bigint;
  steps: BridgeStep[];
  route: string;
};

const units = (v: unknown): bigint | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return /^\d{1,60}$/.test(s) ? BigInt(s) : null;
};

/**
 * Turns Synthra's quote into what the wallet will be asked to sign, refusing
 * anything that is not exactly the bridge that was asked for. Pure.
 *
 *   every step is sent by this person's wallet, on this network
 *   the amount going in is the amount asked for, not more
 *   no step carries native value beyond that amount
 *   the quote has not expired, and promises something on the other side
 *   a sane number of steps, each with real calldata to a real address
 */
export function planFromQuote(
  body: unknown,
  want: {
    user: string;
    sourceChainId: number;
    destinationChainId: number;
    amountInUnits: bigint;
    /** The token being moved: the only one a step may ask to spend. */
    tokenIn: string;
  },
  now = Date.now(),
): BridgePlan {
  const b = (body ?? {}) as Record<string, unknown>;
  const q = (b.quote ?? {}) as Record<string, unknown>;
  if (b.state !== "Success" || q.state === "Not found") {
    throw new SynthraBridgeError("There is no route for that right now.", 409, "NO_ROUTE");
  }
  const expiresAt = Number(b.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 5_000) {
    throw new SynthraBridgeError("That price has expired. Ask again.", 409, "EXPIRED");
  }
  if (Number(q.sourceChainId) !== want.sourceChainId || Number(q.destinationChainId) !== want.destinationChainId) {
    throw new SynthraBridgeError("The bridge service answered for a different network.", 502, "WRONG_ROUTE");
  }
  const amountIn = units(q.amountIn);
  const maxIn = units(q.maximumAmountIn) ?? amountIn;
  const amountOut = units(q.amountOut);
  const minOut = units(q.minimumAmountOut);
  if (amountIn == null || amountOut == null || minOut == null || maxIn == null) {
    throw new SynthraBridgeError("The bridge service sent a price that cannot be read.", 502, "BAD_QUOTE");
  }
  if (amountIn !== want.amountInUnits || maxIn > want.amountInUnits) {
    throw new SynthraBridgeError("The bridge service priced a different amount.", 502, "WRONG_AMOUNT");
  }
  if (minOut <= 0n || amountOut < minOut) {
    throw new SynthraBridgeError("The bridge service promised nothing on the other side.", 502, "BAD_QUOTE");
  }
  const requestId = String(q.executionRequestId ?? "");
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(requestId)) {
    throw new SynthraBridgeError("The bridge service gave nothing to follow this by.", 502, "BAD_QUOTE");
  }

  const steps: BridgeStep[] = [];
  for (const rawStep of Array.isArray(q.steps) ? q.steps : []) {
    const step = rawStep as Record<string, unknown>;
    for (const rawItem of Array.isArray(step.items) ? step.items : []) {
      const item = rawItem as Record<string, unknown>;
      const d = (item.data ?? {}) as Record<string, unknown>;
      // Anything that is not a transaction (a signature request, say) is not
      // something this wallet can do safely from here.
      if ((item.kind ?? step.kind) !== "transaction") {
        throw new SynthraBridgeError("This route needs a step Evabob cannot sign yet.", 409, "UNSUPPORTED_STEP");
      }
      const to = String(d.to ?? "");
      const data = String(d.data ?? "0x");
      const value = units(d.value ?? "0");
      if (!ADDRESS.test(to) || /^0x0{40}$/i.test(to) || !HEX.test(data) || data.length % 2 !== 0 || value == null) {
        throw new SynthraBridgeError("The bridge service sent a step that cannot be read.", 502, "BAD_STEP");
      }
      if (String(d.from ?? "").toLowerCase() !== want.user.toLowerCase()) {
        throw new SynthraBridgeError("The bridge service built this for a different wallet.", 502, "WRONG_WALLET");
      }
      if (Number(d.chainId) !== want.sourceChainId) {
        throw new SynthraBridgeError("The bridge service built a step for a different network.", 502, "WRONG_ROUTE");
      }
      if (value > want.amountInUnits * 10n ** 12n) {
        // Native value is 18-decimal; the dollars asked for are 6-decimal.
        throw new SynthraBridgeError("A step asks for more than the amount you are moving.", 502, "WRONG_AMOUNT");
      }
      if (data === "0x" && value === 0n) {
        throw new SynthraBridgeError("The bridge service sent an empty step.", 502, "BAD_STEP");
      }
      // approve(spender, amount): only this token, and never for more than
      // is being moved. An open-ended approval would outlive this bridge.
      if (data.toLowerCase().startsWith("0x095ea7b3")) {
        const allowance = data.length === 138 ? BigInt(`0x${data.slice(74)}`) : null;
        if (to.toLowerCase() !== want.tokenIn.toLowerCase() || allowance == null || allowance > want.amountInUnits) {
          throw new SynthraBridgeError("A step asks to spend more than the amount you are moving.", 502, "WRONG_AMOUNT");
        }
      }
      steps.push({
        to: to as `0x${string}`,
        data: data as `0x${string}`,
        value,
        description: String(step.description ?? step.action ?? step.id ?? "Bridge step").slice(0, 120),
      });
    }
  }
  if (steps.length === 0 || steps.length > 4) {
    throw new SynthraBridgeError("The bridge service sent an unusable route.", 502, "BAD_QUOTE");
  }
  return {
    quoteId: String(b.quoteId ?? ""),
    requestId,
    expiresAt,
    amountInUnits: amountIn,
    amountOutUnits: amountOut,
    minimumOutUnits: minOut,
    steps,
    route: String(q.routeSummary ?? q.source ?? "Synthra").slice(0, 120),
  };
}

/** Asks Synthra to move USDC from this network to another, for one wallet. */
export async function quoteBridge(input: {
  user: string;
  recipient: string;
  destinationChainId: number;
  amountUnits: bigint;
  slippageBps?: number;
}): Promise<BridgePlan> {
  if (!synthraBridgeSwitchedOn()) throw new SynthraBridgeError("Bridging through Synthra is not switched on.", 409, "OFF");
  const out = USDC_BY_CHAIN[input.destinationChainId];
  const allowed = await synthraBridgeDestinations();
  if (!out || !allowed.some((d) => d.chainId === input.destinationChainId)) {
    throw new SynthraBridgeError("That network is not available for this.", 404, "UNSUPPORTED_CHAIN");
  }
  if (!ADDRESS.test(input.user) || !ADDRESS.test(input.recipient)) {
    throw new SynthraBridgeError("That is not a wallet address.");
  }
  const body = await call("/v1/swap/quote", {
    method: "POST",
    body: {
      user: input.user,
      recipient: input.recipient,
      sourceChainId: config.arc.chainId,
      destinationChainId: input.destinationChainId,
      tokenIn: { address: config.arc.usdc, decimals: 6, symbol: "USDC" },
      tokenOut: { address: out.address, decimals: 6, symbol: "USDC" },
      amount: input.amountUnits.toString(),
      tradeType: "EXACT_INPUT",
      slippageBps: Math.min(500, Math.max(1, Math.round(input.slippageBps ?? 50))),
    },
  });
  return planFromQuote(body, {
    user: input.user,
    sourceChainId: config.arc.chainId,
    destinationChainId: input.destinationChainId,
    amountInUnits: input.amountUnits,
    tokenIn: config.arc.usdc,
  });
}

// ─── Following one ───────────────────────────────────────────────────────

export type BridgeState = "waiting" | "pending" | "arrived" | "failed" | "returned";

/** Synthra's status, in Evabob's words. Pure. */
export function parseStatus(body: unknown): { state: BridgeState; destinationTx: string | null; final: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = String(b.status ?? b.state ?? "unknown").toLowerCase();
  const txs = [b.destinationTxHash, b.destinationTx, (b.txHashes as unknown[] | undefined)?.at?.(-1), b.outTxHash];
  const tx = txs.map((t) => (typeof t === "string" ? t : "")).find((t) => /^0x[a-fA-F0-9]{64}$/.test(t)) ?? null;
  const state: BridgeState =
    // Arrived only with proof on the other side; "success" without it waits.
    raw === "success" ? (tx ? "arrived" : "pending")
      : raw === "failure" ? "failed"
        : raw === "refund" ? "returned"
          : raw === "pending" || raw === "delayed" ? "pending"
            : "waiting";
  return { state, destinationTx: tx, final: state === "arrived" || state === "failed" || state === "returned" };
}

export async function bridgeStatus(requestId: string) {
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(requestId)) throw new SynthraBridgeError("No such bridge.", 404);
  return parseStatus(await call(`/v1/swap/status?requestId=${encodeURIComponent(requestId)}`));
}

/** For the health page. Never includes the key. */
export function synthraBridgeHealth() {
  return { switchedOn: synthraBridgeSwitchedOn(), host: host(), homeChainId: config.arc.chainId };
}
