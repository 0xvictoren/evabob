import {
  initiateUserControlledWalletsClient,
  Blockchain,
} from "@circle-fin/user-controlled-wallets";
import { randomUUID } from "node:crypto";
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseUnits,
  type Address,
} from "viem";
import { config } from "../config.js";
import {
  encodeWalletBatch,
  feeTransferCall,
  quotePlatformFee,
  type WalletCall,
} from "./platformFee.js";

const CCTP_DEPOSIT_FOR_BURN_ABI = [
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
    outputs: [],
  },
] as const;

const GATEWAY_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
import { rememberUcwSession } from "./ucw-sessions.js";

/** Circle GET challenge returns `{ challenge: {...} }`; some SDK paths flatten it. */
export function unwrapCircleChallenge(data: unknown): {
  status?: string;
  correlationIds?: string[];
  errorMessage?: string;
  id?: string;
} | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const inner = d.challenge;
  if (inner && typeof inner === "object") {
    return inner as {
      status?: string;
      correlationIds?: string[];
      errorMessage?: string;
      id?: string;
    };
  }
  if (typeof d.status === "string" || Array.isArray(d.correlationIds)) {
    return d as {
      status?: string;
      correlationIds?: string[];
      errorMessage?: string;
      id?: string;
    };
  }
  return null;
}

/** Circle GET transaction returns `{ transaction: {...} }`; some SDK paths flatten it. */
export function unwrapCircleTransaction(data: unknown): {
  txHash?: string;
  state?: string;
  errorReason?: string;
  contractAddress?: string;
  blockchain?: string;
} | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const inner = d.transaction;
  if (inner && typeof inner === "object") {
    return inner as {
      txHash?: string;
      state?: string;
      errorReason?: string;
      contractAddress?: string;
      blockchain?: string;
    };
  }
  if (typeof d.txHash === "string" || typeof d.state === "string") {
    return d as {
      txHash?: string;
      state?: string;
      errorReason?: string;
      contractAddress?: string;
      blockchain?: string;
    };
  }
  return null;
}

export type CircleClient = ReturnType<
  typeof initiateUserControlledWalletsClient
>;

export type UcwWallet = {
  id: string;
  address?: string;
  blockchain?: string;
  state?: string;
  accountType?: string;
};

let _client: CircleClient | null = null;

const FEE_MED = {
  type: "level" as const,
  config: { feeLevel: "MEDIUM" as const },
};

/** Product-supported EVM testnets: Arc, Ethereum Sepolia, Base Sepolia. */
export const UCW_EVM_TESTNETS = [
  Blockchain.ArcTestnet,
  Blockchain.EthSepolia,
  Blockchain.BaseSepolia,
] as const;

export function getUcwClient(): CircleClient {
  if (!config.circle.apiKey) {
    throw new Error("CIRCLE_API_KEY is required for user-controlled wallets");
  }
  if (!_client) {
    _client = initiateUserControlledWalletsClient({
      apiKey: config.circle.apiKey,
    });
  }
  return _client;
}

export function circleAppId() {
  return config.circle.walletsAppId;
}

export function circleUserId(appUserId: string): string {
  const id = appUserId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (id.length >= 5) return id;
  return `user_${id}`.padEnd(5, "0");
}

function extractCode(e: unknown): number | string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const any = e as {
    code?: number | string;
    response?: { data?: { code?: number | string; message?: string } };
    data?: { code?: number | string; message?: string };
    message?: string;
  };
  return (
    any.code ??
    any.response?.data?.code ??
    any.data?.code ??
    // Some SDK errors nest under error
    (any as { error?: { code?: number | string } }).error?.code
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const any = e as {
      message?: string;
      response?: { data?: { message?: string } };
      data?: { message?: string };
    };
    return (
      any.message ||
      any.response?.data?.message ||
      any.data?.message ||
      JSON.stringify(e)
    );
  }
  return String(e);
}

/** Circle re-create / already-initialized errors (idempotent success). */
export function isCircleIdempotentError(e: unknown): boolean {
  const code = extractCode(e);
  // 155106 = user already exists; also accept string codes and related ids
  const idempotentCodes = new Set([
    155106,
    "155106",
    155101,
    "155101",
    155112,
    "155112",
  ]);
  if (code != null && idempotentCodes.has(code)) return true;

  const msg = errorMessage(e).toLowerCase();
  return (
    msg.includes("already created") ||
    msg.includes("already exists") ||
    msg.includes("already been created") ||
    msg.includes("user already") ||
    msg.includes("pin already") ||
    msg.includes("already set") ||
    msg.includes("already initialized") ||
    msg.includes("existing user")
  );
}

export async function ensureUser(appUserId: string) {
  const client = getUcwClient();
  const userId = circleUserId(appUserId);
  try {
    await client.createUser({ userId });
    return { userId, created: true };
  } catch (e: unknown) {
    if (isCircleIdempotentError(e)) {
      return { userId, created: false, alreadyExists: true };
    }
    // Surface a clear message for the API layer
    const msg = errorMessage(e);
    const err = new Error(msg);
    (err as Error & { code?: unknown }).code = extractCode(e);
    throw err;
  }
}

