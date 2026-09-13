import {
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { paymentEscrowAbi } from "../abis/escrow.js";
import { config } from "../config.js";
import {
  arcTestnet,
  getPublicClient,
  getWalletClient,
  getDeployerAccount,
  getEscrowAttestorAccount,
  getEscrowAttestorWalletClient,
} from "./arc-wallet.js";
import { computeIdentityKey, type IdentityKind } from "./identity.js";

function escrowAddress(): Address {
  const a = config.arc.paymentEscrow;
  if (!a?.startsWith("0x")) throw new Error("PAYMENT_ESCROW not configured");
  return a as Address;
}

/**
 * Create protected transfer from deployer wallet (test / treasury path).
 * Production: user signs approve+create via Circle UCW challenges.
 */
export async function createProtectedTransfer(input: {
  recipientKind: IdentityKind;
  recipientId: string;
  amountUsdc: number;
  memo?: string;
  expirySeconds?: number;
}) {
  const amount = parseUnits(String(input.amountUsdc), 6);
  const recipientKey = computeIdentityKey(
    input.recipientKind,
    input.recipientId.trim().toLowerCase().replace(/^@/, ""),
  );
  const wallet = getWalletClient();
  const publicClient = getPublicClient();
  const account = getDeployerAccount();
  const escrow = escrowAddress();
  const usdc = config.arc.usdc as Address;

  const approveHash = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [escrow, amount],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const createHash = await wallet.writeContract({
    address: escrow,
    abi: paymentEscrowAbi,
    functionName: "createTransfer",
    args: [
      recipientKey,
      amount,
      BigInt(input.expirySeconds ?? 0),
      input.memo ?? "",
    ],
    account,
    chain: arcTestnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: createHash,
  });

  return {
    approveTx: approveHash,
    createTx: createHash,
    recipientKey,
    amountUsdc: input.amountUsdc,
    blockNumber: receipt.blockNumber.toString(),
  };
}

export async function claimProtectedTransfer(
  transferId: bigint,
  claimer: Address,
) {
  // Signed by the attestor key rather than the ops signer. The contract only
  // accepts claimAttestor here, and keeping the roles apart means a leaked hot
  // ops key cannot release held payments.
  const publicClient = getPublicClient();
  const account = getEscrowAttestorAccount();
  const wallet = getEscrowAttestorWalletClient();
  const hash = await wallet.writeContract({
    address: escrowAddress(),
    abi: paymentEscrowAbi,
    functionName: "claimWithAttestation",
    args: [transferId, claimer],
    account,
    chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { claimTx: hash };
}

export function buildEscrowCreateCalldata(input: {
  recipientKey: Hex;
  amountUsdc: number;
  memo?: string;
  /**
   * Seconds until the hold expires. 0 lets the contract apply its own
   * DEFAULT_EXPIRY of 3 days, which is right for a claim link and far too
   * short for a job, so callers holding money for work should pass a value.
   */
  expirySeconds?: number;
}) {
  const amount = parseUnits(String(input.amountUsdc), 6);
  const escrow = escrowAddress();
  const usdc = config.arc.usdc as Address;
  return {
    steps: [
      {
        to: usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [escrow, amount],
        }),
      },
      {
        to: escrow,
        data: encodeFunctionData({
          abi: paymentEscrowAbi,
          functionName: "createTransfer",
          args: [
            input.recipientKey,
            amount,
            BigInt(input.expirySeconds ?? 0),
            input.memo ?? "",
          ],
        }),
      },
    ],
  };
}
