/**
 * A second confirmation before paying family, against voice-clone scams.
 *
 * The call sounds exactly like a son or a mother: an accident, a fine, money
 * needed now. A PIN does nothing here — the person typing it is the account
 * owner, acting in good faith. What helps is a pause and a step that happens
 * somewhere other than the phone call.
 *
 * So a person marks contacts as family and picks an amount. A payment to one
 * of them above that amount needs a 6-digit code emailed to the sender's own
 * account email, entered before the PIN. The product owner chose the email
 * code over an in-app "hang up and call them back" prompt, knowing a scammer
 * on the line can ask for the code; the email says plainly never to read it
 * out to anyone.
 *
 * Enforced by the server on the send route, not only in the app, so an older
 * build cannot skip it.
 *
 * Pending codes live in memory: they last ten minutes and a restart only means
 * asking for a new one. The family marks and the amount are stored with the
 * contacts and the user.
 */

import { createHash, randomInt } from "node:crypto";
import { store } from "../store/db.js";
import { sendVerificationEmail } from "./notify.js";

export const DEFAULT_FAMILY_CHECK_ABOVE = 100;
export const FAMILY_CODE_TTL_MS = 10 * 60 * 1000;
/** Time from entering the code to finishing the PIN. */
export const FAMILY_PASS_TTL_MS = 10 * 60 * 1000;
export const FAMILY_MAX_ATTEMPTS = 5;
/** A new code no sooner than this after the last, so the inbox is not flooded. */
const RESEND_AFTER_MS = 30 * 1000;

type Pending = {
  codeHash: string;
  dest: string;
  amount: number;
  token: string;
  sentAt: number;
  expiresAt: number;
  attempts: number;
  verifiedAt?: number;
  /**
   * What the verified code still covers. A payment can leave in parts — half
   * now and half held, from a chat — and each part draws on the same code.
   */
  remaining?: number;
  usedAt?: number;
};

const pending = new Map<string, Pending>();

export class FamilyCheckError extends Error {
  constructor(
    message: string,
    readonly code:
      | "FAMILY_CHECK_REQUIRED"
      | "FAMILY_CODE_WRONG"
      | "FAMILY_CODE_EXPIRED"
      | "FAMILY_CODE_LOCKED"
      | "FAMILY_CODE_TOO_SOON"
      | "FAMILY_NO_EMAIL",
    readonly status: 400 | 403 | 429 = 400,
  ) {
    super(message);
  }
}

function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  const name = email.slice(0, at);
  return `${name[0]}${"•".repeat(Math.max(2, name.length - 1))}${email.slice(at)}`;
}

/** The amount above which family payments need the code. */
export function familyCheckAbove(userId: string): number {
  const v = store.getUser(userId)?.familyCheckAbove;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FAMILY_CHECK_ABOVE;
}

/**
 * Whether this payment needs the code. Pure apart from reading the contacts,
 * so the send route and the payee check agree.
 */
export function familyCheckNeeded(input: {
  userId: string;
  dest: string;
  amount: number;
  token: string;
}): { needed: boolean; contactName?: string; above: number } {
  const above = familyCheckAbove(input.userId);
  const dest = input.dest.toLowerCase();
  const contact = store
    .listContacts(input.userId)
    .find((c) => c.family && c.address.toLowerCase() === dest);
  if (!contact) return { needed: false, above };
  // Bitcoin amounts are tiny numbers, so an amount in dollars means nothing
  // against them: every family payment in it is checked.
  const over = input.token === "CIRBTC" ? true : input.amount > above;
  return { needed: over, contactName: contact.name, above };
}

/** Emails a fresh code for this exact payment. */
export async function startFamilyCheck(input: {
  userId: string;
  dest: string;
  amount: number;
  token: string;
  now?: number;
  /** Tests pass their own delivery; normally the code is emailed. */
  deliver?: (code: string, purpose: string) => Promise<{ emailSent: boolean }>;
}): Promise<
  | { required: false }
  | { required: true; sentTo: string; emailSent: boolean; expiresAt: string; contactName?: string }