export async function createSession(appUserId: string) {
  const client = getUcwClient();
  const userId = circleUserId(appUserId);
  await ensureUser(appUserId);
  const res = await client.createUserToken({ userId });
  if (!res.data?.userToken) throw new Error("Circle did not issue a session");
  await rememberUcwSession(appUserId, res.data.userToken);
  return {
    userId,
    userToken: res.data?.userToken as string,
    encryptionKey: res.data?.encryptionKey as string,
  };
}

/**
 * PIN + multi-chain wallets:
 * - EVM SCA on Arc + Ethereum Sepolia + Base Sepolia
 * - After init, Solana Devnet EOA via createWallet (SCA not supported on Sol)
 */
export async function createPinWalletChallenge(userToken: string) {
  const client = getUcwClient();
  try {
    const res = await client.createUserPinWithWallets({
      userToken,
      blockchains: [...UCW_EVM_TESTNETS],
      accountType: "SCA",
    });
    return {
      challengeId: res.data?.challengeId as string,
      alreadyInitialized: false,
    };
  } catch (e: unknown) {
    if (isCircleIdempotentError(e)) {
      return { challengeId: null as string | null, alreadyInitialized: true };
    }
    // If wallets already exist, treat as initialized rather than failing hard
    try {
      const wallets = await listUserWallets(userToken);
      if (wallets.length > 0) {
        return { challengeId: null as string | null, alreadyInitialized: true };
      }
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Add any missing product wallets (EVM SCA). */
export async function createAdditionalWalletsChallenge(userToken: string) {
  const client = getUcwClient();
  const existing = await listUserWallets(userToken);
  const have = new Set(
    existing.map((w) => (w.blockchain || "").toUpperCase()),
  );

  const challenges: Array<{ chain: string; challengeId: string }> = [];

  const evmWanted = [
    ["ARC-TESTNET", Blockchain.ArcTestnet],
    ["ETH-SEPOLIA", Blockchain.EthSepolia],
    ["BASE-SEPOLIA", Blockchain.BaseSepolia],
  ] as const;

  const missingEvm = evmWanted
    .filter(([name]) => !have.has(name))
    .map(([, b]) => b);

  if (missingEvm.length > 0) {
    try {
      const res = await client.createWallet({
        userToken,
        blockchains: missingEvm as unknown as Blockchain[],
        accountType: "SCA",
      });
      const cid = (res.data as { challengeId?: string } | undefined)
        ?.challengeId;
      if (cid) challenges.push({ chain: "EVM-PRODUCT", challengeId: cid });
    } catch (e) {
      console.warn("create product EVM wallets", e);
    }
  }

  return { challenges };
}

export async function listUserWallets(userToken: string): Promise<UcwWallet[]> {
  const client = getUcwClient();
  const res = await client.listWallets({ userToken });
  return (res.data?.wallets ?? []) as UcwWallet[];
}

export function pickPrimaryArcWallet(wallets: UcwWallet[]): UcwWallet | undefined {
  return (
    wallets.find(
      (w) =>
        (w.blockchain || "").toUpperCase().includes("ARC") && w.address,
    ) ||
    wallets.find((w) => w.address) ||
    wallets[0]
  );
}

/** Map wallets for deposit UI (multi-chain embedded addresses). */
export function mapWalletsForDeposit(wallets: UcwWallet[]) {
  const byChain: Record<string, { walletId: string; address: string }> = {};
  for (const w of wallets) {
    if (!w.address || !w.id) continue;
    const key = (w.blockchain || "UNKNOWN").toUpperCase();
    byChain[key] = { walletId: w.id, address: w.address };
  }

  // EVM address reused across EVM Gateway chains when we only have Arc
  const evm =
    byChain["ARC-TESTNET"]?.address ||
    byChain["ETH-SEPOLIA"]?.address ||
    byChain["BASE-SEPOLIA"]?.address ||
    Object.values(byChain).find((v) => v.address.startsWith("0x"))?.address;

  return {
    byChain,
    evmAddress: evm || "",
    solanaAddress: "",
    wallets,
  };
}

export async function getWalletBalances(userToken: string, walletId: string) {
  const client = getUcwClient();
  const res = await client.getWalletTokenBalance({ userToken, walletId });
  return res.data?.tokenBalances ?? [];
}

function challengeOf(res: { data?: { challengeId?: string } | null }) {
  return res.data?.challengeId as string | undefined;
}

/**
 * Lightweight challenge so user proves PIN before revealing secrets (agent API key).
 * Uses message signing when available; otherwise a zero-value contract no-op is not used.
 */
export async function createVerifyPinChallenge(input: {
  userToken: string;
  walletId: string;
  purpose?: string;
}) {
  const client = getUcwClient();
  const message = input.purpose || "Evabob security verification";
  // Circle UCW message sign (returns challengeId for PIN WebView)
  const anyClient = client as unknown as {
    signMessage?: (args: Record<string, unknown>) => Promise<{
      data?: { challengeId?: string } | null;
    }>;
    createUserChallenge?: (args: Record<string, unknown>) => Promise<{
      data?: { challengeId?: string } | null;
    }>;
  };
  if (typeof anyClient.signMessage === "function") {
    const res = await anyClient.signMessage({
      userToken: input.userToken,
      walletId: input.walletId,
      message: `0x${Buffer.from(message, "utf8").toString("hex")}`,
      encodedByHex: true,
      fee: FEE_MED,
    });
    return { challengeId: challengeOf(res), appId: circleAppId() };
  }
  // Fallback: no separate sign API — client will use ensureReady as verification.
  return { challengeId: null as string | null, appId: circleAppId(), fallback: true };
}

/** USDC transfer challenge — user signs with PIN. */
export async function createTransferChallenge(input: {
  userToken: string;
  walletId: string;
  destinationAddress: string;
  amountUsdc: string; // human "1.5"
  tokenAddress?: string;
  blockchain?: Blockchain;
}) {
  const client = getUcwClient();
  const res = await client.createTransaction({
    userToken: input.userToken,
    walletId: input.walletId,
    destinationAddress: input.destinationAddress,
    amounts: [input.amountUsdc],
    fee: FEE_MED,
    tokenAddress: (input.tokenAddress || config.arc.usdc) as string,
    blockchain: input.blockchain || Blockchain.ArcTestnet,
  } as Parameters<CircleClient["createTransaction"]>[0]);
  return { challengeId: challengeOf(res), appId: circleAppId() };
}

/** Generic contract call challenge. */
export async function createContractChallenge(input: {
  userToken: string;
  walletId: string;
  contractAddress: string;
  abiFunctionSignature: string;
  abiParameters: unknown[];
  amount?: string; // native amount if payable
}) {
  const client = getUcwClient();
  const res = await client.createUserTransactionContractExecutionChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: input.contractAddress,
    abiFunctionSignature: input.abiFunctionSignature,
    abiParameters: input.abiParameters,
    fee: FEE_MED,
    ...(input.amount ? { amount: input.amount } : {}),
  });
  return { challengeId: challengeOf(res), appId: circleAppId() };
}

/**
 * Raw calldata contract execution (for Synthra router swaps, etc.).
 * Mutually exclusive with abiFunctionSignature in Circle UCW API.
 */
export async function createCalldataChallenge(input: {
  userToken: string;
  walletId: string;
  contractAddress: string;
  callData: `0x${string}`;
  amount?: string;
}) {
  const client = getUcwClient();
  const res = await client.createUserTransactionContractExecutionChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: input.contractAddress,
    callData: input.callData,
    fee: FEE_MED,
    ...(input.amount && input.amount !== "0" ? { amount: input.amount } : {}),
  });
  return { challengeId: challengeOf(res), appId: circleAppId() };
}

