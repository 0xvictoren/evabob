/**
 * Exchange rates for showing and typing amounts in a person's own currency.
 *
 * Money always moves as dollars (USDC). A rate only decides how a dollar
 * amount is shown and how a typed amount becomes dollars, so a slightly old
 * rate is harmless and a missing one must never block a payment.
 *
 * Rates come from a public feed that publishes once a day. They are kept in
 * memory for an hour; if the feed cannot be reached the last good rates are
 * used, and before any have ever been fetched, the fallback table below.
 */

export type Currency = { code: string; name: string; symbol: string };

/** The currencies a person can choose as their own. USD first: it is the money itself. */
export const CURRENCIES: readonly Currency[] = [
  { code: "NGN", name: "Nigerian naira", symbol: "₦" },
  { code: "USD", name: "US dollar", symbol: "$" },
  { code: "GHS", name: "Ghanaian cedi", symbol: "GH₵" },
  { code: "KES", name: "Kenyan shilling", symbol: "KSh" },
  { code: "ZAR", name: "South African rand", symbol: "R" },
  { code: "XOF", name: "West African CFA franc", symbol: "CFA" },
  { code: "XAF", name: "Central African CFA franc", symbol: "FCFA" },
  { code: "UGX", name: "Ugandan shilling", symbol: "USh" },
  { code: "TZS", name: "Tanzanian shilling", symbol: "TSh" },
  { code: "RWF", name: "Rwandan franc", symbol: "FRw" },
  { code: "EGP", name: "Egyptian pound", symbol: "E£" },
  { code: "GBP", name: "British pound", symbol: "£" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "CAD", name: "Canadian dollar", symbol: "CA$" },
  { code: "AED", name: "UAE dirham", symbol: "AED" },
  { code: "INR", name: "Indian rupee", symbol: "₹" },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as [string, ...string[]];

export function currencyOf(code: string | undefined): Currency | undefined {
  const wanted = (code ?? "").trim().toUpperCase();
  return CURRENCIES.find((c) => c.code === wanted);
}

export type FxRates = {
  base: "USD";
  /** Units of each currency for one dollar. */
  rates: Record<string, number>;
  /** Kept for older app builds that read these two by name. */
  ngn: number;
  eur: number;
  /** "live" from the feed; "fallback" when it has never been reached. */
  source: "live" | "fallback";
  updatedAt: string;
};

/**
 * Used only until the feed answers for the first time. Rough on purpose: it
 * is better to show an approximate amount than none.
 */
const FALLBACK: Record<string, number> = {
  USD: 1, NGN: 1390, GHS: 12, KES: 129, ZAR: 17.5, XOF: 565, XAF: 565, UGX: 3600,
  TZS: 2500, RWF: 1450, EGP: 48, GBP: 0.75, EUR: 0.87, CAD: 1.38, AED: 3.6725, INR: 88,
};

/**
 * Where rates come from. With EXCHANGERATE_API_KEY set, ExchangeRate-API's
 * keyed endpoint (the account on app.exchangerate-api.com); without it, the
 * same provider's open endpoint, which needs no key and updates once a day.
 * The key is part of the address, so the address is never logged.
 */
function feedUrl(): string {
  const override = process.env.FX_RATES_URL?.trim();
  if (override) return override;
  const key = process.env.EXCHANGERATE_API_KEY?.trim();
  return key && /^[A-Za-z0-9]{16,64}$/.test(key)
    ? `https://v6.exchangerate-api.com/v6/${key}/latest/USD`
    : "https://open.er-api.com/v6/latest/USD";
}

/** "exchangerate-api" with a key, "open" without: shown on the health page. */
export function fxProvider(): "exchangerate-api" | "open" | "custom" {
  if (process.env.FX_RATES_URL?.trim()) return "custom";
  return /^[A-Za-z0-9]{16,64}$/.test(process.env.EXCHANGERATE_API_KEY?.trim() ?? "") ? "exchangerate-api" : "open";
}
const FRESH_MS = 60 * 60 * 1000;
const FEED_TIMEOUT_MS = 6_000;

let current: FxRates = shape(FALLBACK, "fallback", new Date(0));
let fetchedAt = 0;
let inFlight: Promise<FxRates> | null = null;

function shape(all: Record<string, number>, source: FxRates["source"], at: Date): FxRates {
  const rates: Record<string, number> = { USD: 1, USDC: 1 };
  for (const c of CURRENCIES) {
    const v = c.code === "USD" ? 1 : Number(all[c.code]);
    // A rate that is missing or absurd keeps the last one we trusted.
    rates[c.code] = Number.isFinite(v) && v > 0 ? v : (current?.rates[c.code] ?? FALLBACK[c.code]!);
  }
  return { base: "USD", rates, ngn: rates.NGN!, eur: rates.EUR!, source, updatedAt: at.toISOString() };
}

/** Reads a feed answer into rates. Pure; null when it is not usable. */
export function parseFeed(body: unknown): { rates: Record<string, number>; at: Date } | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const rates = (o.rates ?? o.conversion_rates) as Record<string, unknown> | undefined;
  if (!rates || typeof rates !== "object") return null;
  const base = String(o.base_code ?? o.base ?? "USD").toUpperCase();
  if (base !== "USD") return null;
  const out: Record<string, number> = {};
  for (const [code, v] of Object.entries(rates)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[code.toUpperCase()] = n;
  }
  if (!out.NGN) return null;
  const unix = Number(o.time_last_update_unix);
  return { rates: out, at: Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000) : new Date() };
}

async function load(): Promise<FxRates> {
  try {
    const res = await fetch(feedUrl(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`rates feed answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    // The keyed endpoint answers 200 with result "error" for a bad or spent key.
    if (body?.result === "error") throw new Error(`rates feed refused: ${String(body["error-type"] ?? "error")}`);
    const parsed = parseFeed(body);
    if (!parsed) throw new Error("rates feed returned nothing usable");
    current = shape(parsed.rates, "live", parsed.at);
    fetchedAt = Date.now();
  } catch (error) {
    // Try again in five minutes rather than on every request.
    fetchedAt = Date.now() - FRESH_MS + 5 * 60 * 1000;
    console.warn("[fx] keeping the last rates:", error instanceof Error ? error.message : error);
  }
  return current;
}

export function fxConfigured(): boolean {
  return true;
}

/** The rates held right now, without waiting for anything. */
export function getCachedFx(): FxRates {
  return { ...current, rates: { ...current.rates } };
}

/** Fresh rates when the held ones are over an hour old; never throws. */
export async function fetchUsdRates(force = false): Promise<FxRates> {
  if (!force && Date.now() - fetchedAt < FRESH_MS) return getCachedFx();
  inFlight ??= load().finally(() => {
    inFlight = null;
  });
  await inFlight;
  return getCachedFx();
}

/** For tests. */
export function setFxForTests(rates: Record<string, number> | null) {
  current = shape(rates ?? FALLBACK, rates ? "live" : "fallback", new Date(rates ? Date.now() : 0));
  fetchedAt = rates ? Date.now() : 0;
}
