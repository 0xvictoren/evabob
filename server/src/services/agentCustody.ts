/**
 * Legacy agent custody retained only so existing wallets can withdraw.
 *
 * New agents are provisioned with a dedicated Circle-held EOA in
 * `agentWallet.ts`. Older records predate that isolation and point at one of:
 *  - Preferred: APP_KIT_DC_WALLET / CIRCLE_DC_WALLET (developer-controlled)
 *  - Fallback: PRIVATE_KEY ops address
 *
 * Legacy funding and paid execution are rejected. This resolver remains for
 * owner-authenticated withdrawal of funds already attributed to those rows.
 *
 * Docs: https://developers.circle.com/agent-stack/agent-wallets
 */
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

export type AgentCustody = {
  address: `0x${string}`;
  chain: "Arc_Testnet";
  /** circle-dc | viem-ops */
  mode: "circle-dc" | "viem-ops";
  note: string;
};

export function resolveAgentCustodyAddress(): AgentCustody {
  const dc = (config.appKit.dcWalletAddress || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(dc)) {
    return {
      address: dc as `0x${string}`,
      chain: "Arc_Testnet",
      mode: "circle-dc",
      note: "Fund via UCW PIN send to this Circle developer-controlled wallet (agent custody).",
    };
  }
  const pk = config.arc.privateKey?.trim();
  if (pk) {
    const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    const account = privateKeyToAccount(key);
    return {
      address: account.address,
      chain: "Arc_Testnet",
      mode: "viem-ops",
      note: "Fund via UCW PIN send to ops wallet (PRIVATE_KEY).",
    };
  }
  throw new Error(
    "Agent custody not configured — set APP_KIT_DC_WALLET or PRIVATE_KEY",
  );
}

/** Daily spend reset helper (UTC day). */
export function maybeResetDailySpend(agent: {
  spentTodayUsdc: number;
  spentDay?: string;
}): { spentTodayUsdc: number; spentDay: string } {
  const day = new Date().toISOString().slice(0, 10);
  if (agent.spentDay && agent.spentDay !== day) {
    return { spentTodayUsdc: 0, spentDay: day };
  }
  return {
    spentTodayUsdc: agent.spentTodayUsdc ?? 0,
    spentDay: agent.spentDay || day,
  };
}
