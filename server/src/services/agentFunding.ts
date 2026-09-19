/**
 * Verifies that an agent-wallet deposit was actually paid on chain.
 *
 * `POST /v1/agents/:id/deposit` used to credit `balanceUsdc` whenever the body
 * carried any `fundTxHash` string, any `fundActivityId`, or
 * `allowLedgerOnly: true`. None of those were checked against the chain, and
 * the resulting balance is spendable through `POST /v1/x402/pay`. In the old
 * shared-custody design a caller could therefore mint an arbitrary ledger
 * balance and drain real USDC. New agents instead receive a dedicated Circle
 * EOA and the verified funding is deposited into that address's Gateway
 * balance before it becomes spendable.
 *
 * A deposit is now only credited when the referenced transaction:
 *   1. succeeded on Arc,
 *   2. contains a USDC Transfer whose recipient is the agent's custody
 *      address,
 *   3. was sent from the depositing user's own wallet,
 *   4. moved at least the claimed amount, and
 *   5. has not already been credited to any agent.
 */

import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { getPublicClient } from "./arc-wallet.js";

/** USDC has 6 decimals on Arc. */
const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export type FundingVerification =
  | { ok: true; creditedUsdc: number; txHash: Hex; from: Address }
  | { ok: false; reason: string };

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Whole USDC as a number, rounded down to the token's 6 decimals. */
export function atomicToUsdc(atomic: bigint): number {
  return Number(atomic) / Number(USDC_SCALE);
}

/** Smallest representable USDC unit for a decimal amount. */
export function usdcToAtomic(amount: number): bigint {
  return BigInt(Math.round(amount * Number(USDC_SCALE)));
}

/**
 * Reads `txHash` from Arc and returns the total USDC it moved into
 * `custodyAddress` from `expectedSender`.
 */
/** Minimal surface this module needs, so tests can supply a fake receipt. */
export type ReceiptLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
};

export type ReceiptReader = {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: string;
    logs: readonly ReceiptLog[];
  }>;
};

/**
 * Verifies a USDC deposit on Arc.
 *
 * Written for agent wallets, but the question — "did this transaction really
 * move at least this much USDC from that person to that address?" — is the
 * same one the chat escrow has to ask before it records money as locked, so
 * the core takes a plain destination address and both features share it.
 */
export async function verifyUsdcDeposit(
  input: {
    txHash: string;
    /** Where the money had to land: agent custody, or the escrow hold. */
    toAddress: string;
    expectedSender: string;
    minAmountUsdc: number;
  },
  /** Injectable for tests; defaults to the Arc public client. */
  client: ReceiptReader = getPublicClient() as unknown as ReceiptReader,
): Promise<FundingVerification> {
  const { txHash, toAddress, expectedSender, minAmountUsdc } = input;

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, reason: "fundTxHash is not a transaction hash" };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return { ok: false, reason: "No destination address configured" };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(expectedSender)) {
    return { ok: false, reason: "Finish wallet setup before funding" };
  }
  const custodyAddress = toAddress;

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  } catch {
    // An unmined or unknown hash lands here. Treat as not-yet-verifiable
    // rather than invalid, so a client can retry once the tx settles.
    return { ok: false, reason: "Transaction not found on Arc yet" };
  }

  if (receipt.status !== "success") {
    return { ok: false, reason: "That transaction did not succeed" };
  }

  // Sum every USDC Transfer in the tx that credits custody from the user.
  // Summing rather than taking the first entry keeps batched or split
  // transfers honest without letting an unrelated leg count.
  let credited = 0n;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, config.arc.usdc)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: erc20TransferAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue; // not a Transfer
    }
    if (decoded.eventName !== "Transfer") continue;
    const { from, to, value } = decoded.args;
    if (!sameAddress(to, custodyAddress)) continue;
    if (!sameAddress(from, expectedSender)) continue;
    credited += value;
  }

  if (credited === 0n) {
    return {
      ok: false,
      reason:
        "That transaction did not move USDC from your wallet to the expected address",
    };
  }

  const required = usdcToAtomic(minAmountUsdc);
  if (credited < required) {
    return {
      ok: false,
      reason: `That transaction moved ${atomicToUsdc(credited)} USDC, less than the ${minAmountUsdc} claimed`,
    };
  }

  return {
    ok: true,
    // Credit what actually arrived, never what the caller asked for.
    creditedUsdc: atomicToUsdc(credited),
    txHash: txHash as Hex,
    from: expectedSender as Address,
  };
}

/**
 * Agent-wallet wording over {@link verifyUsdcDeposit}.
 *
 * Kept so the agent deposit route and its tests read in their own terms.
 */
