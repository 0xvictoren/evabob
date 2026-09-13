/**
 * Display FX rates (USD/USDC → NGN, EUR).
 * Uses ExchangeRate-API when EXCHANGE_RATE_API_KEY is set.
 * Docs: https://www.exchangerate-api.com/docs/standard-requests
 */

import { config } from "../config.js";

export type FxRates = {
  base: "USD";
  /** 1 USDC treated as 1 USD for display */
  ngn: number;
  eur: number;
  source: "exchangerate-api" | "cache" | "fallback";
  updatedAt: string;
};

const FALLBACK: FxRates = {
  base: "USD",
  ngn: 1628,
  eur: 0.92,
  source: "fallback",
  updatedAt: new Date(0).toISOString(),
};

let cache: FxRates = { ...FALLBACK };
let cacheAt = 0;
const CACHE_MS = 60_000;

export function fxConfigured(): boolean {
  return Boolean(config.exchangeRateApiKey?.trim());
}

export function getCachedFx(): FxRates {
  return cache;
}

/**
 * Fetch live USD rates. Caches ~60s. USDC display = USD.
 */
export async function fetchUsdRates(force = false): Promise<FxRates> {
  const now = Date.now();
  if (!force && cacheAt > 0 && now - cacheAt < CACHE_MS && cache.source !== "fallback") {
    return cache;
  }

  const key = config.exchangeRateApiKey?.trim();
  if (!key) {
    cache = {
      ...FALLBACK,
      source: cacheAt > 0 ? "cache" : "fallback",
      updatedAt: cache.updatedAt || new Date().toISOString(),
    };
    return cache;
  }

  try {
    const url = `https://v6.exchangerate-api.com/v6/${key}/latest/USD`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok || data.result === "error") {
      const err =
        (data["error-type"] as string) ||
        (data.error as string) ||
        `HTTP ${res.status}`;
      throw new Error(err);
    }

    // Standard endpoint uses conversion_rates; some plans use rates
    const rates =
      (data.conversion_rates as Record<string, number> | undefined) ||
      (data.rates as Record<string, number> | undefined);

    const ngn = Number(rates?.NGN);
    const eur = Number(rates?.EUR);
    if (!Number.isFinite(ngn) || ngn <= 0) {
      throw new Error("NGN rate missing from ExchangeRate-API response");
    }

    cache = {
      base: "USD",
      ngn,
      eur: Number.isFinite(eur) && eur > 0 ? eur : cache.eur || FALLBACK.eur,
      source: "exchangerate-api",
      updatedAt: new Date().toISOString(),
    };
    cacheAt = now;
    return cache;
  } catch (e) {
    // Keep last good cache if we have one
    if (cacheAt > 0 && cache.source === "exchangerate-api") {
      return { ...cache, source: "cache" };
    }
    cache = {
      ...FALLBACK,
      source: "fallback",
      updatedAt: new Date().toISOString(),
    };
    cacheAt = now;
    console.warn(
      "[fx]",
      e instanceof Error ? e.message : e,
      "— using fallback rates",
    );
    return cache;
  }
}
