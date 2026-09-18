/**
 * On-chain held payments, shared by two features.
 *
 * `PaymentEscrow.claimWithAttestation` is a generic "the server says pay this
 * address now" hook — the contract never asks why. So one contract backs both
 * of the app's held-money flows, differing only in what makes the server
 * attest:
 *
 *   claim-link  — someone was paid at an email address before they had an
 *                 account. Released once they sign up, prove that email, and
 *                 have a wallet to receive it.
 *   job         — an invoice was settled into a hold instead of paid outright.
 *                 Released when the payer says the work arrived.
 *
 * Both expire, and after expiry `refund` returns the money to whoever funded
 * it. That is why the payer's own wallet must be the on-chain sender rather
 * than a platform wallet: a refund then reaches them directly, with no server
 * in the path. It costs a second PIN — the contract pulls funds with
 * `transferFrom`, so the payer approves and then creates — and the multi-step
 * challenge runner already handles that shape for Synthra swaps.
 *
 * Two limits are baked into the deployed contract and cannot be configured:
 * `MAX_EXPIRY` is 365 days, and `refund` becomes callable by anyone once a
 * transfer expires. Claims remain valid while a hold is pending, but an
 * expired job can be refunded first, so jobs use a 90-day tradeoff between
 * giving workers time and locking payer funds.
 */

