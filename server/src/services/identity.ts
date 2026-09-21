import { type Address, type Hex, stringToHex, keccak256, encodePacked } from "viem";
import { identityRegistryAbi, IdType } from "../abis/identity.js";
import { config } from "../config.js";
import {
  getIdentityLinkerWalletClient,
  getPublicClient,
} from "./arc-wallet.js";

export type IdentityKind = "phone" | "email" | "handle" | "agent";

function toIdType(kind: IdentityKind): number {
  if (kind === "phone") return IdType.Phone;
  if (kind === "email") return IdType.Email;
  if (kind === "agent") return IdType.Agent;
  return IdType.Handle;
}

export function normalizeIdentifier(kind: IdentityKind, raw: string): string {
  let s = raw.trim().toLowerCase();
  if (kind === "handle" || kind === "agent") s = s.replace(/^@/, "");
  if (kind === "phone") s = s.replace(/[^\d+]/g, "");
  return s;
}

/**
 * The registry PaymentEscrowV3 reads, when it is a different contract. People
 * are linked there too so held payments can still be claimed; agents never
 * are — that registry predates the Agent type and rejects it.
 */
export function escrowRegistryAddress(): Address | null {
  const a = config.arc.escrowIdentityRegistry;
  if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return null;
  if (a.toLowerCase() === config.arc.identityRegistry.toLowerCase()) return null;
  return a as Address;
}

function mirrorsToEscrowRegistry(kind: IdentityKind): boolean {
  return (kind === "email" || kind === "handle") && escrowRegistryAddress() != null;
}

export function registryAddress(): Address {
  const a = config.arc.identityRegistry;
  if (!a || !a.startsWith("0x")) {
    throw new Error("IDENTITY_REGISTRY not configured");
  }
  return a as Address;
}

/** Off-chain key matching Solidity keccak256(abi.encodePacked(uint8, bytes)) */
export function computeIdentityKey(kind: IdentityKind, normalized: string): Hex {
  return keccak256(
    encodePacked(
      ["uint8", "bytes"],
      [toIdType(kind), stringToHex(normalized)],
    ),
  );
}

export async function resolveIdentity(
  kind: IdentityKind,
  identifier: string,
  registry: Address = registryAddress(),
): Promise<{ account: Address; active: boolean; key: Hex; normalized: string }> {
  const normalized = normalizeIdentifier(kind, identifier);
  const publicClient = getPublicClient();
  const [account, active] = await publicClient.readContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "resolveIdentifier",
    args: [toIdType(kind), stringToHex(normalized)],
  });
  const key = computeIdentityKey(kind, normalized);
  return {
    account: account as Address,
    active: Boolean(active),
    key,
    normalized,
  };
}

/**
 * Link after the app has verified contact ownership (Dynamic email OTP, etc.).
 * The dedicated linker can onboard users but cannot change admin privileges.
 */
/** Raised when an identifier is already bound to a different account. */
export class IdentityConflictError extends Error {
  readonly code = "IDENTITY_CONFLICT";
  constructor(
    readonly kind: IdentityKind,
    readonly normalized: string,
    readonly boundTo: Address,
    readonly wanted: Address,
  ) {
    super(
      `${kind} "${normalized}" is already linked to ${boundTo}, not ${wanted}. ` +
        `The registry rejects a re-link (AlreadyLinked); unlink it first.`,
    );
    this.name = "IdentityConflictError";
  }
}

export class IdentityAdminMismatchError extends Error {
  readonly code = "IDENTITY_ADMIN_MISMATCH";
  constructor(readonly configured: Address, readonly onChain: Address) {
    super(
      `Configured identity signer ${configured} is not registry linker ${onChain}.`,
    );
    this.name = "IdentityAdminMismatchError";
  }
}

export async function adminLinkIdentity(input: {
  account: Address;
  kind: IdentityKind;
  identifier: string;
}): Promise<{
  txHash: Hex;
  key: Hex;
  normalized: string;
  status: "linked" | "already-current";
}> {
  if (input.kind === "email" && !config.features.onchainEmailLinks) {
    throw new Error("On-chain email links are disabled for privacy");
  }
  const primary = await linkIn(registryAddress(), input);
  if (mirrorsToEscrowRegistry(input.kind)) {
    await linkIn(escrowRegistryAddress()!, input);
  }
  return primary;
}

async function linkIn(
  registry: Address,
  input: { account: Address; kind: IdentityKind; identifier: string },
): Promise<{
  txHash: Hex;
  key: Hex;
  normalized: string;
  status: "linked" | "already-current";
}> {
  const normalized = normalizeIdentifier(input.kind, input.identifier);
  const wallet = getIdentityLinkerWalletClient();
  const publicClient = getPublicClient();
  const onChainLinker = await publicClient.readContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "linker",
  }) as Address;
  if (onChainLinker.toLowerCase() !== wallet.account!.address.toLowerCase()) {
    throw new IdentityAdminMismatchError(wallet.account!.address, onChainLinker);
  }

  const existing = await resolveIdentity(input.kind, normalized, registry);
  if (existing.active) {
    // Already bound to us — nothing to do.
    if (existing.account.toLowerCase() === input.account.toLowerCase()) {
      return {
        txHash: "0x" as Hex,
        key: existing.key,
        normalized,
        status: "already-current",
      };
    }
    // Bound to someone else. `_linkTo` reverts with AlreadyLinked(), so
    // sending the transaction only wastes gas and buries the real reason in
    // an undecodable revert. Fail loudly instead — resolving this means
    // adminUnlink first, which re-routes payments and must be deliberate.
    throw new IdentityConflictError(
      input.kind,
      normalized,
      existing.account,
      input.account,
    );
  }

  const hash = await wallet.writeContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "adminLink",
    args: [input.account, toIdType(input.kind), stringToHex(normalized)],
    chain: wallet.chain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return {
    txHash: hash,
    key: computeIdentityKey(input.kind, normalized),
    normalized,
    status: "linked",
  };
}

/** Admin unlink so an old @handle is no longer payable. */
export async function adminUnlinkIdentity(input: {
  kind: IdentityKind;
  identifier: string;
}): Promise<{ txHash: Hex; key: Hex; normalized: string } | { skipped: true }> {
  const primary = await unlinkIn(registryAddress(), input);
  if (mirrorsToEscrowRegistry(input.kind)) {
    await unlinkIn(escrowRegistryAddress()!, input);
  }
  return primary;
}

async function unlinkIn(
  registry: Address,
  input: { kind: IdentityKind; identifier: string },
): Promise<{ txHash: Hex; key: Hex; normalized: string } | { skipped: true }> {
  const normalized = normalizeIdentifier(input.kind, input.identifier);
  const existing = await resolveIdentity(input.kind, normalized, registry);
  if (!existing.active) return { skipped: true };
  const wallet = getIdentityLinkerWalletClient();
  const publicClient = getPublicClient();
  const hash = await wallet.writeContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "linkerUnlink",
    args: [existing.account, existing.key],
    chain: wallet.chain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { txHash: hash, key: existing.key, normalized };
}