export async function verifyAgentFunding(
  input: {
    txHash: string;
    custodyAddress: string;
    expectedSender: string;
    minAmountUsdc: number;
  },
  client?: ReceiptReader,
): Promise<FundingVerification> {
  return verifyUsdcDeposit(
    {
      txHash: input.txHash,
      toAddress: input.custodyAddress,
      expectedSender: input.expectedSender,
      minAmountUsdc: input.minAmountUsdc,
    },
    client,
  );
}

// ─── Top-ups left unfinished ────────────────────────────────────────────

const reconciling = new Set<string>();

/**
 * Finishes agent top-ups that did not complete in the request that started
 * them, and retries ones that failed. Runs on the tick.
 *
 *   depositing  the deposit transaction was sent; once Circle reports it done
 *               and Gateway shows the money, the agent is credited.
 *   failed      the money is still in the agent's own wallet on Arc (the old
 *               code tried to deposit the full amount, and the network fee
 *               made that impossible). It is deposited again, less the fee.
 *
 * Each top-up is credited once: completeAgentGatewayFunding refuses a funding
 * transaction it has already counted.
 */
export async function reconcileAgentFunding(): Promise<{ credited: number; retried: number; errors: string[] }> {
  const { store } = await import("../store/db.js");
  const wallet = await import("./agentWallet.js");
  const { fetchGatewayBalances } = await import("./gateway.js");
  const { alertUser } = await import("./notifyUser.js");
  const { randomUUID } = await import("node:crypto");
  const errors: string[] = [];
  let credited = 0;
  let retried = 0;
  for (const agent of store.listAllAgents()) {
    if (agent.custodyMode !== "circle-eoa" || !agent.custodyAddress || !agent.circleWalletId) continue;
    const open = (agent.gatewayDeposits ?? []).filter((g) => g.status !== "ready");
    if (open.length === 0 || reconciling.has(agent.id)) continue;
    reconciling.add(agent.id);
    try {
      for (const g of open) {
        if (store.isFundTxUsed(g.fundTxHash)) {
          g.status = "ready";
          store.save();
          continue;
        }
        if (g.status === "failed" || (g.status === "approving" && !g.depositTransactionId)) {
          const attempts = (g as { attempts?: number }).attempts ?? 0;
          if (attempts >= 3) continue;
          (g as { attempts?: number }).attempts = attempts + 1;
          try {
            const out = await wallet.depositAgentWalletToGateway({
              walletAddress: agent.custodyAddress as Address,
              amountUsdc: g.amountUsdc,
              approveIdempotencyKey: randomUUID(),
              depositIdempotencyKey: randomUUID(),
              async onApproveCreated(id) {
                g.approveTransactionId = id;
                store.save();
              },
              async onDepositCreated(id, amountUsdc) {
                g.depositTransactionId = id;
                g.amountUsdc = amountUsdc;
                g.status = "depositing";
                delete g.error;
                store.save();
              },
            });
            g.depositTxHash = out.depositTxHash;
            g.amountUsdc = out.depositedUsdc;
            g.status = "depositing";
            retried += 1;
          } catch (e) {
            g.error = e instanceof Error ? e.message : String(e);
            if (!(e instanceof wallet.GatewayDepositPendingError)) g.status = "failed";
            store.save();
            continue;
          }
        }
        if (g.status === "depositing" && g.depositTransactionId) {
          const tx = await wallet.circleTransactionState(g.depositTransactionId);
          if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
            g.status = "failed";
            delete g.depositTransactionId;
            store.save();
            continue;
          }
          if (tx.state !== "COMPLETE" && tx.state !== "CONFIRMED") continue;
          const gateway = await fetchGatewayBalances(agent.custodyAddress as `0x${string}`);
          // Gateway credits a deposit once the source chain finalises it.
          if (gateway.totalUsdc + 0.000001 < agent.balanceUsdc + g.amountUsdc) continue;
          const done = store.completeAgentGatewayFunding(agent, g.fundTxHash, g.amountUsdc);
          g.status = "ready";
          g.depositTxHash = g.depositTxHash ?? tx.txHash;
          store.save();
          if (done.fresh) {
            credited += 1;
            alertUser(agent.userId, {
              kind: "money_in",
              title: `${g.amountUsdc} USDC is in ${agent.label}`,
              body: "Its top-up has finished. It can spend it, and you can take it out.",
              amountUsdc: g.amountUsdc,
              token: "USDC",
              link: `evabob://agents/${agent.id}`,
            });
          }
        }
      }
    } catch (e) {
      errors.push(`${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reconciling.delete(agent.id);
    }
  }
  return { credited, retried, errors };
}
