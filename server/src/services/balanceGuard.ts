/**
 * Checks the balance before any transaction is prepared.
 *
 * Every money route used to build the PIN challenge first and let the chain
 * refuse afterwards, so a person with too little money entered their PIN and
 * then saw a failure — or, for multi-step flows, got partway. Asking the
 * chain first, before any challenge exists, means the answer is "not enough
 * money" with nothing signed and nothing moved.
 *
 * An unreadable balance does not block: a flaky RPC must not stop a payment
 * the person can afford. The contract still refuses one they cannot.
 */

import { readChainTokenBalance } from "./arc-balances.js";
import { quotePlatformFee } from "./platformFee.js";
import { store } from "../store/db.js";

const CHAIN_NAMES: Record<string, string> = {
  Arc_Testnet: "Arc",
  Base_Sepolia: "Base Sepolia",
  Ethereum_Sepolia: "Ethereum Sepolia",
};

const DOMAIN_CHAINS: Record<number, string> = {
  26: "Arc_Testnet",
  6: "Base_Sepolia",
  0: "Ethereum_Sepolia",
};

/** The App Kit chain name for a chain name or CCTP domain; Arc when unknown. */
export function guardChain(chain?: string | number | null): string {
  if (typeof chain === "number") return DOMAIN_CHAINS[chain] ?? "Arc_Testnet";
  const raw = (chain ?? "").trim();
  if (!raw) return "Arc_Testnet";
  const hit = Object.keys(CHAIN_NAMES).find((k) => k.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  const lower = raw.toLowerCase();
  if (lower.includes("base")) return "Base_Sepolia";
  if (lower.includes("eth")) return "Ethereum_Sepolia";
  return "Arc_Testnet";
}

function fmt(n: number, token: string) {
  const places = token === "CIRBTC" ? 8 : 2;
  const shown = Number(n.toFixed(places));
  return `${shown} ${token}`;
}

/**
 * Null when the person can afford it (or the balance could not be read),
 * otherwise the sentence to show them.
 */
export async function balanceShortfall(input: {
  userId?: string;
  /** Wallet paying; defaults to the user's own wallet. */
  address?: string | null;
  chain?: string | number | null;
  token?: string;
  amount: number;
  /** Add the Evabob fee charged on top (default true). */
  withFee?: boolean;
}): Promise<string | null> {
  const token = (input.token || "USDC").toUpperCase();
  // Only tokens this server can read; a pasted token address is left to the
  // chain rather than checked against the wrong balance.
  if (!["USDC", "EURC", "CIRBTC"].includes(token)) return null;
  const address =
    input.address && /^0x[a-fA-F0-9]{40}$/.test(input.address)
      ? input.address
      : input.userId
        ? store.getUser(input.userId)?.evmAddress
        : undefined;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;
  const decimals = token === "CIRBTC" ? 8 : 6;
  const fee = input.withFee === false ? 0 : Number(quotePlatformFee(input.amount, decimals).fee);
  const needed = input.amount + fee;
  const chain = guardChain(input.chain);
  let balance: number | null;
  try {
    balance = await readChainTokenBalance({ address, chain, token });
  } catch {
    balance = null;
  }
  if (balance == null || balance + 1e-9 >= needed) return null;
  const where = chain === "Arc_Testnet" ? "" : ` on ${CHAIN_NAMES[chain] ?? chain}`;
  return (
    `Not enough money${where}. You have ${fmt(balance, token)}; this needs ` +
    `${fmt(needed, token)}${fee > 0 ? " including the Evabob fee" : ""}. Nothing was sent.`
  );
}