import { randomUUID } from "node:crypto";
import {
  decodeEventLog,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { paymentEscrowAbi } from "../abis/escrow.js";
import { config } from "../config.js";
import { getPublicClient } from "./arc-wallet.js";
import { buildEscrowCreateCalldata, claimProtectedTransfer } from "./escrow.js";
import { computeIdentityKey, normalizeIdentifier } from "./identity.js";
import { store } from "../store/db.js";
import { alertUser } from "./notifyUser.js";
import { flushPrimaryStore } from "./primary-store.js";

/** The contract's own ceiling. Anything larger reverts with InvalidExpiry. */
export const MAX_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

/**
 * How long a job hold runs before the payer can take it back.
 *
 * Not the ceiling. Expiry now only decides when a refund becomes possible —
 * a claim stays valid while the hold is pending, so releasing late still
 * pays. Longer therefore favours the worker, since after expiry anyone may
 * refund the payer, and shorter favours the payer, whose money is otherwise
 * locked. Three months is long enough for real work without tying up funds
 * for a year.
 */
export const JOB_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

/** Long enough for someone to notice an email and sign up. */
export const CLAIM_LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/**
 * The window in which a sender may take back a first payment to someone new.
 * Scam calls push people to pay before they can think; ten minutes is enough
 * to hang up, check, and cancel.
 */
export const COOLING_OFF_SECONDS = 10 * 60;

/**
 * On-chain expiry for a cooling-off hold. The server releases it after
 * COOLING_OFF_SECONDS; this is only the safety net. If the server never
 * releases it — down, misconfigured, out of gas — the money returns to the
 * sender after a day rather than sitting with nobody watching.
 */
export const COOLING_OFF_EXPIRY_SECONDS = 24 * 60 * 60;

export type EscrowPurpose = "claim_link" | "job" | "cooling_off";

export class EscrowError extends Error {}

/**
 * How an identifier must be typed on chain.
 *
 * Identity keys are `keccak256(idType, identifier)`, so the type is part of
 * the key: the same email hashed as a handle produces a different key that
 * nothing will ever resolve. One live transfer was created that way and could
 * never have been claimed even before it expired. Deriving the type from the
 * identifier here means a caller cannot get the pairing wrong.
 */
export function escrowIdentityKind(identifier: string): "email" | "handle" {
  const raw = identifier.trim();
  if (raw.includes("@") && !raw.startsWith("@")) return "email";
  return "handle";
}

/** The on-chain recipient fingerprint for an identifier. */
export function escrowRecipientKey(identifier: string): {
  kind: "email" | "handle";
  normalized: string;
  key: Hex;
} {
  const kind = escrowIdentityKind(identifier);
  const normalized = normalizeIdentifier(kind, identifier);
  if (!normalized) throw new EscrowError("Recipient is empty");
  if (kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new EscrowError(`"${identifier}" is not a valid email address`);
  }
  return { kind, normalized, key: computeIdentityKey(kind, normalized) };
}

export type EscrowPlan = {
  draftId: string;
  recipientKey: Hex;
  recipientKind: "email" | "handle";
  recipientId: string;
  amountUsdc: number;
  expirySeconds: number;
  expiresAt: string;
  purpose: EscrowPurpose;
  /** approve, then createTransfer — run in order by the challenge runner. */
  steps: Array<{ to: string; data: Hex; step: "approve" | "create" }>;
};

/**
 * Builds the two calls the payer's wallet must sign to lock the money.
 *
 * Nothing is recorded yet: a plan the user abandons at the PIN screen must
 * leave no trace claiming their money is held.
 */
export function planProtectedEscrow(input: {
  recipientId: string;
  amountUsdc: number;
  memo?: string;
  purpose: EscrowPurpose;
  expirySeconds?: number;
}): EscrowPlan {
  if (!(input.amountUsdc > 0)) throw new EscrowError("Amount must be positive");
  const { kind, normalized, key } = escrowRecipientKey(input.recipientId);

  // A cooling-off hold always uses its fixed expiry: a longer one would leave
  // the money stuck longer if the server never releases it.
  const requested =
    input.purpose === "cooling_off"
      ? COOLING_OFF_EXPIRY_SECONDS
      : input.expirySeconds ??
        (input.purpose === "claim_link"
          ? CLAIM_LINK_EXPIRY_SECONDS
          : JOB_EXPIRY_SECONDS);
  const expirySeconds = Math.min(requested, MAX_EXPIRY_SECONDS);

  const { steps } = buildEscrowCreateCalldata({
    recipientKey: key,
    amountUsdc: input.amountUsdc,
    memo: input.memo ?? "",
    expirySeconds,
  });

  return {
    draftId: randomUUID(),
    recipientKey: key,
    recipientKind: kind,
    recipientId: normalized,
    amountUsdc: input.amountUsdc,
    expirySeconds,
    expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
    purpose: input.purpose,
    steps: [
      { to: steps[0]!.to, data: steps[0]!.data as Hex, step: "approve" },
      { to: steps[1]!.to, data: steps[1]!.data as Hex, step: "create" },
    ],
  };
}

/**
 * Reads the transfer id the contract assigned, from the creating transaction.
 *
 * The id is the handle for every later action — claim and refund both take it
 * — and it exists only in the receipt, so a lock whose id is never read is a
 * lock nobody can release. Taken from the event rather than from a counter
 * read afterwards, which would race with anyone else creating a transfer.
 */
export type CreatedTransfer = {
  transferId: string;
  amountUsdc: number;
  recipientKey: Hex;
  sender: Address;
  expiresAt: string;
};

/**
 * Every hold one transaction created on the current contract, in the order
 * they were created. A milestone invoice creates several in one batch.
 */
export async function readCreatedTransferIds(txHash: string): Promise<CreatedTransfer[]> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new EscrowError("Not a transaction hash");
  }
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  if (receipt.status !== "success") {
    throw new EscrowError("That transaction did not succeed");
  }
  const escrow = (config.arc.paymentEscrow ?? "").toLowerCase();
  const out: CreatedTransfer[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrow) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: paymentEscrowAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== "TransferCreated") continue;
    const args = decoded.args as unknown as {
      transferId: bigint;
      sender: Address;
      recipientKey: Hex;
      amount: bigint;
      expiresAt: bigint;
    };
    out.push({
      transferId: args.transferId.toString(),
      amountUsdc: Number(args.amount) / 1e6,
      recipientKey: args.recipientKey,
      sender: args.sender,
      expiresAt: new Date(Number(args.expiresAt) * 1000).toISOString(),
    });
  }
  return out;
}

export async function readCreatedTransferId(txHash: string): Promise<CreatedTransfer> {
  const [first] = await readCreatedTransferIds(txHash);
  if (!first) {
    throw new EscrowError(
      "That transaction did not create a held payment on this contract",
    );
  }
  return first;
}

/**
 * The calls that lock several milestone holds for one person under a single
 * PIN: one approval for the total, then one hold per milestone. Each hold is
 * released on its own, as that milestone is delivered.
 */
