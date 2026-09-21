import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { store } from "../store/db.js";
import {
  AccountRecoveryError,
  RECOVERY_COOLING_OFF_MS,
  cancelAccountRecovery,
  completeAccountRecovery,
  confirmAccountRecovery,
} from "./account-recovery.js";

function request(code = "123456") {
  const id = randomUUID();
  const subject = `recovery-subject-${id}`;
  const target = `recovery-target-${id}`;
  const now = Date.now();
  store.upsertUser({ id: target, email: `${id}@example.com` });
  store.saveAccountRecovery({
    id,
    requestingSubject: subject,
    targetAccountId: target,
    email: `${id}@example.com`,
    codeHash: createHash("sha256").update(`${id}:${code}`).digest("hex"),
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    codeExpiresAt: new Date(now + 15 * 60_000).toISOString(),
  });
  return { id, subject, target, now, code };
}

describe("explicit account recovery", () => {
  it("requires email proof and a cooling-off period before linking", () => {
    const row = request();
    assert.throws(
      () => confirmAccountRecovery({ requestId: row.id, subject: row.subject, code: "000000", now: row.now }),
      (error) => error instanceof AccountRecoveryError && error.status === 403,
    );
    const confirmed = confirmAccountRecovery({
      requestId: row.id,
      subject: row.subject,
      code: row.code,
      now: row.now,
    });
    assert.equal(confirmed.executeAfter, new Date(row.now + RECOVERY_COOLING_OFF_MS).toISOString());
    assert.throws(
      () => completeAccountRecovery({ requestId: row.id, subject: row.subject, now: row.now }),
      (error) => error instanceof AccountRecoveryError && error.status === 409,
    );
    completeAccountRecovery({
      requestId: row.id,
      subject: row.subject,
      now: row.now + RECOVERY_COOLING_OFF_MS,
    });
    assert.equal(store.accountIdForSignIn(row.subject, undefined), row.target);
  });

  it("lets the existing account revoke a pending recovery", () => {
    const row = request();
    const cancelled = cancelAccountRecovery({
      requestId: row.id,
      userId: row.target,
      now: row.now,
    });
    assert.ok(cancelled.cancelledAt);
    assert.throws(
      () => confirmAccountRecovery({ requestId: row.id, subject: row.subject, code: row.code }),
      (error) => error instanceof AccountRecoveryError && error.status === 409,
    );
  });
});
