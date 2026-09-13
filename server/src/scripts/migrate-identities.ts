/**
 * Idempotently link every locally stored wallet owner into the configured
 * IdentityRegistry. This is intended for registry replacement, not routine
 * sign-in (the session route already links one returning user).
 *
 * It never unlinks or overwrites an active identifier. Conflicts fail closed
 * and need an explicit ownership review before adminUnlink is considered.
 */
import type { Address } from "viem";
import { store } from "../store/db.js";
import {
  adminLinkIdentity,
  computeIdentityKey,
  IdentityConflictError,
  normalizeIdentifier,
  type IdentityKind,
} from "../services/identity.js";

type Candidate = {
  kind: Extract<IdentityKind, "email" | "handle">;
  identifier: string;
  account: Address;
  key: string;
  chainEvidence: number;
};

function candidates(): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const user of store.listUsers()) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(user.evmAddress || "")) continue;
    const account = user.evmAddress as Address;
    const chainEvidence = store
      .listActivity(user.id, Number.MAX_SAFE_INTEGER)
      .filter((activity) => activity.settlementVerified || activity.txHash)
      .length;
    const identities: Array<[Candidate["kind"], string | undefined]> = [
      ["email", user.email],
      ["handle", user.handle],
    ];
    for (const [kind, raw] of identities) {
      if (!raw) continue;
      const identifier = normalizeIdentifier(kind, raw);
      if (kind === "email" && !identifier.includes("@")) continue;
      if (kind === "handle" && identifier.length < 3) continue;
      const key = computeIdentityKey(kind, identifier).toLowerCase();
      const previous = byKey.get(key);
      if (previous && previous.account.toLowerCase() !== account.toLowerCase()) {
        // Duplicate auth rows exist in the testnet store. A wallet with real
        // transaction evidence is the only safe automatic winner over a row
        // that has never touched the chain. Ties still require manual review.
        if (previous.chainEvidence > 0 && chainEvidence === 0) continue;
        if (chainEvidence > 0 && previous.chainEvidence === 0) {
          byKey.set(key, { kind, identifier, account, key, chainEvidence });
          continue;
        }
        throw new Error(
          `Stored ${kind} ownership conflict for identity key ${key}; migration stopped before writing.`,
        );
      }
      if (!previous || chainEvidence > previous.chainEvidence) {
        byKey.set(key, { kind, identifier, account, key, chainEvidence });
      }
    }
  }
  return [...byKey.values()];
}

export async function migrateStoredIdentities(): Promise<{
  candidates: number;
  linked: number;
  alreadyCurrent: number;
  conflicts: number;
}> {
  const rows = candidates();
  let linked = 0;
  let alreadyCurrent = 0;
  let conflicts = 0;
  for (const row of rows) {
    try {
      const result = await adminLinkIdentity({
        account: row.account,
        kind: row.kind,
        identifier: row.identifier,
      });
      if (result.status === "linked") linked += 1;
      else alreadyCurrent += 1;
      console.log(`[identity-migration] ${row.kind} ${row.key} ${result.status}`);
    } catch (error) {
      if (error instanceof IdentityConflictError) {
        conflicts += 1;
        console.error(
          `[identity-migration] ${row.kind} ${row.key} conflicts with an active link`,
        );
        continue;
      }
      throw error;
    }
  }
  return { candidates: rows.length, linked, alreadyCurrent, conflicts };
}

const result = await migrateStoredIdentities();
console.log(`[identity-migration] complete ${JSON.stringify(result)}`);
if (result.conflicts > 0) process.exitCode = 1;
