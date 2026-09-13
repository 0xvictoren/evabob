import { config, DEPOSIT_CHAINS } from "../config.js";

export type GatewayBalanceRow = {
  domain: number;
  balance: string;
  /**
   * Deposited but not yet finalised on the source chain. Gateway credits
   * `balance` only once the deposit is final there, and that is fast on Arc
   * (seconds) but slow elsewhere — a measured Base Sepolia deposit took ~42
   * minutes. Without this field a deposit that has plainly succeeded on chain
   * looks like nothing happened.
   */
  pendingBatch?: string;
};

export async function fetchGatewayBalances(
  depositor: `0x${string}`,
): Promise<{
  balances: GatewayBalanceRow[];
  totalUsdc: number;
  /** Deposited but not yet final on the source chain. */
  pendingUsdc: number;
}> {
  const url = `${config.gatewayApiBase}/balances`;
  const sources = DEPOSIT_CHAINS.filter(
    (c) => c.kind === "gateway" && c.domain != null,
  ).map((c) => ({ domain: c.domain as number, depositor }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway balances failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    balances?: Array<{ domain: number; balance: string; pendingBatch?: string }>;
  };
  const balances = data.balances ?? [];

  /** Gateway reports whole USDC ("1.000000") or atomic units ("1000000"). */
  const toUsdc = (raw: string | undefined): number => {
    const s = String(raw ?? "0").trim();
    if (!s) return 0;
    if (s.includes(".")) return Number(s) || 0;
    const n = Number(s);
    return Number.isFinite(n) ? n / 1e6 : 0;
  };

  const totalUsdc = balances.reduce((sum, b) => sum + toUsdc(b.balance), 0);
  const pendingUsdc = balances.reduce(
    (sum, b) => sum + toUsdc(b.pendingBatch),
    0,
  );
  return { balances, totalUsdc, pendingUsdc };
}

export function depositAddressCatalog(params: { evmAddress: string }) {
  return DEPOSIT_CHAINS.map((chain) => ({
    id: chain.id,
    name: chain.name,
    family: chain.family,
    domain: chain.domain,
    kind: chain.kind,
    address: params.evmAddress,
    asset: "USDC",
    note:
      "Circle UCW EVM address. For Gateway: use approve + deposit() on that chain (or in-app Fund).",
  }));
}

/**
 * Withdraw intent: user wants USDC on destination domain.
 * Full mint flow requires burn intent signing + gatewayMint — client/server
 * will complete with Circle Wallets once user SCA is linked.
 */
export function buildWithdrawPlan(input: {
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDomain?: number;
}) {
  return {
    status: "planned" as const,
    amountUsdc: input.amountUsdc,
    sourceDomain: input.sourceDomain ?? 26,
    destinationDomain: input.destinationDomain,
    destinationAddress: input.destinationAddress,
    assetOut: "USDC",
    steps: [
      "Create burn intent from Gateway unified balance",
      "Sign burn intent (user-controlled / agent policy)",
      "POST attestation to Gateway API",
      "gatewayMint on destination chain to destinationAddress",
    ],
    note: "Withdraw settles as USDC on the destination chain (not native gas).",
  };
}
