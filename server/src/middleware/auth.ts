/**
 * Application authentication.
 *
 * Every /v1 route derives the caller's identity from a Dynamic-issued JWT,
 * verified against Dynamic's JWKS. The `x-user-id` header is NOT an identity
 * claim -- it is attacker-controlled and is only honoured when
 * ALLOW_HEADER_AUTH=true, which exists for local development and demo builds.
 *
 * Route handlers must read the caller via `getUserId(c)` / `getAuth(c)` and
 * must never read `x-user-id` directly.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { config } from "../config.js";
import {
  verifyDynamicToken,
  type DynamicClaims,
} from "../services/dynamic-auth.js";

export type AuthState = {
  userId: string;
  email?: string;
  claims: DynamicClaims | null;
  /** true when the id came from a verified JWT, false for the dev fallback. */
  verified: boolean;
  /**
   * Which credential proved this request.
   *  - "user"  : a Dynamic session token, from the app
   *  - "agent" : an agent wallet API key, from a third-party agent
   *  - "none"  : a public route, or the dev header fallback
   */
  principal: "user" | "agent" | "none";
  /** Set only for principal === "agent". */
  agentId?: string;
};

export type AuthVariables = { auth: AuthState };

// Makes `c.get("auth")` / `c.set("auth", …)` typed on every Hono context.
declare module "hono" {
  interface ContextVariableMap {
    auth: AuthState;
  }
}

/**
 * Paths served before a user has a session. Matched against the full request
 * path. Everything else under /v1 requires a verified token.
 */
const PUBLIC_PATHS = new Set([
  "/v1/health",
  "/v1/config/public",
  "/v1/fx/rates",
]);

const PUBLIC_PREFIXES = [
  "/v1/public/payment-requests/",
  "/v1/public/claims/",
  "/v1/public/receipts/",
  "/v1/public/hold-links/",
  "/v1/public/groups/",
] as const;

/**
 * Routes a third-party agent calls with its wallet API key instead of a user
 * session. The whole point of an agent wallet is that the user hands this key
 * to software they do not control, so these paths must accept `sk_evabob_…`
 * as a first-class credential — requiring a Dynamic JWT here would make the
 * feature unusable by the only caller it exists for.
 */
const AGENT_KEY_PATHS = new Set(["/v1/x402/pay"]);

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function looksLikeAgentKey(token: string): boolean {
  return token.startsWith("sk_evabob_") || token.startsWith("sk_sendit_");
}

function bearer(c: Context): string | undefined {
  return c.req.header("authorization") || c.req.header("x-dynamic-token");
}

/**
 * Resolves the caller and rejects unauthenticated access to protected routes.
 * Mount once on /v1/* before the route groups.
 *
 * `allowHeaderFallback` is a parameter rather than a direct config read so
 * the permissive branch can be exercised in tests without reloading modules.
 */
export function createAuthMiddleware(
  opts: { allowHeaderFallback?: boolean } = {},
): MiddlewareHandler {
  const allowHeaderFallback =
    opts.allowHeaderFallback ?? config.auth.allowHeaderFallback;

  return async (c: Context, next: Next) => {
    const raw = (bearer(c) || "").replace(/^Bearer\s+/i, "").trim();

    // Agent wallet key. Checked before the JWT path because these tokens are
    // not JWTs and would otherwise fall straight through to a 401.
    if (AGENT_KEY_PATHS.has(c.req.path) && looksLikeAgentKey(raw)) {
      const { findAgentByApiKey } = await import("../services/x402Pay.js");
      const agent = findAgentByApiKey(raw);
      if (!agent) {
        return c.json(
          { error: "unauthorized", detail: "Unknown or revoked agent API key." },
          401,
        );
      }
      if (agent.revokedAt) {
        return c.json(
          {
            error: "unauthorized",
            detail: "This agent API key has been revoked.",
            code: "AGENT_KEY_REVOKED",
          },
          401,
        );
      }
      c.set("auth", {
        // Spending is attributed to the owning user, not the key itself.
        userId: agent.userId,
        claims: null,
        verified: true,
        principal: "agent",
        agentId: agent.id,
      } satisfies AuthState);
      return next();
    }

    const claims = await verifyDynamicToken(raw);

    if (claims?.sub) {
      c.set("auth", {
        userId: claims.sub,
        email: claims.email,
        claims,
        verified: true,
        principal: "user",
      } satisfies AuthState);
      return next();
    }

    if (isPublic(c.req.path)) {
      c.set("auth", {
        userId: "anonymous",
        claims: null,
        verified: false,
        principal: "none",
      } satisfies AuthState);
      return next();
    }

    if (allowHeaderFallback) {
      c.set("auth", {
        userId: c.req.header("x-user-id") || "dev-user",
        claims: null,
        verified: false,
        principal: "none",
      } satisfies AuthState);
      return next();
    }

    return c.json(
      {
        error: "unauthorized",
        detail:
          "A valid Dynamic session token is required. Send it as " +
          "`Authorization: Bearer <jwt>`.",
      },
      401,
    );
  };
}

/** The middleware mounted by the server, configured from env. */
export const authMiddleware: MiddlewareHandler = createAuthMiddleware();

/** The authenticated caller. Only valid downstream of `authMiddleware`. */
export function getAuth(c: Context): AuthState {
  const auth = c.get("auth") as AuthState | undefined;
  if (auth) return auth;
  // A route mounted outside the middleware would silently fall back to a
  // shared identity, so fail loudly instead.
  throw new Error("getAuth() called on a route without authMiddleware");
}

/** The authenticated caller's user id. */
export function getUserId(c: Context): string {
  return getAuth(c).userId;
}

/**
 * True when the caller proved identity with a real JWT. Use to gate actions
 * that spend money or write on-chain even if the dev fallback is enabled.
 */
export function isVerified(c: Context): boolean {
  return getAuth(c).verified;
}

/**
 * Rejects a request that did not present a verified JWT, regardless of the
 * dev fallback. Use on routes that move funds or write to the chain.
 */
export function requireVerified(c: Context): Response | null {
  if (isVerified(c)) return null;
  return c.json(
    {
      error: "unauthorized",
      detail:
        "This action requires a verified session. The x-user-id development " +
        "fallback is not accepted here.",
    },
    401,
  );
}
