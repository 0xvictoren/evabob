import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { store, type AccountRecoveryRequest } from "../store/db.js";
import { sendVerificationEmail } from "./notify.js";
import { alertUser } from "./notifyUser.js";

const CODE_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_COOLING_OFF_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function hashCode(id: string, code: string): string {
  return createHash("sha256").update(`${id}:${code}`).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AccountRecoveryError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

export async function startAccountRecovery(input: {
  subject: string;
  verifiedEmail: string;
  now?: number;
}): Promise<{ requestId: string; emailSent: boolean; codeExpiresAt: string }> {
  const email = input.verifiedEmail.trim().toLowerCase();
  const target = store
    .listUsers()
    .filter((user) => user.id !== input.subject && user.email.trim().toLowerCase() === email)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!target) throw new AccountRecoveryError("No previous account is eligible for recovery", 404);
  const now = input.now ?? Date.now();
  const id = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const record: AccountRecoveryRequest = {
    id,
    requestingSubject: input.subject,
    targetAccountId: target.id,
    email,
    codeHash: hashCode(id, code),
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    codeExpiresAt: new Date(now + CODE_TTL_MS).toISOString(),
  };
  const delivery = await sendVerificationEmail({
    toEmail: email,
    code,
    purpose: "Confirm recovery of your existing Evabob account",
  });
  if (!delivery.emailSent) {
    throw new AccountRecoveryError("Recovery email is temporarily unavailable", 409);
  }
  store.saveAccountRecovery(record);
  alertUser(target.id, {
    kind: "account_recovery",
    title: "Account recovery requested",
    body: "A new sign-in requested access. You can cancel it during the safety delay.",
    link: `evabob://account-recovery/${id}`,
  });
  return { requestId: id, emailSent: true, codeExpiresAt: record.codeExpiresAt };
}

export function confirmAccountRecovery(input: {
  requestId: string;
  subject: string;
  code: string;
  now?: number;
}): AccountRecoveryRequest {
  const record = store.accountRecovery(input.requestId);
  if (!record) throw new AccountRecoveryError("Recovery request not found", 404);
  if (record.requestingSubject !== input.subject) throw new AccountRecoveryError("Recovery request does not belong to this sign-in", 403);
  if (record.cancelledAt || record.completedAt) throw new AccountRecoveryError("Recovery request is closed", 409);
  const now = input.now ?? Date.now();
  if (Date.parse(record.codeExpiresAt) <= now || record.attempts >= MAX_ATTEMPTS) {
    throw new AccountRecoveryError("Recovery code has expired", 409);
  }
  record.attempts += 1;
  if (!/^\d{6}$/.test(input.code) || !equalHash(record.codeHash, hashCode(record.id, input.code))) {
    store.saveAccountRecovery(record);
    throw new AccountRecoveryError("Invalid recovery code", 403);
  }
  record.confirmedAt = new Date(now).toISOString();
  record.executeAfter = new Date(now + RECOVERY_COOLING_OFF_MS).toISOString();
  return store.saveAccountRecovery(record);
}

export function cancelAccountRecovery(input: {
  requestId: string;
  userId: string;
  now?: number;
}): AccountRecoveryRequest {
  const record = store.accountRecovery(input.requestId);
  if (!record) throw new AccountRecoveryError("Recovery request not found", 404);
  if (![record.requestingSubject, record.targetAccountId].includes(input.userId)) {
    throw new AccountRecoveryError("Recovery request does not belong to this account", 403);
  }
  if (record.completedAt) throw new AccountRecoveryError("Recovery is already complete", 409);
  record.cancelledAt = new Date(input.now ?? Date.now()).toISOString();
  return store.saveAccountRecovery(record);
}

export function completeAccountRecovery(input: {
  requestId: string;
  subject: string;
  now?: number;
}): AccountRecoveryRequest {
  const record = store.accountRecovery(input.requestId);
  if (!record) throw new AccountRecoveryError("Recovery request not found", 404);
  if (record.requestingSubject !== input.subject) throw new AccountRecoveryError("Recovery request does not belong to this sign-in", 403);
  if (record.cancelledAt || record.completedAt || !record.executeAfter) {
    throw new AccountRecoveryError("Recovery request is not ready", 409);
  }
  const now = input.now ?? Date.now();
  if (Date.parse(record.executeAfter) > now) throw new AccountRecoveryError("Recovery safety delay is still active", 409);
  if (!store.attachSignInId(record.targetAccountId, record.requestingSubject)) {
    throw new AccountRecoveryError("Recovery target no longer exists", 404);
  }
  record.completedAt = new Date(now).toISOString();
  return store.saveAccountRecovery(record);
}