export function planMilestoneHolds(input: {
  recipientId: string;
  milestones: Array<{ amountUsdc: number; memo: string }>;
  expirySeconds?: number;
}): { recipientKey: Hex; totalUsdc: number; calls: Array<{ to: Address; data: Hex }> } {
  if (input.milestones.length < 2 || input.milestones.length > 10) {
    throw new EscrowError("Split the work into 2 to 10 milestones");
  }
  const { key } = escrowRecipientKey(input.recipientId);
  const expirySeconds = Math.min(input.expirySeconds ?? JOB_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS);
  let totalUnits = 0n;
  const creates: Array<{ to: Address; data: Hex }> = [];
  let approveTo: Address | null = null;
  for (const m of input.milestones) {
    if (!(m.amountUsdc > 0)) throw new EscrowError("Every milestone needs an amount");
    const { steps } = buildEscrowCreateCalldata({
      recipientKey: key,
      amountUsdc: m.amountUsdc,
      memo: m.memo.slice(0, 120),
      expirySeconds,
    });
    approveTo = steps[0]!.to as Address;
    creates.push({ to: steps[1]!.to as Address, data: steps[1]!.data as Hex });
    totalUnits += BigInt(Math.round(m.amountUsdc * 1e6));
  }
  const totalUsdc = Number(totalUnits) / 1e6;
  const { steps: approveSteps } = buildEscrowCreateCalldata({
    recipientKey: key,
    amountUsdc: totalUsdc,
    expirySeconds,
  });
  return {
    recipientKey: key,
    totalUsdc,
    calls: [
      { to: (approveTo ?? approveSteps[0]!.to) as Address, data: approveSteps[0]!.data as Hex },
      ...creates,
    ],
  };
}

/** Live contract state for one transfer. */
export async function readTransfer(transferId: string): Promise<{
  sender: Address;
  recipientKey: Hex;
  amountUsdc: number;
  createdAt: number;
  expiresAt: number;
  status: "None" | "Pending" | "Claimed" | "Refunded";
  expired: boolean;
}> {
  const client = getPublicClient();
  const t = (await client.readContract({
    address: config.arc.paymentEscrow as Address,
    abi: paymentEscrowAbi,
    functionName: "transfers",
    args: [BigInt(transferId)],
  })) as readonly unknown[];

  const names = ["None", "Pending", "Claimed", "Refunded"] as const;
  const expiresAt = Number(t[4] as bigint);
  return {
    sender: t[0] as Address,
    recipientKey: t[1] as Hex,
    amountUsdc: Number(t[2] as bigint) / 1e6,
    createdAt: Number(t[3] as bigint),
    expiresAt,
    // Index 5, not 6: V2 dropped the password hash from the struct.
    status: names[Number(t[5])] ?? "None",
    expired: expiresAt * 1000 <= Date.now(),
  };
}

/**
 * Where a claim would pay right now, straight from the contract.
 *
 * V2 resolves the recipient itself and refuses to pay anyone else, so this is
 * the authority on whether a release will succeed. Worth asking before
 * attempting one: the common reason for `claimable: false` is simply that the
 * recipient has signed up but their identity link has not landed on chain
 * yet, which is a wait rather than a failure.
 */
export async function readClaimTarget(transferId: string): Promise<{
  account: Address | null;
  claimable: boolean;
}> {
  const client = getPublicClient();
  const [account, claimable] = (await client.readContract({
    address: config.arc.paymentEscrow as Address,
    abi: paymentEscrowAbi,
    functionName: "claimTarget",
    args: [BigInt(transferId)],
  })) as [Address, boolean];
  return {
    account: account === "0x0000000000000000000000000000000000000000" ? null : account,
    claimable,
  };
}

/**
 * Releases a held payment to an address.
 *
 * The hardened contract resolves the stored recipient key itself and rejects
 * any different claimer. The server repeats that identity check before
 * signing so a bad request fails without spending attestor gas.
 */
export async function releaseProtectedEscrow(input: {
  transferId: string;
  /** Identity the money was locked for, e.g. the claimant's verified email. */
  recipientId: string;
  /** Wallet to pay — the claimant's own, never chosen by the caller. */
  claimerAddress: string;
}): Promise<{ claimTx: string; amountUsdc: number }> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.claimerAddress)) {
    throw new EscrowError("Claimer needs a wallet address");
  }
  const onChain = await readTransfer(input.transferId);
  if (onChain.status !== "Pending") {
    throw new EscrowError(`This payment is already ${onChain.status.toLowerCase()}`);
  }
  if (onChain.expired) {
    throw new EscrowError(
      "This payment expired and can only be refunded to the sender now",
    );
  }

  const { key } = escrowRecipientKey(input.recipientId);
  if (key.toLowerCase() !== onChain.recipientKey.toLowerCase()) {
    throw new EscrowError("This payment was not locked for that recipient");
  }

  // V2 resolves the recipient itself and pays nobody else, so ask it rather
  // than guessing. The usual reason a claim is not yet possible is that the
  // recipient signed up moments ago and their identity link has not landed on
  // chain, which is worth saying plainly instead of surfacing a raw revert.
  const target = await readClaimTarget(input.transferId);
  if (!target.claimable || !target.account) {
    throw new EscrowError(
      "The recipient identity is not registered on chain yet — this will work once it is",
    );
  }
  if (target.account.toLowerCase() !== input.claimerAddress.toLowerCase()) {
    throw new EscrowError(
      "That wallet is not the one this identity resolves to",
    );
  }

  const { claimTx } = await claimProtectedTransfer(
    BigInt(input.transferId),
    input.claimerAddress as Address,
  );
  return { claimTx, amountUsdc: onChain.amountUsdc };
}

