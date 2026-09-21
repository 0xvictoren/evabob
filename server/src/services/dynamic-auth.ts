import jwt from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import { config } from "../config.js";

export type DynamicClaims = {
  sub: string;
  email?: string;
  environment_id: string;
  scope: string | string[];
  scopes?: string[];
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  verified_credentials: Array<Record<string, unknown>>;
};

const CLOCK_TOLERANCE_SECONDS = 30;

export function dynamicIssuer(environmentId: string): string {
  return `app.dynamic.xyz/${environmentId}`;
}

function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scopes(value: Record<string, unknown>): string[] {
  const singular = value.scope;
  const plural = value.scopes;
  return [
    ...(typeof singular === "string" ? singular.split(/\s+/) : []),
    ...(Array.isArray(singular) ? singular : []),
    ...(Array.isArray(plural) ? plural : []),
  ].filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Email ownership comes only from Dynamic's verified credential collection. */
export function verifiedEmailFromClaims(value: Record<string, unknown>): string | undefined {
  const credentials = value.verified_credentials;
  if (!Array.isArray(credentials)) return undefined;
  const wanted = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const emails = credentials
    .map((credential) =>
      credential && typeof credential === "object" && typeof credential.email === "string"
        ? credential.email.trim().toLowerCase()
        : "",
    )
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (wanted && emails.includes(wanted)) return wanted;
  return emails.length === 1 ? emails[0] : undefined;
}

/**
 * Validates the security-relevant claims after the RS256 signature has been
 * checked. Exported so malformed and wrong-token payloads are regression
 * tested without contacting Dynamic's JWKS endpoint.
 */
export function validateDynamicClaims(
  value: unknown,
  options: { environmentId: string; audience: string; nowSeconds?: number },
): DynamicClaims | null {
  if (!value || typeof value !== "object") return null;
  const claims = value as Record<string, unknown>;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.sub !== "string" || !claims.sub.trim()) return null;
  if (claims.iss !== dynamicIssuer(options.environmentId)) return null;
  if (claims.environment_id !== options.environmentId) return null;
  if (!audiences(claims.aud).includes(options.audience)) return null;
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return null;
  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  if (issuedAt > now + CLOCK_TOLERANCE_SECONDS || expiresAt <= now - CLOCK_TOLERANCE_SECONDS) {
    return null;
  }
  if (issuedAt >= expiresAt) return null;
  const granted = scopes(claims);
  if (!granted.includes("user:basic") || granted.includes("requiresAdditionalAuth")) {
    return null;
  }
  if (!Array.isArray(claims.verified_credentials)) return null;
  return {
    ...(claims as DynamicClaims),
    email: verifiedEmailFromClaims(claims),
  };
}

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
  return (await checkDynamicToken(token)).claims;
}

/** Expired tokens already logged, so one stale phone does not flood the log. */
const loggedExpired = new Set<string>();

/**
 * Verifies a Dynamic sign-in token and says why it failed, so an expired
 * sign-in can be told apart from a bad one: the app asks the person to sign
 * in again instead of retrying a token that can never work.
 */
export async function checkDynamicToken(
  token: string | undefined | null,
): Promise<{ claims: DynamicClaims | null; expired: boolean }> {
  const claims = await verifyInner(token);
  if (claims === "expired") return { claims: null, expired: true };
  return { claims, expired: false };
}

async function verifyInner(
  token: string | undefined | null,
): Promise<DynamicClaims | null | "expired"> {
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
    const verified = jwt.verify(raw, key.getPublicKey(), {
      algorithms: ["RS256"],
      issuer: dynamicIssuer(config.dynamic.environmentId),
      audience: config.dynamic.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    const claims = validateDynamicClaims(verified, {
      environmentId: config.dynamic.environmentId,
      audience: config.dynamic.audience,
    });
    if (!claims) return null;
    if (config.dynamic.sessionInvalidBefore) {
      const cutoffMs = Date.parse(config.dynamic.sessionInvalidBefore);
      if (!Number.isFinite(cutoffMs)) {
        throw new Error("AUTH_SESSION_INVALID_BEFORE must be an ISO-8601 timestamp");
      }
      if (!Number.isFinite(claims.iat) || claims.iat! * 1000 < cutoffMs) {
        return "expired";
      }
    }
    return claims;
  } catch (e) {
    if (e instanceof Error && e.name === "TokenExpiredError") {
      const tail = raw.slice(-24);
      if (!loggedExpired.has(tail)) {
        if (loggedExpired.size > 500) loggedExpired.clear();
        loggedExpired.add(tail);
        console.info("dynamic jwt: a sign-in expired; the app will ask to sign in again");
      }
      return "expired";
    }
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