/**
 * Several calls, one PIN. Evabob wallets are Circle smart contract accounts:
 * the calls are wrapped in the wallet's own `executeBatch` and submitted as a
 * single contract-execution challenge targeting the wallet itself — the same
 * encoding Circle's App Kit adapter uses. The batch is atomic: a payment and
 * its platform fee either both land or neither does.
 */
export async function createWalletBatchChallenge(input: {
  userToken: string;
  walletId: string;
  /** The wallet's own address; looked up from Circle when omitted. */
  walletAddress?: string;
  calls: WalletCall[];
}) {
  if (input.calls.length === 1) {
    const [call] = input.calls;
    return createCalldataChallenge({
      userToken: input.userToken,
      walletId: input.walletId,
      contractAddress: call!.to,
      callData: call!.data,
    });
  }
  let address = input.walletAddress;
  if (!address) {
    const wallets = await listUserWallets(input.userToken);
    address = wallets.find((w) => w.id === input.walletId)?.address;
  }
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Could not find this wallet's address to confirm the payment");
  }
  return createCalldataChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: address,
    callData: encodeWalletBatch(input.calls),
  });
}

/**
 * Synthra ERC20-mode swap: approve router → execute swap calldata.
 * Plan comes from synthraSwap() (approvalMode: erc20).
 */
export async function createSynthraSwapChallenges(input: {
  userToken: string;
  walletId: string;
  approveTo: string;
  approveData: `0x${string}`;
  swapTo: string;
  swapData: `0x${string}`;
  swapValue?: string;
  /** Platform fee leg, batched with the swap so both land or neither does. */
  feeCall?: WalletCall | null;
}) {
  const approve = await createCalldataChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: input.approveTo,
    callData: input.approveData,
  });
  const nativeValue =
    input.swapValue && input.swapValue !== "0" ? input.swapValue : undefined;
  // A native-value swap cannot ride in executeBatch through Circle's
  // contract-execution amount field, so only ERC-20 swaps are batched.
  const swap =
    input.feeCall && !nativeValue
      ? await createWalletBatchChallenge({
          userToken: input.userToken,
          walletId: input.walletId,
          calls: [
            { to: input.swapTo as Address, data: input.swapData },
            input.feeCall,
          ],
        })
      : await createCalldataChallenge({
          userToken: input.userToken,
          walletId: input.walletId,
          contractAddress: input.swapTo,
          callData: input.swapData,
          amount: nativeValue,
        });
  return {
    appId: circleAppId(),
    challenges: [
      {
        step: "approve",
        challengeId: approve.challengeId,
        description: "Approve token for Synthra router",
      },
      {
        step: "swap",
        challengeId: swap.challengeId,
        description: "Execute swap on Arc",
      },
    ].filter((c) => c.challengeId),
    singlePinHint: true,
    /** True when the platform fee rides in the swap's batch. */
    feeBatched: Boolean(input.feeCall && !nativeValue),
  };
}

