import jwt from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import { config } from "../config.js";

export type DynamicClaims = {
  sub: string;
  email?: string;
  environment_id?: string;
  scope?: string;
  iss?: string;
};

const clients = new Map<string, JwksClient>();

function jwks(envId: string) {
  let c = clients.get(envId);
  if (!c) {
    c = new JwksClient({
      jwksUri: `https://app.dynamicauth.com/api/v0/sdk/${envId}/.well-known/jwks`,
      cache: true,
      rateLimit: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000,
    });
    clients.set(envId, c);
  }
  return c;
}

export async function verifyDynamicToken(
  token: string | undefined | null,
): Promise<DynamicClaims | null> {
  if (!token?.trim() || !config.dynamic.environmentId) return null;
  const raw = token.replace(/^Bearer\s+/i, "").trim();
  if (raw.split(".").length < 3) return null;
  try {
    const decoded = jwt.decode(raw, { complete: true });
    if (!decoded || typeof decoded === "string") return null;
    const kid =
      typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
    const key = kid
      ? await jwks(config.dynamic.environmentId).getSigningKey(kid)
      : await jwks(config.dynamic.environmentId).getSigningKey();
    const claims = jwt.verify(raw, key.getPublicKey(), {
      algorithms: ["RS256"],
    }) as DynamicClaims;
    const scopes = (claims.scope || "").split(/\s+/).filter(Boolean);
    if (scopes.length && !scopes.includes("user:basic")) return null;
    if (
      claims.environment_id &&
      claims.environment_id !== config.dynamic.environmentId
    ) {
      return null;
    }
    return claims;
  } catch (e) {
    console.warn(
      "dynamic jwt:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// Identity resolution lives in middleware/auth.ts. A helper that silently
// fell back to the `x-user-id` header used to live here; it made
// "unauthenticated" indistinguishable from "authenticated as anyone", so the
// fallback is now an explicit, config-gated branch in the middleware.
