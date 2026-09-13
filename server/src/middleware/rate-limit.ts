/**
 * Fixed-window rate limiting.
 *
 * The API had no throttle of any kind, so a single caller could hammer the
 * SMTP sender, the Circle user/challenge endpoints, the on-chain identity
 * writer or the x402 payer as fast as the network allowed. Each of those
 * spends a real resource — email quota, Circle API quota, gas, USDC.
 *
 * State is per-process and in-memory: this server runs as a single instance
 * with a JSON/Mongo store and no shared cache, so a counter here is honest
 * about its scope. Behind more than one instance, move this to Redis —
 * per-process windows would otherwise multiply the effective limit.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

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