function resolveGatewayDomain(chain?: string, domain?: number): number {
  if (domain === 0 || domain === 6 || domain === 26) return domain;
  const key = (chain || "arc").toLowerCase().replace(/\s+/g, "_");
  if (key.includes("base")) return 6;
  if (key.includes("eth") || key.includes("sepolia")) return 0;
  return 26;
}

export function walletForGatewayDomain(
  wallets: UcwWallet[],
  domain: number,
): UcwWallet | undefined {
  const { GATEWAY_DOMAIN_UCW } = requireGatewayMeta();
  const want = GATEWAY_DOMAIN_UCW[domain];
  if (!want) return undefined;
  const exact = wallets.find(
    (w) => (w.blockchain || "").toUpperCase() === want,
  );
  if (exact) return exact;
  const token = want.split("-")[0] || want;
  return wallets.find((w) =>
    (w.blockchain || "").toUpperCase().includes(token),
  );
}

function requireGatewayMeta() {
  // Lazy to keep this module loadable in tests without RPC.
  return {
    GATEWAY_DOMAIN_UCW: {
      26: "ARC-TESTNET",
      0: "ETH-SEPOLIA",
      6: "BASE-SEPOLIA",
    } as Record<number, string>,
    GATEWAY_DOMAIN_NAME: {
      26: "Arc Testnet",
      0: "Ethereum Sepolia",
      6: "Base Sepolia",
    } as Record<number, string>,
    DEST_USDC: {
      26: config.arc.usdc,
      0: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      6: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    } as Record<number, string>,
  };
}

/** Sequential challenges: approve USDC → Gateway deposit on the source chain. */
export async function createGatewayDepositChallenges(input: {
  userToken: string;
  walletId: string;
  amountUsdc: number;
  chain?: string;
  domain?: number;
  wallets?: UcwWallet[];
}) {
  const domain = resolveGatewayDomain(input.chain, input.domain);
  const meta = requireGatewayMeta();
  const usdc = meta.DEST_USDC[domain] || config.arc.usdc;
  const chainWallet = input.wallets
    ? walletForGatewayDomain(input.wallets, domain)
    : undefined;
  const walletId = chainWallet?.id || input.walletId;
  const amount = parseUnits(String(input.amountUsdc), 6).toString();
  const maxApprove = maxUint256.toString();
  const chainName = meta.GATEWAY_DOMAIN_NAME[domain] || "Arc Testnet";

  // Platform fee on: approve, deposit and fee in ONE wallet batch. One PIN,
  // and a top-up can no longer stop between approve and deposit.
  const feeQuote = quotePlatformFee(input.amountUsdc, 6);
  if (feeQuote.feeUnits > 0n) {
    const usdcAddress = usdc as Address;
    const gatewayWallet = config.arc.gatewayWallet as Address;
    const batch = await createWalletBatchChallenge({
      userToken: input.userToken,
      walletId,
      walletAddress: chainWallet?.address,
      calls: [
        {
          to: usdcAddress,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [gatewayWallet, feeQuote.amountUnits],
          }),
        },
        {
          to: gatewayWallet,
          data: encodeFunctionData({
            abi: GATEWAY_DEPOSIT_ABI,
            functionName: "deposit",
            args: [usdcAddress, feeQuote.amountUnits],
          }),
        },
        feeTransferCall(usdcAddress, feeQuote)!,
      ],
    });
    return {
      appId: circleAppId(),
      domain,
      chain: chainName,
      walletId,
      platformFee: feeQuote.fee,
      challenges: [
        {
          step: "deposit",
          challengeId: batch.challengeId,
          description: `Add USDC to your GA on ${chainName}`,
        },
      ].filter((c) => c.challengeId),
      singlePinHint: true,
    };
  }

  const approve = await createContractChallenge({
    userToken: input.userToken,
    walletId,
    contractAddress: usdc,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [config.arc.gatewayWallet, maxApprove],
  });
  const deposit = await createContractChallenge({
    userToken: input.userToken,
    walletId,
    contractAddress: config.arc.gatewayWallet,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [usdc, amount],
  });
  return {
    appId: circleAppId(),
    domain,
    chain: chainName,
    walletId,
    challenges: [
      {
        step: "approve",
        challengeId: approve.challengeId,
        description: `Approve Gateway to spend USDC on ${chainName}`,
      },
      {
        step: "deposit",
        challengeId: deposit.challengeId,
        description: `Deposit USDC into Gateway on ${chainName}`,
      },
    ].filter((c) => c.challengeId),
    singlePinHint: true,
  };
}

/**
 * Authorize platform EOA as Gateway burn-intent delegate on Arc (legacy).
 * Prefer {@link createAddGatewayDelegateChallenges} for per-chain setup.
 */
export async function createAddGatewayDelegateChallenge(input: {
  userToken: string;
  walletId: string;
  /** EOA that will sign BurnIntents (defaults to server PRIVATE_KEY address). */
  delegateAddress?: string;
}) {
  return createAddGatewayDelegateChallenges({
    ...input,
    domains: [26],
  });
}

