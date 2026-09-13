import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
  type PublicClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  sepolia,
} from "viem/chains";
import { config } from "../config.js";
import {
  arcTestnet,
  getPublicClient,
  getWalletClient,
  getDeployerAccount,
} from "./arc-wallet.js";

/** CCTP V2 TokenMessenger — same CREATE2 address on Arc + EVM testnets */
const TOKEN_MESSENGER =
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address;

/** CCTP V2 MessageTransmitter — same CREATE2 on Arc + EVM testnets */
const MESSAGE_TRANSMITTER =
  "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address;

const USDC = config.arc.usdc as Address;

function envRpc(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function uniqueUrls(...items: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const u = raw?.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function destEntry(
  chain: Chain,
  name: string,
  urls: string[],
): { chain: Chain; name: string; rpcUrl: string; rpcUrls: string[] } {
  if (urls.length === 0) {
    throw new Error(`No RPC URLs configured for ${name}`);
  }
  return { chain, name, rpcUrl: urls[0]!, rpcUrls: urls };
}

/** Prefer a paid/env RPC, then public nodes — never depend on one gas oracle. */
function destTransport(urls: string[]) {
  return fallback(
    urls.map((url) => http(url, { timeout: 12_000, retryCount: 0 })),
    { retryCount: 1 },
  );
}

function isGasOracleError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /eth_gasPrice|eth_maxPriorityFeePerGas|no backend is currently healthy|no backoff is currently/i.test(
    msg,
  );
}

/** CCTP domain → destination chain config for mint (receiveMessage). */
const DEST_CHAINS: Record<
  number,
  { chain: Chain; rpcUrl: string; rpcUrls: string[]; name: string }
> = {
  0: destEntry(
    sepolia,
    "Ethereum Sepolia",
    uniqueUrls(
      envRpc("ETH_SEPOLIA_RPC_URL"),
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
    ),
  ),
  1: destEntry(
    avalancheFuji,
    "Avalanche Fuji",
    uniqueUrls(
      envRpc("AVAX_FUJI_RPC_URL"),
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
    ),
  ),
  3: destEntry(
    arbitrumSepolia,
    "Arbitrum Sepolia",
    uniqueUrls(
      envRpc("ARB_SEPOLIA_RPC_URL"),
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
    ),
  ),
  6: destEntry(
    baseSepolia,
    "Base Sepolia",
    uniqueUrls(
      envRpc("BASE_SEPOLIA_RPC_URL"),
      // Official sepolia.base.org often 503s eth_gasPrice ("no backend is currently healthy").
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
      "https://sepolia.base.org",
    ),
  ),
  26: destEntry(arcTestnet as unknown as Chain, "Arc Testnet", [
    config.arc.rpcUrl,
  ]),
};

/** Ops PRIVATE_KEY clients for an EVM dest domain (CCTP receive or Gateway mint). */
export function createOpsDestClients(domain: number) {
  const dest = DEST_CHAINS[domain];
  if (!dest) {
    throw new Error(`No EVM dest RPC for domain ${domain}`);
  }
  const pk = config.arc.privateKey;
  if (!pk) throw new Error("PRIVATE_KEY required for destination mint");
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  const account = privateKeyToAccount(key);
  const transport = destTransport(dest.rpcUrls);
  const publicClient = createPublicClient({
    chain: dest.chain,
    transport,
  });
  const wallet = createWalletClient({
    account,
    chain: dest.chain,
    transport,
  });
  return { dest, account, publicClient, wallet };
}

/** Domains where ops wallet can submit receiveMessage (product bridge destinations). */
export const CCTP_SUPPORTED_MINT_DOMAINS: Record<number, string> = {
  0: DEST_CHAINS[0]!.name,
  1: DEST_CHAINS[1]!.name,
  3: DEST_CHAINS[3]!.name,
  6: DEST_CHAINS[6]!.name,
};

export function cctpMintDomainName(domain: number): string {
  return (
    DEST_CHAINS[domain]?.name ||
    CCTP_SUPPORTED_MINT_DOMAINS[domain] ||
    `domain ${domain}`
  );
}

export function isCctpMintSupported(domain: number): boolean {
  return domain in CCTP_SUPPORTED_MINT_DOMAINS;
}

const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
  },
] as const;