> {
  const need = familyCheckNeeded(input);
  if (!need.needed) return { required: false };
  const user = store.getUser(input.userId);
  if (!user?.email || !user.email.includes("@")) {
    throw new FamilyCheckError(
      "Your account has no email to send the code to.",
      "FAMILY_NO_EMAIL",
    );
  }
  const now = input.now ?? Date.now();
  const prev = pending.get(input.userId);
  if (prev && !prev.usedAt && now - prev.sentAt < RESEND_AFTER_MS) {
    throw new FamilyCheckError(
      "A code was just sent. Check your email, or wait a moment for a new one.",
      "FAMILY_CODE_TOO_SOON",
      429,
    );
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  pending.set(input.userId, {
    codeHash: hashCode(input.userId, code),
    dest: input.dest.toLowerCase(),
    amount: input.amount,
    token: input.token,
    sentAt: now,
    expiresAt: now + FAMILY_CODE_TTL_MS,
    attempts: 0,
  });
  const who = need.contactName ?? "a family member";
  const purpose =
    `You are about to pay ${input.amount} ${input.token} to ${who}, who you marked as family. ` +
    `If this started with a call or message asking for money urgently, stop and call them back ` +
    `on the number you already have for them. Never read this code out to anyone.`;
  const sent = input.deliver
    ? await input.deliver(code, purpose)
    : await sendVerificationEmail({ toEmail: user.email, code, purpose });
  return {
    required: true,
    sentTo: maskEmail(user.email),
    emailSent: sent.emailSent,
    expiresAt: new Date(now + FAMILY_CODE_TTL_MS).toISOString(),
    contactName: need.contactName,
  };
}

export function verifyFamilyCode(userId: string, code: string, now = Date.now()): { ok: true } {
  const p = pending.get(userId);
  if (!p || p.usedAt) {
    throw new FamilyCheckError("Ask for a new code.", "FAMILY_CODE_EXPIRED");
  }
  if (now > p.expiresAt) {
    pending.delete(userId);
    throw new FamilyCheckError("That code has expired. Ask for a new one.", "FAMILY_CODE_EXPIRED");
  }
  if (p.attempts >= FAMILY_MAX_ATTEMPTS) {
    pending.delete(userId);
    throw new FamilyCheckError(
      "Too many wrong codes. Ask for a new one.",
      "FAMILY_CODE_LOCKED",
      429,
    );
  }
  if (hashCode(userId, code.trim()) !== p.codeHash) {
    p.attempts += 1;
    throw new FamilyCheckError("That code is not right.", "FAMILY_CODE_WRONG");
  }
  p.verifiedAt = now;
  p.remaining = p.amount;
  return { ok: true };
}

/**
 * Called by the send and hold routes. Throws unless this payment either needs
 * no check or has a code verified for this payee, covering its amount. The
 * code is used up by the payment it was for (in one part or several).
 */
export function requireFamilyPass(
  input: { userId: string; dest: string; amount: number; token: string },
  now = Date.now(),
): void {
  if (!familyCheckNeeded(input).needed) return;
  const p = pending.get(input.userId);
  const matches =
    p &&
    p.verifiedAt != null &&
    !p.usedAt &&
    now - p.verifiedAt <= FAMILY_PASS_TTL_MS &&
    p.dest === input.dest.toLowerCase() &&
    p.token === input.token &&
    input.amount <= (p.remaining ?? 0) + 1e-9;
  if (!matches) {
    throw new FamilyCheckError(
      "Payments to family above your limit need the code from your email first.",
      "FAMILY_CHECK_REQUIRED",
      403,
    );
  }
  p.remaining = (p.remaining ?? 0) - input.amount;
  if (p.remaining <= 1e-9) p.usedAt = now;
}

/** Test hook. */
export function _resetFamilyChecks(): void {
  pending.clear();
}