/**
 * One-time `addDelegate(USDC, platform EOA)` on each domain that will be a burn source.
 * Circle requires this on every chain where the SCA holds Gateway deposits.
 */
export async function createAddGatewayDelegateChallenges(input: {
  userToken: string;
  walletId: string;
  wallets?: UcwWallet[];
  domains: number[];
  delegateAddress?: string;
}) {
  const { getGatewayPayDelegateAddress } = await import("./gateway-e2e.js");
  const delegate =
    input.delegateAddress || getGatewayPayDelegateAddress();
  const meta = requireGatewayMeta();
  const unique = [...new Set(input.domains)].filter((d) =>
    [0, 6, 26].includes(d),
  );
  const challenges: Array<{
    step: string;
    challengeId: string | undefined;
    domain: number;
    chain: string;
    description: string;
  }> = [];
  const missingWallets: number[] = [];

  for (const domain of unique) {
    const w = input.wallets
      ? walletForGatewayDomain(input.wallets, domain)
      : undefined;
    const walletId = w?.id || (domain === 26 ? input.walletId : undefined);
    if (!walletId) {
      missingWallets.push(domain);
      continue;
    }
    const usdc = meta.DEST_USDC[domain] || config.arc.usdc;
    const chainName = meta.GATEWAY_DOMAIN_NAME[domain] || `domain ${domain}`;
    const challenge = await createContractChallenge({
      userToken: input.userToken,
      walletId,
      contractAddress: config.arc.gatewayWallet,
      abiFunctionSignature: "addDelegate(address,address)",
      abiParameters: [usdc, delegate],
    });
    challenges.push({
      step: "addDelegate",
      challengeId: challenge.challengeId,
      domain,
      chain: chainName,
      description: `Authorize Evabob to spend Gateway USDC on ${chainName} (one-time)`,
    });
  }

  return {
    appId: circleAppId(),
    needsDelegate: true as const,
    delegateAddress: delegate,
    missingDomains: unique,
    missingWallets,
    challenges: challenges.filter((c) => c.challengeId),
    note:
      "Gateway only accepts EOA signatures on burn intents. Your SCA holds the USDC; this PIN authorizes Evabob's signer as a delegate on each chain you deposited to.",
  };
}

/** Escrow protected transfer: approve + createTransfer. */
export async function createEscrowSendChallenges(input: {
  userToken: string;
  walletId: string;
  amountUsdc: number;
  recipientKey: `0x${string}`;
  memo?: string;
}) {
  if (!config.arc.paymentEscrow) {
    throw new Error("PAYMENT_ESCROW not configured");
  }
  const amount = parseUnits(String(input.amountUsdc), 6).toString();
  // Max approve once so follow-up sends often only need the transfer challenge (1 PIN).
  const maxApprove = maxUint256.toString();
  const escrow = config.arc.paymentEscrow;
  const zeroHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const approve = await createContractChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: config.arc.usdc,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [escrow, maxApprove],
  });
  const create = await createContractChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: escrow,
    abiFunctionSignature:
      "createTransfer(bytes32,uint128,uint64,bytes32,string)",
    abiParameters: [
      input.recipientKey,
      amount,
      "0",
      zeroHash,
      input.memo || "",
    ],
  });
  // Prefer single transfer challenge when approve already sufficient is hard to detect;
  // still return both, but mobile runs them in ONE WebView session (one auth setup).
  return {
    appId: circleAppId(),
    challenges: [
      {
        step: "approve",
        challengeId: approve.challengeId,
        description: "Approve escrow USDC",
      },
      {
        step: "createTransfer",
        challengeId: create.challengeId,
        description: "Create protected transfer",
      },
    ].filter((c) => c.challengeId),
    singlePinHint: true,
  };
}

const CCTP_TOKEN_MESSENGER =
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;

/** In-memory bridge intents: approve first, burn only after COMPLETE. */
const pendingCctpBurns = new Map<
  string,
  {
    userToken: string;
    walletId: string;
    amountUsdc: number;
    destinationDomain: number;
    mintRecipient: Address;
    approveChallengeId?: string;
    createdAt: number;
  }
>();

export type CctpBurnStep = "approve" | "burn" | "all";

/** Approve-only challenge (step 1 of sequential CCTP burn). */
export async function createCctpApproveChallenge(input: {
  userToken: string;
  walletId: string;
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: Address;
  /** Client correlation id (activityId) to continue with burn. */
  intentId: string;
}) {
  const amount = parseUnits(String(input.amountUsdc), 6).toString();
  const approve = await createContractChallenge({
    userToken: input.userToken,
    walletId: input.walletId,
    contractAddress: config.arc.usdc,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [CCTP_TOKEN_MESSENGER, amount],
  });
  pendingCctpBurns.set(input.intentId, {
    userToken: input.userToken,
    walletId: input.walletId,
    amountUsdc: input.amountUsdc,
    destinationDomain: input.destinationDomain,
    mintRecipient: input.mintRecipient,
    approveChallengeId: approve.challengeId as string | undefined,
    createdAt: Date.now(),
  });
  // Soft TTL cleanup
  for (const [k, v] of pendingCctpBurns) {
    if (Date.now() - v.createdAt > 30 * 60_000) pendingCctpBurns.delete(k);
  }
  return {
    appId: circleAppId(),
    step: "approve" as const,
    intentId: input.intentId,
    challenges: [
      { step: "approve", challengeId: approve.challengeId },
    ].filter((c) => c.challengeId),
    next: "POST /v1/circle/cctp/burn/continue after approve is COMPLETE",
  };
}

