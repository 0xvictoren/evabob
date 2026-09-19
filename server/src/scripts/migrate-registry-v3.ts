/**
 * Copies every identity the V2 registry resolves into IdentityRegistryV3.
 *
 * V3 only appends the Agent type, so each existing key is the same hash in
 * both. The chain, not the local store, is the authority on who owns what:
 * each handle and email the store knows of is resolved in V2, and linked in
 * V3 to exactly the account V2 names. Nothing V2 does not have is created,
 * and store rows that disagree with each other (duplicate test accounts)
 * cannot change the outcome.
 *
 * Idempotent: identities already current in V3 are skipped without a
 * transaction. Run with IDENTITY_REGISTRY=V3 and ESCROW_IDENTITY_REGISTRY=V2.
 */
import type { Address } from "viem";
import { store } from "../store/db.js";
import {
  adminLinkIdentity,
  escrowRegistryAddress,
  IdentityConflictError,
  normalizeIdentifier,
  registryAddress,
  resolveIdentity,
  type IdentityKind,
} from "../services/identity.js";

const v2 = escrowRegistryAddress();
if (!v2) throw new Error("Set ESCROW_IDENTITY_REGISTRY to the V2 registry first.");
console.log(`[registry-v3] copying ${v2} → ${registryAddress()}`);

const seen = new Set<string>();
const candidates: Array<{ kind: Extract<IdentityKind, "email" | "handle">; identifier: string }> = [];
for (const user of store.listUsers()) {
  for (const [kind, raw] of [["email", user.email], ["handle", user.handle]] as const) {
    if (!raw) continue;
    const identifier = normalizeIdentifier(kind, raw);
    if (kind === "email" && !identifier.includes("@")) continue;
    if (kind === "handle" && identifier.length < 3) continue;
    const key = `${kind}:${identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ kind, identifier });
  }
}

let linked = 0;
let current = 0;
let absent = 0;
let conflicts = 0;
for (const c of candidates) {
  const old = await resolveIdentity(c.kind, c.identifier, v2);
  if (!old.active) {
    absent += 1;
    continue;
  }
  try {
    const out = await adminLinkIdentity({ account: old.account as Address, kind: c.kind, identifier: c.identifier });
    if (out.status === "linked") linked += 1;
    else current += 1;
    console.log(`[registry-v3] ${c.kind} ${out.key} ${out.status}`);
  } catch (e) {
    if (e instanceof IdentityConflictError) {
      conflicts += 1;
      console.error(`[registry-v3] ${c.kind} ${e.normalized} conflicts in V3`);
      continue;
    }
    throw e;
  }
}
console.log(`[registry-v3] done ${JSON.stringify({ candidates: candidates.length, linked, current, notInV2: absent, conflicts })}`);
if (conflicts > 0) process.exitCode = 1;
