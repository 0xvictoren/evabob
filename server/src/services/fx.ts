/** Display FX rates. The product uses a fixed USD/USDC → NGN rate. */

export type FxRates = {
  base: "USD";
  /** 1 USDC treated as 1 USD for display */
  ngn: number;
  eur: number;
  source: "fixed";
  updatedAt: string;
};

export const FIXED_USD_TO_NGN = 1390;

const FIXED_RATES: FxRates = {
  base: "USD",
  ngn: FIXED_USD_TO_NGN,
  eur: 0.92,
  source: "fixed",
  updatedAt: new Date().toISOString(),
};

export function fxConfigured(): boolean {
  return true;
}

export function getCachedFx(): FxRates {
  return { ...FIXED_RATES };
}

/** Kept async so the public route remains backward compatible. */
export async function fetchUsdRates(_force = false): Promise<FxRates> {
  return getCachedFx();
}