/** depositForBurn only — call after approve challenge is COMPLETE. */
export async function createCctpBurnOnlyChallenge(input: {
  intentId?: string;
  userToken: string;
  walletId: string;
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: Address;
}) {
  const pending = input.intentId
    ? pendingCctpBurns.get(input.intentId)
    : undefined;
  if (input.intentId && !pending) {
    throw new Error(
      "Bridge intent expired or unknown — restart bridge (approve first)",
    );
  }
  const amountUsdc = pending?.amountUsdc ?? input.amountUsdc;
  const destinationDomain =
    pending?.destinationDomain ?? input.destinationDomain;
  const mintRecipient = pending?.mintRecipient ?? input.mintRecipient;
  const userToken = input.userToken || pending?.userToken;
  const walletId = input.walletId || pending?.walletId;
  if (!userToken || !walletId) {
    throw new Error("userToken and walletId required for burn step");
  }
  if (!(amountUsdc > 0)) {
    throw new Error("amountUsdc must be positive for burn step");
  }

  const amount = parseUnits(String(amountUsdc), 6).toString();
  const mintRecipientBytes32 = `0x${mintRecipient
    .slice(2)
    .toLowerCase()
    .padStart(64, "0")}`;
  const zeroBytes32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  // Platform fee on: the burn and the fee in ONE wallet batch, so the fee is
  // only ever taken together with a burn that actually happened. The approve
  // step before this covers the burn amount only; the fee is a plain transfer.
  const feeQuote = quotePlatformFee(amountUsdc, 6);
  const burnCall = {
    to: CCTP_TOKEN_MESSENGER as Address,
    data: encodeFunctionData({
      abi: CCTP_DEPOSIT_FOR_BURN_ABI,
      functionName: "depositForBurn",
      args: [
        feeQuote.amountUnits,
        destinationDomain,
        mintRecipientBytes32 as `0x${string}`,
        config.arc.usdc as Address,
        zeroBytes32 as `0x${string}`,
        0n,
        1000,
      ],
    }),
  };
  const feeCall = feeTransferCall(config.arc.usdc as Address, feeQuote);
  const burn = feeCall
    ? await createWalletBatchChallenge({
        userToken,
        walletId,
        calls: [burnCall, feeCall],
      })
    : await createContractChallenge({
        userToken,
        walletId,
        contractAddress: CCTP_TOKEN_MESSENGER,
        abiFunctionSignature:
          "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
        abiParameters: [
          amount,
          destinationDomain,
          mintRecipientBytes32,
          config.arc.usdc,
          zeroBytes32,
          "0",
          1000,
        ],
      });
  if (input.intentId) pendingCctpBurns.delete(input.intentId);
  return {
    appId: circleAppId(),
    step: "depositForBurn" as const,
    burnChallengeId: burn.challengeId as string | undefined,
    challenges: [
      { step: "depositForBurn", challengeId: burn.challengeId },
    ].filter((c) => c.challengeId),
    destinationDomain,
    mintRecipient,
    amountUsdc,
  };
}

/**
 * CCTP burn challenges.
 * Default `step: "sequential"` = approve only first (burn via /burn/continue).
 * Pass `step: "all"` for legacy both-at-once (not recommended).
 */
export async function createCctpBurnChallenges(input: {
  userToken: string;
  walletId: string;
  amountUsdc: number;
  destinationDomain: number;
  mintRecipient: Address;
  step?: CctpBurnStep | "sequential";
  intentId?: string;
}) {
  const step = input.step || "sequential";
  if (step === "all") {
    // Legacy: create both immediately (approve may race burn if used carelessly)
    const amount = parseUnits(String(input.amountUsdc), 6).toString();
    const mintRecipientBytes32 = `0x${input.mintRecipient
      .slice(2)
      .toLowerCase()
      .padStart(64, "0")}`;
    const zeroBytes32 =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    const approve = await createContractChallenge({
      userToken: input.userToken,
      walletId: input.walletId,
      contractAddress: config.arc.usdc,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [CCTP_TOKEN_MESSENGER, amount],
    });
    const burn = await createContractChallenge({
      userToken: input.userToken,
      walletId: input.walletId,
      contractAddress: CCTP_TOKEN_MESSENGER,
      abiFunctionSignature:
        "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
      abiParameters: [
        amount,
        input.destinationDomain,
        mintRecipientBytes32,
        config.arc.usdc,
        zeroBytes32,
        "0",
        1000,
      ],
    });
    return {
      appId: circleAppId(),
      mode: "all" as const,
      burnChallengeId: burn.challengeId as string | undefined,
      challenges: [
        { step: "approve", challengeId: approve.challengeId },
        { step: "depositForBurn", challengeId: burn.challengeId },
      ].filter((c) => c.challengeId),
    };
  }

  if (step === "burn") {
    return createCctpBurnOnlyChallenge({
      intentId: input.intentId,
      userToken: input.userToken,
      walletId: input.walletId,
      amountUsdc: input.amountUsdc,
      destinationDomain: input.destinationDomain,
      mintRecipient: input.mintRecipient,
    });
  }

  // sequential / approve — create approve only
  const intentId = input.intentId || randomUUID();
  return createCctpApproveChallenge({
    ...input,
    intentId,
  });
}

