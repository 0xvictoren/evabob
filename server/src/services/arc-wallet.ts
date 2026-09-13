import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/** Arc Testnet chain definition for viem */
export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [config.arc.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
} as const;

export function getPublicClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(config.arc.rpcUrl),
  });
}

function accountFrom(pk: string, label: string) {
  if (!pk) throw new Error(`${label} not configured`);
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  return privateKeyToAccount(key as Hex);
}

/**
 * Ops signer. Pays gas and moves working-capital USDC: CCTP mints, Gateway
 * burn-intent delegation, App Kit viem-ops sends, escrow refunds.
 *
 * This is the most exposed key in the system — it signs on every money path.
 * It should hold NO admin role on either contract, so that compromising it
 * cannot rewrite the identity registry or drain escrow. See
 * docs/KEY_ROTATION.md.
 */
export function getDeployerAccount() {
  return accountFrom(config.arc.privateKey, "PRIVATE_KEY");
}

export function getWalletClient() {
  return createWalletClient({
    account: getDeployerAccount(),
    chain: arcTestnet,
    transport: http(config.arc.rpcUrl),
  });
}

export function getDeployerAddress(): Address {
  return getDeployerAccount().address;
}

/**
 * IdentityRegistry linker. Signs verified links and same-owner unlinks only.
 *
 * This role stays hot because onboarding must be automatic. It cannot rotate
 * itself or the registry administrator; those actions require the Safe.
 *
 * Falls back to PRIVATE_KEY so an unrotated deployment keeps working.
 */
export function getIdentityLinkerAccount() {
  const pk = config.arc.identityLinkerPrivateKey || config.arc.privateKey;
  return accountFrom(pk, "IDENTITY_LINKER_PRIVATE_KEY / PRIVATE_KEY");
}

export function getIdentityLinkerWalletClient() {
  return createWalletClient({
    account: getIdentityLinkerAccount(),
    chain: arcTestnet,
    transport: http(config.arc.rpcUrl),
  });
}

export function getIdentityLinkerAddress(): Address {
  return getIdentityLinkerAccount().address;
}

/**
 * The key allowed to release held payments.
 *
 * Worth separating from the ops signer because the two fail differently. The
 * ops key spends the platform wallet; this one only decides the moment a hold
 * is released, and since V2 asks the registry who to pay, it cannot choose a
 * destination. Splitting them means a leaked hot ops key cannot release
 * escrows, and a leaked attestor key cannot spend anything.
 *
 * It is also the safest role to rotate, because the escrow admin can always
 * point `setClaimAttestor` somewhere else.
 *
 * Falls back to PRIVATE_KEY so an unrotated deployment keeps working.
 */
export function getEscrowAttestorAccount() {
  const pk = config.arc.escrowAttestorPrivateKey || config.arc.privateKey;
  return accountFrom(pk, "ESCROW_ATTESTOR_PRIVATE_KEY / PRIVATE_KEY");
}

export function getEscrowAttestorWalletClient() {
  return createWalletClient({
    account: getEscrowAttestorAccount(),
    chain: arcTestnet,
    transport: http(config.arc.rpcUrl),
  });
}

export function getEscrowAttestorAddress(): Address {
  return getEscrowAttestorAccount().address;
}