/**
 * Whether an email already belongs to an account.
 *
 * The send flow asks before locking anything, so the payer can be told the
 * recipient has no account yet and choose to hold the money for them rather
 * than discovering it afterwards.
 */
export function isRegistered(identifier: string): boolean {
  const { kind, normalized } = escrowRecipientKey(identifier);
  if (kind === "email") {
    const user = store.findUserByEmail(normalized);
    return Boolean(user?.evmAddress);
  }
  const user = store.findUserByHandle(normalized);
  return Boolean(user?.evmAddress);
}

/**
 * Releases anything held for a user who has just signed in with a wallet.
 *
 * This is what closes the claim-link loop: someone was paid at an email
 * address before they had an account, and the money sits in the contract
 * until there is a wallet to send it to. The moment they finish signing up,
 * it lands.
 *
 * The email must come from the verified session token, never from the request
 * body. A caller who could name their own email would be able to claim
 * anyone's held money simply by asking for it, which is the one thing this
 * whole flow must not allow.
 *
 * Runs in the background: a slow chain write must not hold up the sign-in
 * response, and a failure only means the money stays held for the next
 * attempt, which is the safe direction.
 */
export function claimHeldPaymentsInBackground(input: {
  userId: string;
  verifiedEmail: string;
  walletAddress: string;
}): void {
  if (!input.verifiedEmail?.includes("@")) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) return;

  void (async () => {
    try {
      const { listLocalPending, markTrackedClaimed } = await import(
        "./escrow-jobs.js"
      );
      const { normalized } = escrowRecipientKey(input.verifiedEmail);
      // Claim links only. A job hold addressed to the same email must wait for
      // delivery; releasing it because the worker signed in would pay for work
      // nobody has seen.
      const waiting = listLocalPending().filter(
        (e) =>
          e.recipientId === normalized &&
          e.onChainTransferId &&
          (e.purpose ?? "claim_link") === "claim_link",
      );
      if (waiting.length === 0) return;

      // The identity link is written to the registry in the background at
      // sign-in, and V2 will not release to an identity it cannot resolve. So
      // wait for the chain to catch up rather than racing it: a few seconds
      // here saves the user from having to sign in twice. If it never lands
      // the money simply stays held and the next sign-in tries again, which
      // is the safe direction to fail in.
      for (let attempt = 0; attempt < 6; attempt++) {
        const probe = await readClaimTarget(waiting[0]!.onChainTransferId!);
        if (probe.claimable) break;
        await new Promise((r) => setTimeout(r, 2500));
      }

      for (const held of waiting) {
        try {
          const out = await releaseProtectedEscrow({
            transferId: held.onChainTransferId!,
            recipientId: normalized,
            claimerAddress: input.walletAddress,
          });
          markTrackedClaimed(held.id, out.claimTx);
          store.addActivity({
            userId: input.userId,
            kind: "receive",
            title: "Money claimed",
            description: `${out.amountUsdc} USDC that was waiting for you`,
            amountUsdc: out.amountUsdc,
            token: "USDC",
            amountToken: out.amountUsdc,
            receiver: input.walletAddress,
            txHash: out.claimTx,
            mode: "protected_escrow_claim",
            status: "completed",
          });
          alertUser(input.userId, {
            kind: "hold_released",
            moneyIn: true,
            title: "Money claimed",
            body: `${out.amountUsdc} USDC that was waiting for you`,
            amountUsdc: out.amountUsdc,
            token: "USDC",
            txHash: out.claimTx,
          });
          console.log(
            `[escrow] released ${out.amountUsdc} USDC to ${input.userId} (transfer ${held.onChainTransferId})`,
          );
        } catch (e) {
          // An expired hold is the common case here and is not an error: the
          // refund sweep will return it to the sender.
          console.warn(
            `[escrow] could not release transfer ${held.onChainTransferId}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    } catch (e) {
      console.warn(
        "[escrow] claim-on-signin failed:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      // Claim-on-sign-in runs after the signup response. Persist any claim and
      // activity changes here because the response middleware has already run.
      await flushPrimaryStore().catch((e) => {
        console.error(
          "[escrow] claim-on-signin persistence failed:",
          e instanceof Error ? e.message : e,
        );
      });
    }
  })();
}