/**
 * After a UCW PIN challenge completes, resolve the on-chain tx hash.
 * Challenge.correlationIds hold Circle transaction id(s) for CONTRACT_EXECUTION.
 */
export async function waitForChallengeTxHash(input: {
  userToken: string;
  challengeId: string;
  /** Default 90s — burn may take a few blocks after PIN. */
  timeoutMs?: number;
  pollMs?: number;
}): Promise<
  | {
      ok: true;
      txHash: string;
      transactionId: string;
      state: string;
      challengeStatus: string;
    }
  | {
      ok: false;
      error: string;
      challengeStatus?: string;
      transactionId?: string;
      state?: string;
    }
> {
  const client = getUcwClient();
  const timeoutMs = input.timeoutMs ?? 90_000;
  const pollMs = input.pollMs ?? 2_500;
  const start = Date.now();

  let lastChallengeStatus = "PENDING";
  let lastTxState: string | undefined;
  let transactionId: string | undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      const chRes = await client.getUserChallenge({
        userToken: input.userToken,
        challengeId: input.challengeId,
      });
      const challenge = unwrapCircleChallenge(chRes.data);
      lastChallengeStatus = challenge?.status || lastChallengeStatus;

      if (lastChallengeStatus === "FAILED" || lastChallengeStatus === "EXPIRED") {
        return {
          ok: false,
          error:
            challenge?.errorMessage ||
            `Challenge ${lastChallengeStatus.toLowerCase()}`,
          challengeStatus: lastChallengeStatus,
        };
      }

      const corr = challenge?.correlationIds?.find(Boolean);
      if (corr) transactionId = corr;

      if (transactionId) {
        const txRes = await client.getTransaction({
          userToken: input.userToken,
          id: transactionId,
        });
        const tx = unwrapCircleTransaction(txRes.data);
        lastTxState = tx?.state || lastTxState;
        const hash = tx?.txHash;
        if (hash && /^0x[a-fA-F0-9]{64}$/.test(hash)) {
          return {
            ok: true,
            txHash: hash,
            transactionId,
            state: String(tx?.state || "COMPLETE"),
            challengeStatus: lastChallengeStatus,
          };
        }
        if (
          lastTxState === "FAILED" ||
          lastTxState === "DENIED" ||
          lastTxState === "CANCELLED"
        ) {
          return {
            ok: false,
            error: tx?.errorReason || `Transaction ${lastTxState}`,
            challengeStatus: lastChallengeStatus,
            transactionId,
            state: lastTxState,
          };
        }
      }
    } catch (e) {
      // Transient Circle API errors — keep polling until timeout.
      console.warn("waitForChallengeTxHash poll", errorMessage(e));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return {
    ok: false,
    error: `Timed out waiting for burn tx hash (challenge=${lastChallengeStatus}, tx=${lastTxState || "none"})`,
    challengeStatus: lastChallengeStatus,
    transactionId,
    state: lastTxState,
  };
}

/** Circle transaction states that mean the signed tx is already on its way. */
const TX_SETTLED_STATES = new Set([
  "SENT",
  "CONFIRMED",
  "COMPLETE",
  "COMPLETED",
]);
const TX_DEAD_STATES = new Set(["FAILED", "DENIED", "CANCELLED", "CANCELED"]);

/**
 * Decide whether a challenge is done, dead, or still moving — from the
 * challenge status *and* the state of the transaction it correlates to.
 *
 * Pure so the rule can be tested without a Circle client. The rule that
 * matters: a challenge whose transaction already has a hash is settled even
 * while its own status still reads PENDING.
 */
export function classifyChallenge(input: {
  challengeStatus?: string;
  txHash?: string;
  txState?: string;
}): { settled: boolean; dead: boolean } {
  const status = String(input.challengeStatus || "PENDING").toUpperCase();
  const txState = input.txState
    ? String(input.txState).toUpperCase()
    : undefined;

  if (status === "FAILED" || status === "EXPIRED") {
    return { settled: false, dead: true };
  }
  if (txState && TX_DEAD_STATES.has(txState)) {
    return { settled: false, dead: true };
  }

  const hasHash =
    typeof input.txHash === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(input.txHash);

  return {
    settled:
      status === "COMPLETE" ||
      hasHash ||
      Boolean(txState && TX_SETTLED_STATES.has(txState)),
    dead: false,
  };
}

export type ChallengeSettlement = {
  challengeId: string;
  /** Raw Circle challenge status (PENDING | IN_PROGRESS | COMPLETE | …). */
  status: string;
  /**
   * True when this step can no longer be undone by the user: either Circle
   * marked the challenge COMPLETE, or the correlated transaction already has
   * a hash / reached a sent state. The challenge record lags the chain, so
   * `status === "PENDING"` with a real txHash still means "this happened".
   */
  settled: boolean;
  /** True only for FAILED / EXPIRED / rejected transactions. */
  dead: boolean;
  transactionId?: string;
  txHash?: string;
  txState?: string;
  contractAddress?: string;
  error?: string;
};

