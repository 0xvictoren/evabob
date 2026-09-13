import { randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  maxUint256,
  pad,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { config, DEPOSIT_CHAINS } from "../config.js";
import {
  arcTestnet,
  getPublicClient,
  getWalletClient,
  getDeployerAccount,
} from "./arc-wallet.js";
import { createOpsDestClients } from "./cctp.js";
import { fetchGatewayBalances } from "./gateway.js";

type GatewaySigner = {
  address: Address;
  signTypedData(input: {
    domain: { name: string; version: string };
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
};

/** Gateway API may return micro-units ("17000000") or human ("17.000000"). */
function gatewayBalanceToRaw(balance: string | number | undefined): bigint {
  const s = String(balance ?? "0").trim();
  if (!s || s === "0") return 0n;
  if (s.includes(".")) return parseUnits(s, 6);
  return BigInt(s);
}

const GATEWAY_WALLET = config.arc.gatewayWallet as Address;
const GATEWAY_MINTER = config.arc.gatewayMinter as Address;
const USDC = config.arc.usdc as Address;

/** Testnet USDC by CCTP/Gateway domain. */
export const DEST_USDC_BY_DOMAIN: Record<number, string> = {
  26: USDC,
  0: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia
  6: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  3: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arb Sepolia
  1: "0x5425890298aed601595a70AB815c96711a31Bc65", // Fuji
  16: "0x4fCF1784B31630811181f670Aea7A7bEF803eaED", // Sei test
};

/** Product Gateway domains (Evabob testnet). Cheap-gas order after dest. */
export const PRODUCT_GATEWAY_DOMAINS = [6, 26, 0] as const;

export const GATEWAY_DOMAIN_UCW: Record<number, string> = {
  26: "ARC-TESTNET",
  0: "ETH-SEPOLIA",
  6: "BASE-SEPOLIA",
};

export const GATEWAY_DOMAIN_NAME: Record<number, string> = {
  26: "Arc Testnet",
  0: "Ethereum Sepolia",
  6: "Base Sepolia",
};

/** Circle published burn-gas fees (USDC), used when /estimate is unavailable. */
const GATEWAY_GAS_USDC: Record<number, number> = {
  0: 1.0,
  6: 0.01,
  26: 0.02,
};

export const EVM_GATEWAY_MINT_DOMAINS = new Set([0, 6, 26]);

export function isEvmGatewayDomain(domain: number): boolean {
  return EVM_GATEWAY_MINT_DOMAINS.has(domain);
}

export function encodeGatewayBytes32(domain: number, address: string): Hex {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`Expected 0x address for domain ${domain}`);
  }
  return toBytes32(address as Address);
}

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "addDelegate",
    inputs: [
      { name: "token", type: "address" },
      { name: "delegate", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isAuthorizedForBalance",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "addr", type: "address" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** EIP-712 types for Gateway burn intents (official Circle shape). */
export const GATEWAY_EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export const GATEWAY_TYPED_DOMAIN = {
  name: "GatewayWallet",
  version: "1",
} as const;

function toBytes32(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

function stringifyJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/** Platform EOA used as Gateway burn-intent signer for SCA depositors. */
export function getGatewayPayDelegateAddress(): Address {
  return getDeployerAccount().address;
}

function usdcOnDomain(domain: number): Address {
  return (DEST_USDC_BY_DOMAIN[domain] || USDC) as Address;
}

function publicClientForDomain(domain: number) {
  if (domain === 26) return getPublicClient();
  const { publicClient } = createOpsDestClients(domain);
  return publicClient;
}

/**
 * Whether `addr` may sign burn intents for `depositor`'s Gateway USDC
 * on a given domain's GatewayWallet (same address, different chain).
 */
export async function isGatewayDelegateAuthorized(
  depositor: Address,
  delegate: Address,
  domain = 26,
): Promise<boolean> {
  if (depositor.toLowerCase() === delegate.toLowerCase()) return true;
  const token = usdcOnDomain(domain);
  try {
    const publicClient = publicClientForDomain(domain);
    const ok = await publicClient.readContract({
      address: GATEWAY_WALLET,
      abi: gatewayWalletAbi,
      functionName: "isAuthorizedForBalance",
      args: [token, depositor, delegate],
    });
    return Boolean(ok);
  } catch (e) {
    console.warn(
      `[gateway] isAuthorizedForBalance domain=${domain} failed`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

export type GatewaySourceSlice = {
  domain: number;
  raw: bigint;
  amountUsdc: string;
  name: string;
};

/**
 * Split `need` across confirmed per-domain holdings.
 * Prefers the destination domain (same-chain is cheaper), then low-gas chains.
 */
export function splitConfirmedSources(
  rows: Array<{ domain: number; raw: bigint }>,
  need: bigint,
  destDomain: number,
): GatewaySourceSlice[] {
  const product = new Set<number>(PRODUCT_GATEWAY_DOMAINS);
  const available = rows.filter((r) => product.has(r.domain) && r.raw > 0n);
  const order = [destDomain, ...PRODUCT_GATEWAY_DOMAINS].filter(
    (d, i, a) => a.indexOf(d) === i,
  );
  const sorted = [...available].sort((a, b) => {
    const ia = order.indexOf(a.domain);
    const ib = order.indexOf(b.domain);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  let remaining = need;
  const out: GatewaySourceSlice[] = [];
  for (const r of sorted) {
    if (remaining <= 0n) break;
    const take = r.raw < remaining ? r.raw : remaining;
    if (take <= 0n) continue;
    out.push({
      domain: r.domain,
      raw: take,
      amountUsdc: formatUnits(take, 6),
      name: GATEWAY_DOMAIN_NAME[r.domain] || `domain ${r.domain}`,
    });
    remaining -= take;
  }
  if (remaining > 0n) {
    const err = new Error(
      `Insufficient confirmed unified USDC — need ${formatUnits(need, 6)}, short ${formatUnits(remaining, 6)}`,
    ) as Error & { code: string };
    err.code = "INSUFFICIENT_GATEWAY";
    throw err;
  }
  return out;
}

export async function planGatewayPay(input: {
  depositor: Address;
  amountUsdc: number;
  destinationDomain: number;
  sourceDomain?: number;
  delegate: Address;
}): Promise<{
  slices: GatewaySourceSlice[];
  missingDomains: number[];
  confirmedUsdc: string;
}> {
  const need = parseUnits(String(input.amountUsdc), 6);
  const { balances } = await fetchGatewayBalances(input.depositor);
  const rows = balances.map((b) => ({
    domain: b.domain,
    raw: gatewayBalanceToRaw(b.balance),
  }));
  const confirmedRaw = rows
    .filter((r) => (PRODUCT_GATEWAY_DOMAINS as readonly number[]).includes(r.domain))
    .reduce((s, r) => s + r.raw, 0n);

  let slices: GatewaySourceSlice[];
  if (input.sourceDomain != null) {
    const hit = rows.find((r) => r.domain === input.sourceDomain);
    const have = hit?.raw ?? 0n;
    if (have < need) {
      const err = new Error(
        `Not enough confirmed USDC on ${GATEWAY_DOMAIN_NAME[input.sourceDomain] || input.sourceDomain}`,
      ) as Error & { code: string };
      err.code = "INSUFFICIENT_GATEWAY";
      throw err;
    }
    slices = [
      {
        domain: input.sourceDomain,
        raw: need,
        amountUsdc: formatUnits(need, 6),
        name: GATEWAY_DOMAIN_NAME[input.sourceDomain] || `domain ${input.sourceDomain}`,
      },
    ];
  } else {
    slices = splitConfirmedSources(rows, need, input.destinationDomain);
  }

  const missingDomains: number[] = [];
  for (const s of slices) {
    const ok = await isGatewayDelegateAuthorized(
      input.depositor,
      input.delegate,
      s.domain,
    );
    if (!ok) missingDomains.push(s.domain);
  }

  return {
    slices,
    missingDomains,
    confirmedUsdc: formatUnits(confirmedRaw, 6),
  };
}

/** Deposit USDC from deployer (or provided pk) into Gateway on Arc. */
export async function gatewayDepositArc(amountUsdc: number) {
  const amount = parseUnits(String(amountUsdc), 6);
  const wallet = getWalletClient();
  const publicClient = getPublicClient();
  const account = getDeployerAccount();

  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [GATEWAY_WALLET, amount],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const depositHash = await wallet.writeContract({
    address: GATEWAY_WALLET,
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [USDC, amount],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });

  return {
    approveTx: approveHash,
    depositTx: depositHash,
    amountUsdc,
    amountRaw: amount.toString(),
    depositor: account.address,
  };
}

/**
 * Calldata for user wallet (Circle UCW contract execution) to deposit.
 */
export function buildDepositCalldata(amountUsdc: number) {
  const amount = parseUnits(String(amountUsdc), 6);
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [GATEWAY_WALLET, amount],
  });
  const depositData = encodeFunctionData({
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [USDC, amount],
  });
  return {
    amountRaw: amount.toString(),
    steps: [
      { to: USDC, data: approveData, description: "Approve Gateway Wallet" },
      { to: GATEWAY_WALLET, data: depositData, description: "Gateway deposit" },
    ],
  };
}

export type GatewayBurnIntentJson = {
  maxBlockHeight: string;
  maxFee: string;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: string;
    salt: Hex;
    hookData: Hex;
  };
};

export type GatewayTransferResult = {
  status: "complete" | "attestation_pending" | "forwarded" | "in_transit" | "failed";
  amountUsdc: number;
  amountHuman: string;
  amountRaw: string;
  maxFeeRaw: string;
  sourceDomain: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDepositor: Address;
  sourceSigner: Address;
  mintTx?: string;
  transferId?: string;
  doNotRetry?: boolean;
  gatewayResponse: unknown;
  burnIntent: GatewayBurnIntentJson;
  burnIntents?: GatewayBurnIntentJson[];
  sources?: Array<{ domain: number; amountUsdc: string; name: string }>;
  assetOut: "USDC";
  note?: string;
};

/**
 * Pick a Gateway source domain where the depositor has enough raw USDC.
 */
export async function pickSourceDomainWithBalance(
  depositor: Address,
  amountUsdc: number,
  preferred?: number,
): Promise<number> {
  const need = parseUnits(String(amountUsdc), 6);
  const { balances } = await fetchGatewayBalances(depositor);
  const rows = balances.map((b) => ({
    domain: b.domain,
    raw: gatewayBalanceToRaw(b.balance),
  }));

  if (preferred != null) {
    const hit = rows.find((r) => r.domain === preferred && r.raw >= need);
    if (hit) return hit.domain;
  }
  const withFunds = rows
    .filter((r) => r.raw >= need && r.domain !== 5)
    .sort((a, b) => Number(b.raw - a.raw));
  if (withFunds[0]) return withFunds[0].domain;

  // Default Arc (where in-app Top-up lands)
  return preferred ?? 26;
}

/**
 * Build + sign + submit a Gateway burn intent.
 *
 * Gateway only accepts EOA ECDSA signatures on burn intents (not EIP-1271 SCA).
 * For SCA depositors: `sourceDepositor` = SCA, `sourceSigner` = authorized EOA
 * delegate (platform ops key after user PIN `addDelegate`).
 */
async function gatewayMintOnEvmDomain(input: {
  domain: number;
  attestation: Hex;
  signature: Hex;
}): Promise<Hex> {
  const { dest, account, publicClient, wallet } = createOpsDestClients(
    input.domain,
  );
  const hash = await wallet.writeContract({
    address: GATEWAY_MINTER,
    abi: gatewayMinterAbi,
    functionName: "gatewayMint",
    args: [input.attestation, input.signature],
    account,
    chain: dest.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function pollGatewayTransfer(
  transferId: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<{
  status: string;
  mintTx?: string;
  raw: Record<string, unknown>;
}> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const pollMs = opts?.pollMs ?? 2_000;
  const started = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${config.gatewayApiBase}/transfer/${transferId}`);
    const text = await res.text();
    try {
      last = JSON.parse(text) as Record<string, unknown>;
    } catch {
      last = { raw: text };
    }
    const status = String(last.status || last.state || "").toLowerCase();
    const mintTx =
      (typeof last.transactionHash === "string" && last.transactionHash) ||
      (typeof last.txHash === "string" && last.txHash) ||
      (typeof last.destinationTxHash === "string" && last.destinationTxHash) ||
      undefined;
    if (status === "confirmed" || status === "finalized") {
      return { status, mintTx, raw: last };
    }
    if (status === "failed" || status === "expired") {
      return { status, mintTx, raw: last };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const mintTx =
    (typeof last.transactionHash === "string" && last.transactionHash) ||
    (typeof last.txHash === "string" && last.txHash) ||
    undefined;
  return { status: String(last.status || "pending"), mintTx, raw: last };
}

function heuristicMaxFeeRaw(
  domain: number,
  amountUsdc: number,
  destDomain: number,
  isFirst: boolean,
): bigint {
  const gas = GATEWAY_GAS_USDC[domain] ?? 0.05;
  const xfer = domain === destDomain ? 0 : amountUsdc * 0.00005;
  const destGas = GATEWAY_GAS_USDC[destDomain] ?? 0.05;
  const fwd = isFirst && domain !== destDomain ? 0.05 + destGas : 0;
  const total = gas + xfer + fwd + 0.15;
  return parseUnits(total.toFixed(6), 6);
}

async function estimateMaxFees(
  intents: GatewayBurnIntentJson[],
  destDomain: number,
): Promise<bigint[]> {
  const fallback = intents.map((it, i) =>
    heuristicMaxFeeRaw(
      it.spec.sourceDomain,
      Number(formatUnits(BigInt(it.spec.value), 6)),
      destDomain,
      i === 0,
    ),
  );
  try {
    const res = await fetch(
      `${config.gatewayApiBase}/estimate?enableForwarder=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stringifyJson(intents.map((b) => ({ spec: b.spec }))),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn("[gateway] estimate", res.status, text.slice(0, 180));
      return fallback;
    }
    const json = JSON.parse(text) as {
      fees?: { total?: string; perIntent?: Array<{ baseFee?: string; transferFee?: string }>; forwardingFee?: string };
      forwardingFee?: string;
    };
    const per = json.fees?.perIntent;
    if (Array.isArray(per) && per.length === intents.length) {
      const fwd = Number(json.fees?.forwardingFee || json.forwardingFee || 0);
      return per.map((p, i) => {
        const base = Number(p.baseFee || 0);
        const xfer = Number(p.transferFee || 0);
        const extra = i === 0 ? fwd : 0;
        const n = base + xfer + extra + 0.05;
        const raw = parseUnits(Math.max(n, 0.02).toFixed(6), 6);
        return raw > fallback[i]! ? raw : fallback[i]!;
      });
    }
    const total = Number(json.fees?.total || 0);
    if (total > 0) {
      const bump = parseUnits((total + 0.1).toFixed(6), 6);
      return fallback.map((f, i) => (i === 0 && bump > f ? bump : f));
    }
  } catch (e) {
    console.warn(
      "[gateway] estimate failed",
      e instanceof Error ? e.message : e,
    );
  }
  return fallback;
}

export async function submitGatewayBurnTransfer(input: {
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  /** Who owns the Gateway balance (user SCA address). */
  sourceDepositor: Address;
  /** EOA that signs the burn intent (must be depositor or authorized delegate). */
  signerAccount: GatewaySigner;
  sourceDomain?: number;
  /** Split burns across domains (Circle unified spend). */
  sources?: Array<{ domain: number; amountUsdc: number | string; raw?: bigint }>;
  maxFeeUsdc?: number;
  /** When true, request Circle Forwarding Service for destination mint. */
  enableForwarder?: boolean;
  /** @deprecated Use dest mint / forwarder poll. Kept for call-site compat. */
  mintOnArcWithOps?: boolean;
}): Promise<GatewayTransferResult> {
  const signer = input.signerAccount;
  const destDomain = input.destinationDomain;

  let destRecipient = input.destinationAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(destRecipient)) {
    throw new Error("Destination must be a 0x EVM address");
  }

  const destCaller = "0x0000000000000000000000000000000000000000" as Address;
  const destToken = DEST_USDC_BY_DOMAIN[destDomain] ?? USDC;
  const maxBlockHeight = maxUint256;

  let slices: Array<{ domain: number; value: bigint }>;
  if (input.sources && input.sources.length > 0) {
    slices = input.sources.map((s) => ({
      domain: s.domain,
      value:
        s.raw ??
        parseUnits(String(s.amountUsdc), 6),
    }));
  } else {
    const sourceDomain =
      input.sourceDomain ??
      (await pickSourceDomainWithBalance(
        input.sourceDepositor,
        input.amountUsdc,
        26,
      ));
    slices = [
      { domain: sourceDomain, value: parseUnits(String(input.amountUsdc), 6) },
    ];
  }
  if (slices.length > 16) {
    throw new Error("Gateway allows at most 16 burn intents per transfer");
  }

  const totalValue = slices.reduce((s, x) => s + x.value, 0n);

  const unsigned: GatewayBurnIntentJson[] = slices.map((s) => {
    const placeholderFee = heuristicMaxFeeRaw(
      s.domain,
      Number(formatUnits(s.value, 6)),
      destDomain,
      false,
    );
    const spec = {
      version: 1,
      sourceDomain: s.domain,
      destinationDomain: destDomain,
      sourceContract: toBytes32(GATEWAY_WALLET),
      destinationContract: encodeGatewayBytes32(destDomain, GATEWAY_MINTER),
      sourceToken: encodeGatewayBytes32(s.domain, usdcOnDomain(s.domain)),
      destinationToken: encodeGatewayBytes32(destDomain, destToken as Address),
      sourceDepositor: toBytes32(input.sourceDepositor),
      destinationRecipient: encodeGatewayBytes32(destDomain, destRecipient),
      sourceSigner: toBytes32(signer.address),
      destinationCaller: encodeGatewayBytes32(destDomain, destCaller),
      value: s.value.toString(),
      salt: (`0x${randomBytes(32).toString("hex")}`) as Hex,
      hookData: "0x" as Hex,
    };
    return {
      maxBlockHeight: maxBlockHeight.toString(),
      maxFee: placeholderFee.toString(),
      spec,
    };
  });

  const fees = input.maxFeeUsdc != null
    ? unsigned.map(() => parseUnits(String(input.maxFeeUsdc), 6))
    : await estimateMaxFees(unsigned, destDomain);

  const signedBody: Array<{ burnIntent: GatewayBurnIntentJson; signature: Hex }> =
    [];
  for (let i = 0; i < unsigned.length; i++) {
    const spec = unsigned[i]!.spec;
    const maxFee = fees[i]!;
    const value = BigInt(spec.value);
    const burnIntentMessage = {
      maxBlockHeight,
      maxFee,
      spec: {
        ...spec,
        value,
      },
    };
    const signature = await signer.signTypedData({
      domain: GATEWAY_TYPED_DOMAIN,
      types: {
        TransferSpec: GATEWAY_EIP712_TYPES.TransferSpec,
        BurnIntent: GATEWAY_EIP712_TYPES.BurnIntent,
      },
      primaryType: "BurnIntent",
      message: burnIntentMessage,
    });
    const burnIntentJson: GatewayBurnIntentJson = {
      maxBlockHeight: maxBlockHeight.toString(),
      maxFee: maxFee.toString(),
      spec,
    };
    signedBody.push({ burnIntent: burnIntentJson, signature });
  }

  const burnIntentJson = signedBody[0]!.burnIntent;
  const transferBody = signedBody;
  const sourceDomain = slices[0]!.domain;
  const value = totalValue;
  const maxFee = fees[0]!;

  const qs = input.enableForwarder ? "?enableForwarder=true" : "";
  const apiRes = await fetch(`${config.gatewayApiBase}/transfer${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stringifyJson(transferBody),
  });
  const apiText = await apiRes.text();
  let apiJson: {
    attestation?: string;
    signature?: string;
    message?: string;
    transferId?: string;
    id?: string;
    status?: string;
    transactionHash?: string;
  } = {};
  try {
    apiJson = JSON.parse(apiText);
  } catch {
    throw new Error(`Gateway transfer failed: ${apiText}`);
  }
  if (!apiRes.ok) {
    throw new Error(
      `Gateway transfer ${apiRes.status}: ${apiJson.message || apiText}`,
    );
  }

  const attestationPayload = apiJson.attestation as Hex | undefined;
  const attSig = apiJson.signature as Hex | undefined;
  const transferId = apiJson.transferId || apiJson.id;

  const base = {
    amountUsdc: input.amountUsdc,
    amountHuman: formatUnits(value, 6),
    amountRaw: value.toString(),
    maxFeeRaw: maxFee.toString(),
    sourceDomain,
    sources: slices.map((s) => ({
      domain: s.domain,
      amountUsdc: formatUnits(s.value, 6),
      name: GATEWAY_DOMAIN_NAME[s.domain] || `domain ${s.domain}`,
    })),
    burnIntents: signedBody.map((b) => b.burnIntent),
    destinationDomain: destDomain,
    destinationAddress: destRecipient,
    sourceDepositor: input.sourceDepositor,
    sourceSigner: signer.address,
    transferId,
    burnIntent: burnIntentJson,
    assetOut: "USDC" as const,
  };

  let mintTx: string | undefined;

  // Self-mint on dest EVM when attestation is in the POST body.
  if (
    attestationPayload &&
    attSig &&
    isEvmGatewayDomain(destDomain) &&
    input.mintOnArcWithOps !== false
  ) {
    try {
      mintTx = await gatewayMintOnEvmDomain({
        domain: destDomain,
        attestation: attestationPayload,
        signature: attSig,
      });
    } catch (e) {
      console.warn(
        "[gateway] dest mint failed, will poll forwarder if available",
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (mintTx) {
    return {
      ...base,
      status: "complete",
      mintTx,
      gatewayResponse: {
        ...apiJson,
        attestation: attestationPayload,
        signature: attSig,
      },
      note: `Minted on domain ${destDomain} via Gateway Minter`,
    };
  }

  // Circle already accepted the burn. Poll the forwarder; never treat as a
  // retryable client error.
  if (transferId && input.enableForwarder) {
    const polled = await pollGatewayTransfer(transferId);
    if (polled.mintTx) {
      return {
        ...base,
        status: "complete",
        mintTx: polled.mintTx,
        gatewayResponse: { ...apiJson, poll: polled.raw },
        note: `Forwarder minted on domain ${destDomain}`,
      };
    }
    if (polled.status === "failed" || polled.status === "expired") {
      return {
        ...base,
        status: "failed",
        doNotRetry: true,
        gatewayResponse: { ...apiJson, poll: polled.raw },
        note: `Gateway burn landed but dest mint ${polled.status}. Do not retry — transfer ${transferId}`,
      };
    }
    return {
      ...base,
      status: "in_transit",
      doNotRetry: true,
      gatewayResponse: { ...apiJson, poll: polled.raw },
      note: `Burn accepted (transfer ${transferId}). Destination mint is in transit — do not retry.`,
    };
  }

  if (transferId) {
    return {
      ...base,
      status: "in_transit",
      doNotRetry: true,
      gatewayResponse: apiJson,
      note: `Burn accepted (transfer ${transferId}). Destination mint pending — do not retry.`,
    };
  }

  return {
    ...base,
    status: "attestation_pending",
    doNotRetry: true,
    gatewayResponse: apiJson,
    note: "Attestation returned without payload — do not retry this pay",
  };
}

/**
 * Ops-only: burn from the deployer EOA's own Gateway balance.
 * User pays must use {@link gatewayPayFromUserDepositor}.
 */
export async function gatewayWithdrawUsdc(input: {
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDomain?: number;
  maxFeeUsdc?: number;
}) {
  const account = getDeployerAccount();
  return submitGatewayBurnTransfer({
    amountUsdc: input.amountUsdc,
    destinationDomain: input.destinationDomain,
    destinationAddress: input.destinationAddress,
    sourceDepositor: account.address,
    signerAccount: account,
    sourceDomain: input.sourceDomain,
    maxFeeUsdc: input.maxFeeUsdc,
    mintOnArcWithOps: true,
  });
}

/** Same-chain withdrawal from a dedicated Circle-held agent EOA to its owner. */
export async function gatewayWithdrawFromAgent(input: {
  walletId: string;
  address: Address;
  amountUsdc: number;
  destinationAddress: Address;
}) {
  const { circleGatewayBurnSigner } = await import("./agentWallet.js");
  return submitGatewayBurnTransfer({
    amountUsdc: input.amountUsdc,
    destinationDomain: 26,
    destinationAddress: input.destinationAddress,
    sourceDepositor: input.address,
    signerAccount: circleGatewayBurnSigner({
      walletId: input.walletId,
      address: input.address,
    }),
    sourceDomain: 26,
    enableForwarder: false,
    mintOnArcWithOps: true,
  });
}

/**
 * End-user Gateway Pay: debit **user** unified balance.
 *
 * - `sourceDepositor` = user SCA (holds Gateway deposits)
 * - `sourceSigner` = platform EOA (PRIVATE_KEY) after user has PIN-approved
 *   `addDelegate(USDC, platform)` on GatewayWallet
 *
 * Gateway rejects SCA EIP-712 signatures, so pure UCW-signed burn intents
 * cannot work for SCA depositors without a delegate.
 */
export async function gatewayPayFromUserDepositor(input: {
  depositor: Address;
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDomain?: number;
  maxFeeUsdc?: number;
  enableForwarder?: boolean;
  /** Precomputed split from {@link planGatewayPay}. */
  slices?: GatewaySourceSlice[];
}) {
  const delegate = getDeployerAccount();
  const plan =
    input.slices && input.slices.length > 0
      ? {
          slices: input.slices,
          missingDomains: [] as number[],
        }
      : await planGatewayPay({
          depositor: input.depositor,
          amountUsdc: input.amountUsdc,
          destinationDomain: input.destinationDomain,
          sourceDomain: input.sourceDomain,
          delegate: delegate.address,
        });

  if (plan.missingDomains.length > 0) {
    const names = plan.missingDomains
      .map((d) => GATEWAY_DOMAIN_NAME[d] || String(d))
      .join(", ");
    const err = new Error(
      `Gateway pay delegate not authorized on ${names} — user must approve addDelegate first`,
    ) as Error & {
      code: string;
      delegate: Address;
      depositor: Address;
      missingDomains: number[];
    };
    err.code = "DELEGATE_REQUIRED";
    err.delegate = delegate.address;
    err.depositor = input.depositor;
    err.missingDomains = plan.missingDomains;
    throw err;
  }

  const enableForwarder = input.enableForwarder ?? true;

  return submitGatewayBurnTransfer({
    amountUsdc: input.amountUsdc,
    destinationDomain: input.destinationDomain,
    destinationAddress: input.destinationAddress,
    sourceDepositor: input.depositor,
    signerAccount: delegate,
    sources: plan.slices.map((s) => ({
      domain: s.domain,
      amountUsdc: s.amountUsdc,
      raw: s.raw,
    })),
    maxFeeUsdc: input.maxFeeUsdc,
    enableForwarder,
    mintOnArcWithOps: true,
  });
}

export { DEPOSIT_CHAINS, GATEWAY_WALLET, GATEWAY_MINTER, USDC };