const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function addressToBytes32(addr: Address): Hex {
  return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

/**
 * Burn USDC on Arc via CCTP V2 for mint on destination domain.
 */
export async function cctpBurnFromArc(input: {
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: Address;
  maxFeeUsdc?: number;
}) {
  const amount = parseUnits(String(input.amountUsdc), 6);
  const maxFee = parseUnits(String(input.maxFeeUsdc ?? 0), 6);
  const wallet = getWalletClient();
  const publicClient = getPublicClient();
  const account = getDeployerAccount();

  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [TOKEN_MESSENGER, amount],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const burnHash = await wallet.writeContract({
    address: TOKEN_MESSENGER,
    abi: tokenMessengerAbi,
    functionName: "depositForBurn",
    args: [
      amount,
      input.destinationDomain,
      addressToBytes32(input.mintRecipient),
      USDC,
      addressToBytes32("0x0000000000000000000000000000000000000000"),
      maxFee,
      1000, // CCTP V2 FAST transfer (minFinalityThreshold ≤ 1000)
    ],
    account,
    chain: arcTestnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: burnHash,
  });

  return {
    approveTx: approveHash,
    burnTx: burnHash,
    blockNumber: receipt.blockNumber.toString(),
    amountUsdc: input.amountUsdc,
    destinationDomain: input.destinationDomain,
    mintRecipient: input.mintRecipient,
    note: "Poll Circle Iris attestation API with burn tx, then receiveMessage on dest",
    irisHint: `https://iris-api-sandbox.circle.com/v2/messages/${config.arc.cctpDomain}?transactionHash=${burnHash}`,
  };
}

/** Fetch CCTP attestation from Circle Iris (sandbox for testnet). */
export async function fetchCctpAttestation(
  sourceDomain: number,
  txHash: string,
) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

/**
 * Mint on Arc using CCTP message + attestation (after burn on another chain).
 */
export async function cctpReceiveOnArc(message: Hex, attestation: Hex) {
  return cctpReceiveOnDomain({
    destinationDomain: 26,
    message,
    attestation,
  });
}

async function writeReceiveMessage(input: {
  wallet: WalletClient;
  publicClient: PublicClient;
  account: Account;
  chain: Chain;
  message: Hex;
  attestation: Hex;
}): Promise<Hex> {
  const request = {
    address: MESSAGE_TRANSMITTER,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage" as const,
    args: [input.message, input.attestation] as const,
    account: input.account,
    chain: input.chain,
  };
  try {
    return await input.wallet.writeContract(request);
  } catch (e) {
    if (!isGasOracleError(e)) throw e;
    // Official public RPCs sometimes 503 only the gas oracle. Latest
    // block still works — derive EIP-1559 fees and skip eth_gasPrice.
    const block = await input.publicClient.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? 1_000_000n;
    const maxPriorityFeePerGas = 10_000_000n;
    console.warn(
      "[cctp] gas oracle failed; retrying receiveMessage with explicit fees",
    );
    return await input.wallet.writeContract({
      ...request,
      maxFeePerGas: base * 2n + maxPriorityFeePerGas,
      maxPriorityFeePerGas,
      gas: 400_000n,
    });
  }
}

/**
 * Mint USDC on a CCTP destination domain (e.g. Base Sepolia = 6).
 * Uses ops PRIVATE_KEY for gas; mintRecipient in the message receives USDC.
 */
export async function cctpReceiveOnDomain(input: {
  destinationDomain: number;
  message: Hex;
  attestation: Hex;
}) {
  const dest = DEST_CHAINS[input.destinationDomain];
  if (!dest) {
    throw new Error(
      `No mint RPC configured for CCTP domain ${input.destinationDomain}. Supported: ${Object.keys(DEST_CHAINS).join(", ")}`,
    );
  }

  const pk = config.arc.privateKey;
  if (!pk) throw new Error("PRIVATE_KEY required to submit CCTP mint");
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  const account = privateKeyToAccount(key);

  const transport = destTransport(dest.rpcUrls);
  const publicClient = createPublicClient({
    chain: dest.chain,
    transport,
  });
  const wallet = createWalletClient({
    account,
    chain: dest.chain,
    transport,
  });

  console.log(
    `[cctp] mint receiveMessage domain=${input.destinationDomain} rpcs=${dest.rpcUrls.join(",")}`,
  );

  const hash = await writeReceiveMessage({
    wallet,
    publicClient,
    account,
    chain: dest.chain,
    message: input.message,
    attestation: input.attestation,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return {
    mintTx: hash,
    blockNumber: receipt.blockNumber.toString(),
    destinationDomain: input.destinationDomain,
    chain: dest.name,
    status: receipt.status,
  };
}

/**
 * Poll Iris until attestation is complete (or timeout), then mint on destination.
 */
export async function cctpCompleteBridge(input: {
  sourceDomain?: number;
  burnTxHash: string;
  destinationDomain: number;
  /** Max wait for Iris (ms). Default 120s. */
  timeoutMs?: number;
  pollMs?: number;
}) {
  const sourceDomain = input.sourceDomain ?? config.arc.cctpDomain;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollMs = input.pollMs ?? 3_000;
  if (!DEST_CHAINS[input.destinationDomain]) {
    return {
      ok: false as const,
      status: "unsupported_domain",
      burnTxHash: input.burnTxHash,
      destinationDomain: input.destinationDomain,
      error: `No mint RPC for domain ${input.destinationDomain}. Supported: ${Object.keys(DEST_CHAINS).join(", ")}`,
    };
  }
  const start = Date.now();

  let message: Hex | undefined;
  let attestation: Hex | undefined;
  let lastStatus = "pending";

  while (Date.now() - start < timeoutMs) {
    const data = (await fetchCctpAttestation(
      sourceDomain,
      input.burnTxHash,
    )) as {
      messages?: Array<{
        status?: string;
        message?: string;
        attestation?: string;
      }>;
    };
    const msg = data.messages?.[0];
    lastStatus = msg?.status || "pending";
    if (
      msg?.status === "complete" &&
      msg.message?.startsWith("0x") &&
      msg.attestation?.startsWith("0x")
    ) {
      message = msg.message as Hex;
      attestation = msg.attestation as Hex;
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!message || !attestation) {
    return {
      ok: false as const,
      status: lastStatus,
      burnTxHash: input.burnTxHash,
      destinationDomain: input.destinationDomain,
      error: `Attestation not complete after ${timeoutMs}ms (last status: ${lastStatus})`,
      irisHint: `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${input.burnTxHash}`,
    };
  }

  try {
    const mint = await cctpReceiveOnDomain({
      destinationDomain: input.destinationDomain,
      message,
      attestation,
    });
    return {
      ok: true as const,
      status: "minted",
      burnTxHash: input.burnTxHash,
      mintTx: mint.mintTx,
      chain: mint.chain,
      destinationDomain: input.destinationDomain,
      blockNumber: mint.blockNumber,
    };
  } catch (e) {
    return {
      ok: false as const,
      status: "attested_mint_failed",
      burnTxHash: input.burnTxHash,
      destinationDomain: input.destinationDomain,
      message,
      attestation,
      error: e instanceof Error ? e.message : "mint failed",
      hint: isGasOracleError(e)
        ? "Destination RPC gas oracle is down. Retry mint — fallback RPCs should submit receiveMessage."
        : "Ops wallet may need gas on the destination chain (e.g. Base Sepolia ETH).",
    };
  }
}

/** Build UCW contract execution payloads for CCTP burn. */
export function buildCctpBurnCalldata(input: {
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: Address;
}) {
  const amount = parseUnits(String(input.amountUsdc), 6);
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [TOKEN_MESSENGER, amount],
  });
  const burnData = encodeFunctionData({
    abi: tokenMessengerAbi,
    functionName: "depositForBurn",
    args: [
      amount,
      input.destinationDomain,
      addressToBytes32(input.mintRecipient),
      USDC,
      addressToBytes32("0x0000000000000000000000000000000000000000"),
      0n,
      1000,
    ],
  });
  return {
    steps: [
      { to: USDC, data: approveData },
      { to: TOKEN_MESSENGER, data: burnData },
    ],
  };
}