/**
 * Read one challenge *and* the transaction it correlates to.
 *
 * A UCW challenge is only flipped to COMPLETE once Circle has finished
 * processing it end to end. For CONTRACT_EXECUTION challenges (approve,
 * depositForBurn) that happens well after the user's PIN and often after the
 * transaction is already mined — so polling `status` alone reports PENDING for
 * a burn that is irreversibly on-chain. Always cross-check the transaction.
 */
export async function readChallengeSettlement(input: {
  userToken: string;
  challengeId: string;
}): Promise<ChallengeSettlement> {
  const client = getUcwClient();
  const out: ChallengeSettlement = {
    challengeId: input.challengeId,
    status: "PENDING",
    settled: false,
    dead: false,
  };

  const chRes = await client.getUserChallenge({
    userToken: input.userToken,
    challengeId: input.challengeId,
  });
  const challenge = unwrapCircleChallenge(chRes.data);

  out.status = String(challenge?.status || "PENDING");
  const challengeOnly = classifyChallenge({ challengeStatus: out.status });
  out.settled = challengeOnly.settled;
  out.dead = challengeOnly.dead;
  if (out.dead) {
    out.error = challenge?.errorMessage || `Challenge ${out.status}`;
    return out;
  }

  const transactionId = challenge?.correlationIds?.find(Boolean);
  if (!transactionId) return out;
  out.transactionId = transactionId;

  try {
    const txRes = await client.getTransaction({
      userToken: input.userToken,
      id: transactionId,
    });
    const tx = unwrapCircleTransaction(txRes.data);
    out.txState = tx?.state ? String(tx.state) : undefined;
    if (tx?.txHash && /^0x[a-fA-F0-9]{64}$/.test(tx.txHash)) {
      out.txHash = tx.txHash;
    }
    if (typeof tx?.contractAddress === "string") {
      out.contractAddress = tx.contractAddress;
    }

    const verdict = classifyChallenge({
      challengeStatus: out.status,
      txHash: out.txHash,
      txState: out.txState,
    });
    out.settled = verdict.settled;
    out.dead = verdict.dead;
    if (out.dead) {
      out.error = tx?.errorReason || `Transaction ${out.txState}`;
    }
  } catch (e) {
    // Transaction not readable yet — challenge status stands on its own.
    console.warn("readChallengeSettlement tx", errorMessage(e));
  }

  return out;
}

/**
 * Wait until every PIN challenge has settled (COMPLETE, or its transaction is
 * on-chain), or one of them is definitively dead.
 *
 * Prevents marking swaps/sends successful when the WebView closed early —
 * while still recognising a burn that landed but whose challenge record has
 * not caught up. Callers must treat `ok: false` with `anySettled: true` as
 * "keep going", not "abort": the money already moved.
 */
export async function waitForChallengesComplete(input: {
  userToken: string;
  challengeIds: string[];
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{
  ok: boolean;
  error?: string;
  statuses: ChallengeSettlement[];
  /** At least one step is irreversible — never discard the activity. */
  anySettled: boolean;
  /** First on-chain hash observed across the batch. */
  txHash?: string;
}> {
  // Circle's own UCW signing strategy waits 10 minutes by default; a 60s
  // ceiling is what made legitimate burns look like stuck PENDING challenges.
  const timeoutMs = input.timeoutMs ?? 300_000;
  const pollMs = input.pollMs ?? 2_500;
  const ids = input.challengeIds.filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, error: "No challenge ids", statuses: [], anySettled: false };
  }
  const start = Date.now();
  const statuses: ChallengeSettlement[] = ids.map((id) => ({
    challengeId: id,
    status: "PENDING",
    settled: false,
    dead: false,
  }));

  const summarise = () => ({
    anySettled: statuses.some((s) => s.settled),
    txHash: statuses.find((s) => s.txHash)?.txHash,
  });

  while (Date.now() - start < timeoutMs) {
    let allSettled = true;
    for (let i = 0; i < ids.length; i++) {
      if (statuses[i]!.settled) continue;
      try {
        const settlement = await readChallengeSettlement({
          userToken: input.userToken,
          challengeId: ids[i]!,
        });
        statuses[i] = settlement;
        if (settlement.dead) {
          return {
            ok: false,
            error: settlement.error || `Challenge ${ids[i]} failed`,
            statuses,
            ...summarise(),
          };
        }
        if (!settlement.settled) allSettled = false;
      } catch (e) {
        allSettled = false;
        console.warn("waitForChallengesComplete", errorMessage(e));
      }
    }
    if (allSettled) return { ok: true, statuses, ...summarise() };
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const pending = statuses.filter((s) => !s.settled);
  return {
    ok: false,
    error: `Challenges not complete: ${pending
      .map((p) => `${p.challengeId.slice(0, 8)}…=${p.status}`)
      .join(", ")}`,
    statuses,
    ...summarise(),
  };
}
