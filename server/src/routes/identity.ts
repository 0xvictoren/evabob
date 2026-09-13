import { Hono } from "hono";
import { z } from "zod";
import {
  adminLinkIdentity,
  normalizeIdentifier,
  resolveIdentity,
  type IdentityKind,
} from "../services/identity.js";
import { getAuth, requireVerified } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";
import { store } from "../store/db.js";

export const identityRoutes = new Hono();

/**
 * Payees are an email, a handle, or a raw 0x address. Phone was dropped as an
 * identity type; `IdType.Phone` stays reserved on-chain (see the note in
 * abis/identity.ts) but nothing may link one.
 */
const linkableKindSchema = z.enum(["email", "handle"]);

/** Resolution still accepts phone so an old link can be read, never written. */
const kindSchema = z.enum(["phone", "email", "handle"]);

identityRoutes.get("/resolve", async (c) => {
  const kind = kindSchema.parse(c.req.query("kind") || "handle");
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required" }, 400);
  try {
    const result = await resolveIdentity(kind as IdentityKind, id);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "resolve failed") },
      400,
    );
  }
});

/**
 * Confirms the authenticated caller actually owns `identifier`.
 *
 * `adminLink` writes to the registry with the server's admin key, and
 * `resolvePayee` routes real money using that registry, so an unowned link
 * is a payment-interception primitive. Ownership must come from data the
 * user could not choose for themselves:
 *   - email  : the verified Dynamic JWT claim
 *   - handle : the handle the store already assigned to this account
 */
function assertOwnership(
  kind: "email" | "handle",
  identifier: string,
  user: { email: string; handle?: string },
  jwtEmail: string | undefined,
): string | null {
  const want = normalizeIdentifier(kind, identifier);

  if (kind === "email") {
    const owned = [jwtEmail]
      .filter(Boolean)
      .map((e) => normalizeIdentifier("email", e as string));
    if (!owned.includes(want)) {
      return "That email is not the one on this session.";
    }
    return null;
  }

  if (!user.handle) return "Set a handle on your profile first.";
  if (normalizeIdentifier("handle", user.handle) !== want) {
    return "That handle does not belong to this account.";
  }
  return null;
}

identityRoutes.post("/link", async (c) => {
  // Writes on-chain with the registry admin key — never on a dev fallback id.
  const denied = requireVerified(c);
  if (denied) return denied;

  const body = z
    .object({
      kind: linkableKindSchema.default("handle"),
      identifier: z.string().min(1),
    })
    .parse(await c.req.json());

  const { userId, email: jwtEmail } = getAuth(c);
  const user = store.getUser(userId);
  if (!user) {
    return c.json({ error: "No account yet. Sign in first." }, 409);
  }

  // The account is always the caller's own wallet. A client-supplied
  // address would let anyone point an identifier at a wallet they control.
  const account = user.evmAddress;
  if (!account || !/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return c.json(
      { error: "Finish wallet setup before linking an identity." },
      409,
    );
  }

  const ownershipError = assertOwnership(
    body.kind,
    body.identifier,
    user,
    jwtEmail,
  );
  if (ownershipError) return c.json({ error: ownershipError }, 403);

  try {
    const result = await adminLinkIdentity({
      account: account as `0x${string}`,
      kind: body.kind,
      identifier: body.identifier,
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("identity link failed:", e);
    return c.json({ error: "Could not link that identity." }, 400);
  }
});
