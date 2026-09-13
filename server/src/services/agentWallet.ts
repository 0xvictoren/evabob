/**
 * Agent wallets — one Circle developer-controlled EOA per agent, on Arc.
 *
 * Why an EOA, and why Circle holds the key:
 *
 * Circle Nanopayments settle x402 payments by batching offchain EIP-3009
 * authorizations, and the docs are explicit that this "requires EOA signatures
 * and does not support ERC-1271". A user's own Evabob wallet is a Circle
 * user-controlled *smart contract* account, so it can never be the payer for a
 * nanopayment. The agent wallet therefore has to be a separate EOA.
 *
 * The key lives in Circle's MPC rather than on this server, so a breach here
 * cannot drain an agent's balance. Signing costs one API round trip, which is
 * the trade for not holding raw keys.
 *
 * Each agent gets its own wallet, which also ends the previous arrangement
 * where every agent shared one ops address and the per-agent balance was only
 * a number in a JSON file.
 *
 * Verified against Circle on Arc testnet: an EOA created here signs an
 * EIP-3009 TransferWithAuthorization whose signature recovers to its own
 * address.
 */

import {
  initiateDeveloperControlledWalletsClient,
  type Blockchain,
} from "@circle-fin/developer-controlled-wallets";
import type { Address, Hex } from "viem";
import { config } from "../config.js";

/** Circle's identifier for Arc testnet. */
const ARC_TESTNET: Blockchain = "ARC-TESTNET" as Blockchain;

/** Keeps agent funds out of the ops / fee / forwarder wallet set. */
const AGENT_WALLET_SET_NAME = "evabob-agent-wallets";

export type ProvisionedAgentWallet = {
  /** Circle wallet id, used to request signatures. */
  walletId: string;
  /** The EOA address that holds USDC and signs authorizations. */
  address: Address;
  blockchain: string;
};

let client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null =
  null;

export function agentWalletsConfigured(): boolean {
  return Boolean(config.circle.apiKey && config.circle.entitySecret);
}

function getClient() {
  if (!agentWalletsConfigured()) {
    throw new Error(
      "Agent wallets need CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET",
    );
  }
  if (!client) {
    client = initiateDeveloperControlledWalletsClient({
      apiKey: config.circle.apiKey,
      entitySecret: config.circle.entitySecret,
    });
  }
  return client;
}

// The set id rarely changes; look it up once per process.
let cachedWalletSetId: string | null = null;

/** Finds the agent wallet set by name, creating it the first time. */
export async function ensureAgentWalletSet(): Promise<string> {
  if (cachedWalletSetId) return cachedWalletSetId;
  const api = getClient();

  const existing = (await api.listWalletSets({})).data?.walletSets ?? [];
  // `name` is returned by the API but missing from the SDK's type.
  const found = existing.find(
    (s) => (s as { name?: string }).name === AGENT_WALLET_SET_NAME,
  );
  if (found?.id) {
    cachedWalletSetId = found.id;
    return found.id;
  }

  const created = await api.createWalletSet({ name: AGENT_WALLET_SET_NAME });
  const id = created.data?.walletSet?.id;
  if (!id) throw new Error("Circle did not return a wallet set id");
  console.log(`[agent-wallet] created wallet set ${AGENT_WALLET_SET_NAME} (${id})`);
  cachedWalletSetId = id;
  return id;
}

/** Creates a fresh EOA on Arc for one agent. */
export async function provisionAgentWallet(): Promise<ProvisionedAgentWallet> {
  const api = getClient();
  const walletSetId = await ensureAgentWalletSet();

  const created = await api.createWallets({
    walletSetId,
    blockchains: [ARC_TESTNET],
    // EOA is required: nanopayments reject smart-contract signers.
    accountType: "EOA",
    count: 1,
  });

  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) {
    throw new Error("Circle did not return an agent wallet");
  }
  return {
    walletId: wallet.id,
    address: wallet.address as Address,
    blockchain: wallet.blockchain ?? "ARC-TESTNET",
  };
}

/** Current USDC held by an agent wallet, as reported by Circle. */
export async function agentWalletBalance(walletId: string): Promise<number> {
  const api = getClient();
  const res = await api.getWalletTokenBalance({ id: walletId });
  const rows = res.data?.tokenBalances ?? [];
  const usdc = rows.find(
    (b) => (b.token?.symbol ?? "").toUpperCase() === "USDC",
  );
  return Number(usdc?.amount ?? 0);
}

type CircleTransaction = {
  id?: string;
  state?: string;
  txHash?: string;
};

const TERMINAL = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED"]);

export class GatewayDepositPendingError extends Error {
  constructor(readonly transactionId: string, readonly state: string) {
    super(`Gateway deposit transaction ${transactionId} is still ${state}`);
  }
}

export class CircleTransactionFailedError extends Error {
  constructor(readonly transactionId: string, readonly state: string) {
    super(`Circle transaction ${transactionId} failed with state ${state}`);
  }
}

