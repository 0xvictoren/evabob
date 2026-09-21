/**
 * Fixed-window rate limiting.
 *
 * The API had no throttle of any kind, so a single caller could hammer the
 * SMTP sender, the Circle user/challenge endpoints, the on-chain identity
 * writer or the x402 payer as fast as the network allowed. Each of those
 * spends a real resource — email quota, Circle API quota, gas, USDC.
 *
 * Mongo is the shared atomic store in hosted deployments. The in-memory path
 * exists only for local development when Mongo is intentionally unavailable.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { config } from "../config.js";
import { mongoConsumeRateLimit } from "../services/mongo.js";

type Bucket = { count: number; resetAt: number };

export type RateLimitRule = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Distinguishes this rule's buckets from every other rule's. */
  name: string;
};

const buckets = new Map<string, Bucket>();

export async function consumeNamedRateLimit(
  name: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const key = `${name}:${identity}`;
  const shared = await mongoConsumeRateLimit(key, limit, windowMs, now);
  if (shared) {
    return {
      allowed: shared.allowed,
      retryAfterSeconds: Math.max(1, Math.ceil((shared.resetAt - now) / 1000)),
    };
  }
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
    sweep(now);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Drops expired buckets so the map cannot grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 5_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Identifies the caller. Prefers the authenticated user so one user on a
 * shared NAT cannot exhaust the window for everyone behind it; falls back to
 * the peer address before auth has run or for anonymous routes.
 */
function callerKey(c: Context): string {
  const auth = c.get("auth") as { userId: string; verified: boolean } | undefined;
  if (auth?.verified) return `u:${auth.userId}`;
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded && isIP(forwarded)) return `ip:${forwarded}`;
  }
  try {
    const info = getConnInfo(c);
    return `ip:${info.remote.address || "unknown"}`;
  } catch {
    return "ip:unknown";
  }
}

export function rateLimit(rule: RateLimitRule): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const key = `${rule.name}:${callerKey(c)}`;
    const shared = await mongoConsumeRateLimit(
      key,
      rule.limit,
      rule.windowMs,
      now,
    );
    if (shared) {
      const remaining = Math.max(0, rule.limit - shared.count);
      const resetSeconds = Math.max(1, Math.ceil((shared.resetAt - now) / 1000));
      c.header("RateLimit-Limit", String(rule.limit));
      c.header("RateLimit-Remaining", String(remaining));
      c.header("RateLimit-Reset", String(resetSeconds));
      if (!shared.allowed) {
        c.header("Retry-After", String(resetSeconds));
        return c.json(
          { error: "rate_limited", detail: `Too many requests. Try again in ${resetSeconds}s.` },
          429,
        );
      }
      return next();
    }

    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      buckets.set(key, bucket);
      sweep(now);
    }

    bucket.count += 1;
    const remaining = Math.max(0, rule.limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    c.header("RateLimit-Limit", String(rule.limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > rule.limit) {
      c.header("Retry-After", String(resetSeconds));
      return c.json(
        {
          error: "rate_limited",
          detail: `Too many requests. Try again in ${resetSeconds}s.`,
        },
        429,
      );
    }

    return next();
  };
}

/** Broad ceiling for normal app traffic. */
export const GENERAL: RateLimitRule = {
  name: "general",
  limit: 300,
  windowMs: 60_000,
};

/**
 * Endpoints where each call costs money or an external quota. Deliberately
 * far below GENERAL — no legitimate client needs to burst these.
 */
export const SENSITIVE: RateLimitRule = {
  name: "sensitive",
  limit: 10,
  windowMs: 60_000,
};

/** Account/session creation, which provisions Circle-side resources. */
export const ONBOARDING: RateLimitRule = {
  name: "onboarding",
  limit: 20,
  windowMs: 60_000,
};

/** Test for the in-memory store; not part of the public contract. */
export function __resetRateLimitState(): void {
  buckets.clear();
}
