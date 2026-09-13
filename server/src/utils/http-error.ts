import { config } from "../config.js";

/**
 * Message safe to return to a client.
 *
 * Handlers used to return `e.message` straight from the catch block, which
 * forwarded Circle SDK, viem/RPC and MongoDB internals — endpoint URLs, key
 * ids, driver stack text — to whoever made the request. The real error is
 * always logged; the caller only sees it outside production, where the extra
 * detail is worth more than the disclosure.
 */
export function clientError(e: unknown, fallback: string): string {
  console.error(`[error] ${fallback}:`, e);
  if (config.nodeEnv === "production") return fallback;
  return e instanceof Error ? e.message : fallback;
}
