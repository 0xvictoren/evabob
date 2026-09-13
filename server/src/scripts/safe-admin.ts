import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { identityRegistryAbi } from "../abis/identity.js";
import { paymentEscrowAbi } from "../abis/escrow.js";
import { config } from "../config.js";
import { getPublicClient, getWalletClient } from "../services/arc-wallet.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const safeAbi = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approvedHashes",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "hash", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approveHash",
    stateMutability: "nonpayable",
    inputs: [{ name: "hashToApprove", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "swapOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "oldOwner", type: "address" },
      { name: "newOwner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "changeThreshold",
    stateMutability: "nonpayable",
    inputs: [{ name: "_threshold", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getTransactionHash",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

type SavedTransaction = {
  chainId: number;
  safe: Address;
  operationName: string;
  target: Address;
  value: "0";
  data: Hex;
  operation: 0;
  safeTxGas: "0";
  baseGas: "0";
  gasPrice: "0";
  gasToken: typeof ZERO;
  refundReceiver: typeof ZERO;
  nonce: string;
  txHash: Hex;
  approveCalldata: Hex;
};

function safeAddress(): Address {
  if (!isAddress(config.arc.adminSafeAddress)) {
    throw new Error("ADMIN_SAFE_ADDRESS is missing or invalid");
  }
  return getAddress(config.arc.adminSafeAddress);
}

function addressArgument(index: number, label: string): Address {
  const raw = process.argv[index];
  if (!raw || !isAddress(raw)) throw new Error(`${label} must be a valid address`);
  return getAddress(raw);
}

async function status(): Promise<void> {
  const client = getPublicClient();
  const safe = safeAddress();
  const [owners, threshold, nonce] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  ]);
  console.log(JSON.stringify({ safe, threshold: Number(threshold), nonce: nonce.toString(), owners }, null, 2));
}

async function operation(
  client: ReturnType<typeof getPublicClient>,
  safe: Address,
): Promise<{ name: string; target: Address; data: Hex }> {
  const name = process.argv[3];
  if (name === "set-linker") {
    return {
      name,
      target: getAddress(config.arc.identityRegistry),
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "setLinker",
        args: [addressArgument(4, "New linker")],
      }),
    };
  }
  if (name === "set-attestor") {
    return {
      name,
      target: getAddress(config.arc.paymentEscrow),
      data: encodeFunctionData({
        abi: paymentEscrowAbi,
        functionName: "setClaimAttestor",
        args: [addressArgument(4, "New attestor")],
      }),
    };
  }
  if (name === "unlink") {
    const key = process.argv[4];
    if (!key || !isHex(key) || key.length !== 66) {
      throw new Error("Identity key must be a 32-byte hex value");
    }
    return {
      name,
      target: getAddress(config.arc.identityRegistry),
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "adminUnlink",
        args: [key],
      }),
    };
  }
  if (name === "replace-owner") {
    const oldOwner = addressArgument(4, "Old owner");
    const newOwner = addressArgument(5, "New owner");
    const owners = await client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    const index = owners.findIndex((owner) => owner.toLowerCase() === oldOwner.toLowerCase());
    if (index < 0) throw new Error("Old owner is not a Safe owner");
    if (owners.some((owner) => owner.toLowerCase() === newOwner.toLowerCase())) {
      throw new Error("New owner is already a Safe owner");
    }
    const code = await client.getBytecode({ address: newOwner });
    if (code && code !== "0x") throw new Error("New owner must be an EOA for this runbook");
    const previousOwner = index === 0 ? getAddress("0x0000000000000000000000000000000000000001") : owners[index - 1];
    return {
      name,
      target: safe,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "swapOwner",
        args: [previousOwner, oldOwner, newOwner],
      }),
    };
  }
  if (name === "set-threshold") {
    const owners = await client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    const threshold = Number(process.argv[4]);
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new Error(`Threshold must be between 1 and ${owners.length}`);
    }
    return {
      name,
      target: safe,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "changeThreshold",
        args: [BigInt(threshold)],
      }),
    };
  }
  throw new Error(
    "Operation must be set-linker, set-attestor, unlink, replace-owner, or set-threshold",
  );
}

async function prepare(): Promise<void> {
  const client = getPublicClient();
  const safe = safeAddress();
  const selected = await operation(client, safe);
  const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const common = [selected.target, 0n, selected.data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce] as const;
  const txHash = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: common,
  });
  const approveCalldata = encodeFunctionData({
    abi: safeAbi,
    functionName: "approveHash",
    args: [txHash],
  });
  const saved: SavedTransaction = {
    chainId: config.arc.chainId,
    safe,
    operationName: selected.name,
    target: selected.target,
    value: "0",
    data: selected.data,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: nonce.toString(),
    txHash,
    approveCalldata,
  };
  const directory = resolve(process.cwd(), "data", "safe-transactions");
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${nonce}-${selected.name}-${txHash.slice(2, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ proposal: path, ...saved }, null, 2));
}

function preApprovedSignature(owner: Address): Hex {
  return concatHex([padHex(owner, { size: 32 }), padHex("0x", { size: 32 }), "0x01"]);
}

async function execute(): Promise<void> {
  const pathArg = process.argv[3];
  if (!pathArg) throw new Error("Pass the saved proposal JSON path");
  const saved = JSON.parse(readFileSync(resolve(process.cwd(), pathArg), "utf8")) as SavedTransaction;
  const safe = safeAddress();
  if (saved.safe.toLowerCase() !== safe.toLowerCase() || saved.chainId !== config.arc.chainId) {
    throw new Error("Proposal is for a different Safe or chain");
  }

  const client = getPublicClient();
  const currentNonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  if (currentNonce.toString() !== saved.nonce) throw new Error("Proposal nonce is stale");
  const values = [
    saved.target,
    BigInt(saved.value),
    saved.data,
    saved.operation,
    BigInt(saved.safeTxGas),
    BigInt(saved.baseGas),
    BigInt(saved.gasPrice),
    saved.gasToken,
    saved.refundReceiver,
    BigInt(saved.nonce),
  ] as const;
  const recomputed = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: values,
  });
  if (recomputed.toLowerCase() !== saved.txHash.toLowerCase()) {
    throw new Error("Proposal hash does not match its transaction fields");
  }

  const [owners, threshold] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
  ]);
  const approvals = await Promise.all(owners.map(async (owner) => ({
    owner,
    approved: await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "approvedHashes",
      args: [owner, saved.txHash],
    }),
  })));
  const approvedOwners = approvals
    .filter(({ approved }) => approved > 0n)
    .map(({ owner }) => owner)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (approvedOwners.length < Number(threshold)) {
    throw new Error(`Need ${threshold} owner approvals; found ${approvedOwners.length}`);
  }
  const signatures = concatHex(approvedOwners.slice(0, Number(threshold)).map(preApprovedSignature));
  const wallet = getWalletClient();
  const args: readonly [
    Address,
    bigint,
    Hex,
    number,
    bigint,
    bigint,
    bigint,
    Address,
    Address,
    Hex,
  ] = [
    saved.target,
    BigInt(saved.value),
    saved.data,
    saved.operation,
    BigInt(saved.safeTxGas),
    BigInt(saved.baseGas),
    BigInt(saved.gasPrice),
    saved.gasToken,
    saved.refundReceiver,
    signatures,
  ];
  const { request } = await client.simulateContract({
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args,
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ txHash: hash, status: receipt.status, safe, approvedOwners }, null, 2));
}

const command = process.argv[2];
if (command === "status") await status();
else if (command === "prepare") await prepare();
else if (command === "execute") await execute();
else throw new Error("Command must be status, prepare, or execute");
