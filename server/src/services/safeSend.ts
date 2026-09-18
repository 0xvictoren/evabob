/**
 * Checks shown before a payment leaves: is this someone you have paid before,
 * is it who you think it is, and does this address only look familiar.
 *
 * Scams steer people to irreversible payments to people they have never paid:
 * the voice-cloned "family emergency", the fake vendor, the invoice with a
 * changed account. Regulators now make banks reimburse those; a stablecoin
 * send cannot be taken back at all. So Evabob slows down exactly that case and
 * nothing else — a first payment to someone new — by showing the resolved
 * name and offering a ten-minute cooling-off hold the sender can cancel.
 *
 * Raw addresses get a plain warning instead, because a hold needs an identity
 * to release to. Address poisoning — an attacker sends dust from an address
 * that matches the start and end of one you use, hoping you copy it from your
 * history — gets its own, stronger warning.
 */

import { resolvePayee, looksLikeEvm } from "./resolvePayee.js";
import { store, type ActivityItem, type UserRecord } from "../store/db.js";

export type PayeeWarning =
  | "first_payment"
  | "raw_address_new"
  | "raw_address_not_evabob"
  | "looks_like_known_address";

export type PayeeCheck = {
  ok: true;
  input: string;
  kind: "address" | "contact" | "email" | "handle";
  address: string;
  /** What to show as "who": handle, else email, else a shortened address. */
  label: string;
  displayName?: string;
  avatarUrl?: string;
  /** A person with an Evabob account, which is what a hold can release to. */
  isEvabobUser: boolean;
  /** This sender has completed a payment to this payee before. */
  paidBefore: boolean;
  warnings: PayeeWarning[];
  /** For looks_like_known_address: the address it resembles. */
  resembles?: string;
  coolingOff: {
    /** A hold can be used: the payee is a registered identity. */
    available: boolean;
    /**
     * The identity a hold must be locked for — the payee's handle, else email.
     * Needed when the payee was entered as a raw address: a hold releases to
     * an identity, never to an address.
     */
    recipient?: string;
    /** Default it on: a first payment to someone new. */
    recommended: boolean;
    minutes: number;
  };
};

export type PayeeCheckError = { ok: false; code: string; error: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Addresses and identities this sender has actually paid. */
export function priorPayees(sends: ActivityItem[]): {
  addresses: Set<string>;
  identities: Set<string>;
} {
  const addresses = new Set<string>();
  const identities = new Set<string>();
  for (const a of sends) {
    if (a.kind !== "send" || a.status === "failed" || a.status === "cancelled") continue;
    if (a.receiver && looksLikeEvm(a.receiver)) addresses.add(a.receiver.toLowerCase());
    for (const v of [a.counterparty, a.title]) {
      if (!v) continue;
      if (looksLikeEvm(v)) addresses.add(v.toLowerCase());
      else identities.add(v.trim().replace(/^@/, "").toLowerCase());
    }
  }
  return { addresses, identities };
}

/**
 * An address that shares its first and last four characters with one already
 * paid, without being it. That is how poisoned addresses are built, because
 * those are the characters people actually check.
 */
export function resemblesKnownAddress(
  address: string,
  known: Iterable<string>,
): string | null {
  const a = address.toLowerCase();
  for (const k of known) {
    if (k === a) continue;
    if (k.slice(2, 6) === a.slice(2, 6) && k.slice(-4) === a.slice(-4)) return k;
  }
  return null;
}

/** Pure assessment, given what is already known about the sender's history. */
export function assessPayee(input: {
  kind: PayeeCheck["kind"];
  address: string;
  user?: UserRecord;
  inputText: string;
  prior: { addresses: Set<string>; identities: Set<string> };
  coolingOffMinutes: number;
  holdsEnabled: boolean;
}): Omit<PayeeCheck, "ok" | "input"> {
  const address = input.address.toLowerCase();
  const user = input.user;
  const identityIds = [user?.handle, user?.email]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  const paidBefore =
    input.prior.addresses.has(address) ||
    identityIds.some((id) => input.prior.identities.has(id));

  const warnings: PayeeWarning[] = [];
  let resembles: string | undefined;
  if (!paidBefore) warnings.push("first_payment");
  if (input.kind === "address") {
    if (!paidBefore) warnings.push("raw_address_new");
    if (!user) warnings.push("raw_address_not_evabob");
    const look = resemblesKnownAddress(address, input.prior.addresses);
    if (look) {
      warnings.push("looks_like_known_address");
      resembles = look;
    }
  }

  // A hold releases to an identity, so a raw address qualifies only when it
  // belongs to an Evabob user who has a handle or email to release to.
  const available = input.holdsEnabled && Boolean(user && identityIds.length > 0);
  return {
    kind: input.kind,
    address: input.address,
    label: user?.handle ? `@${user.handle}` : user?.email || short(input.address),
    ...(user?.displayName ? { displayName: user.displayName } : {}),
    ...(user?.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    isEvabobUser: Boolean(user),
    paidBefore,
    warnings,
    ...(resembles ? { resembles } : {}),
    coolingOff: {
      available,
      ...(available ? { recipient: user?.handle ? `@${user.handle}` : user?.email } : {}),
      recommended: available && !paidBefore,
      minutes: input.coolingOffMinutes,
    },
  };
}

/** Resolve a payee for the signed-in sender and assess it. */
export function checkPayee(input: {
  userId: string;
  to: string;
  coolingOffMinutes: number;
  holdsEnabled: boolean;
}): PayeeCheck | PayeeCheckError {
  const resolved = resolvePayee(input.userId, input.to);
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };

  // A pasted address may still belong to someone on Evabob.
  const user =
    resolved.user ??
    store.listUsers().find(
      (u) => u.evmAddress?.toLowerCase() === resolved.address.toLowerCase(),
    );
  const sends = store.listActivity(input.userId, 1000).filter((a) => a.kind === "send");
  return {
    ok: true,
    input: input.to,
    ...assessPayee({
      kind: resolved.kind,
      address: resolved.address,
      user,
      inputText: input.to,
      prior: priorPayees(sends),
      coolingOffMinutes: input.coolingOffMinutes,
      holdsEnabled: input.holdsEnabled,
    }),
  };
}