async function waitForCircleTransaction(
  id: string,
  timeoutMs = 120_000,
): Promise<CircleTransaction> {
  const api = getClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await api.getTransaction({ id })).data?.transaction as CircleTransaction | undefined;
    const state = row?.state || "UNKNOWN";
    if (TERMINAL.has(state)) {
      if (state !== "COMPLETE" && state !== "CONFIRMED") {
        throw new CircleTransactionFailedError(id, state);
      }
      return row || { id, state };
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const latest = (await api.getTransaction({ id })).data?.transaction as CircleTransaction | undefined;
  throw new GatewayDepositPendingError(id, latest?.state || "PENDING");
}

function amountAtomic(amountUsdc: number): string {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0 ||
      !/^\d+(\.\d{1,6})?$/.test(String(amountUsdc))) {
    throw new Error("Gateway deposit amount must have at most 6 decimals");
  }
  const [whole, fraction = ""] = String(amountUsdc).split(".");
  return `${whole}${(fraction + "000000").slice(0, 6)}`.replace(/^0+(?=\d)/, "");
}

/** Approves and deposits a dedicated Circle EOA's USDC into Gateway. */
export async function depositAgentWalletToGateway(input: {
  walletAddress: Address;
  amountUsdc: number;
  approveTransactionId?: string;
  depositTransactionId?: string;
  approveIdempotencyKey: string;
  depositIdempotencyKey: string;
  onApproveCreated(id: string): Promise<void>;
  onDepositCreated(id: string): Promise<void>;
}): Promise<{ approveTransactionId: string; depositTransactionId: string; depositTxHash?: string }> {
  const api = getClient();
  const amount = amountAtomic(input.amountUsdc);
  let approveId = input.approveTransactionId;
  if (!approveId) {
    const created = await api.createContractExecutionTransaction({
      idempotencyKey: input.approveIdempotencyKey,
      walletAddress: input.walletAddress,
      blockchain: ARC_TESTNET,
      contractAddress: config.arc.usdc,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [config.arc.gatewayWallet, amount],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    approveId = created.data?.id;
    if (!approveId) throw new Error("Circle returned no approval transaction id");
    await input.onApproveCreated(approveId);
  }
  await waitForCircleTransaction(approveId);

  let depositId = input.depositTransactionId;
  if (!depositId) {
    const created = await api.createContractExecutionTransaction({
      idempotencyKey: input.depositIdempotencyKey,
      walletAddress: input.walletAddress,
      blockchain: ARC_TESTNET,
      contractAddress: config.arc.gatewayWallet,
      abiFunctionSignature: "deposit(address,uint256)",
      abiParameters: [config.arc.usdc, amount],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    depositId = created.data?.id;
    if (!depositId) throw new Error("Circle returned no Gateway deposit transaction id");
    await input.onDepositCreated(depositId);
  }
  const deposited = await waitForCircleTransaction(depositId);
  return {
    approveTransactionId: approveId,
    depositTransactionId: depositId,
    depositTxHash: deposited.txHash,
  };
}

/**
 * EIP-712 domain fields, declared explicitly.
 *
 * Circle validates typed data more strictly than viem does: omitting the
 * EIP712Domain type is rejected with
 * `there is extra data provided in the message (0 < 4)`, because the domain
 * carries four fields the type list never declared. viem leaves EIP712Domain
 * out by convention, so the adapter below has to add it back.
 */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/**
 * Adapts a Circle-held EOA to the signer interface `@circle-fin/x402-batching`
 * expects, so the batching scheme can sign without ever seeing a private key.
 *
 * `GatewayClient` in that SDK takes a raw private key and is therefore unusable
 * here; `BatchEvmScheme` accepts this `{ address, signTypedData }` shape, which
 * is what makes MPC-held keys work with nanopayments at all.
 */
export function circleBatchSigner(input: {
  walletId: string;
  address: Address;
}): {
  address: Address;
  signTypedData: (params: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
} {
  return {
    address: input.address,
    async signTypedData(params) {
      const api = getClient();
      const payload = {
        domain: params.domain,
        types: {
          EIP712Domain: [...EIP712_DOMAIN_TYPE],
          ...params.types,
        },
        primaryType: params.primaryType,
        message: params.message,
      };
      const signed = await api.signTypedData({
        walletId: input.walletId,
        data: JSON.stringify(payload),
      });
      const signature = signed.data?.signature;
      if (!signature) {
        throw new Error("Circle returned no signature for the payment authorization");
      }
      return signature as Hex;
    },
  };
}

/** Circle-held signer for the official Gateway BurnIntent EIP-712 shape. */
export function circleGatewayBurnSigner(input: {
  walletId: string;
  address: Address;
}) {
  return {
    address: input.address,
    async signTypedData(params: {
      domain: { name: string; version: string };
      types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<Hex> {
      const payload = {
        domain: params.domain,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
          ],
          ...params.types,
        },
        primaryType: params.primaryType,
        message: params.message,
      };
      const signed = await getClient().signTypedData({
        walletId: input.walletId,
        data: JSON.stringify(payload, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value),
      });
      const signature = signed.data?.signature;
      if (!signature) throw new Error("Circle returned no Gateway burn signature");
      return signature as Hex;
    },
  };
}
