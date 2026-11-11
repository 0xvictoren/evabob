/**
 * Circle Agent Marketplace (x402 discovery) client.
 * Catalog: https://agents.circle.com/services
 * API: https://api.circle.com/v2/x402/discovery/resources
 *
 * What an Evabob agent wallet can pay for is narrower than the catalog. The
 * payer (nanopay.ts) signs Circle Gateway batched authorizations on the
 * agent's own network. A seller is payable only if it offers exactly that.
 * In November 2026 the catalog held 2,650 endpoints; 134 offers were on Arc
 * Testnet (QuickNode's RPCs, which are POST, and BotPay).
 *
 * The catalog is never fetched while a payment waits: it is 27 pages, and a
 * payment only needs it to name and categorise a seller. Lookups read the
 * last copy and refresh it in the background.
 *
 * The allowlist (AGENT_RESOURCE_ORIGINS) may name exact origins, and may
 * include the token `circle-marketplace` to add every origin in the catalog
 * that the payer can settle with. The per-call, per-agent and per-user caps
 * apply either way, and every request still goes through safe-agent-http's
 * public-IP pinning and redirect refusal.
 */

import { config } from "../config.js";

/** The allowlist token that adds Circle's payable catalog origins. */
export const MARKETPLACE_ORIGINS_TOKEN = "circle-marketplace";

export type DiscoveryEndpoint = {
  resource: string;
  method: string;
  description: string;
  provider: string;
  category?: string;
  maxAmountUsdc: number;
  network?: string;
  supportsCircleGateway?: boolean;
};

/** A catalog endpoint an Evabob agent wallet can actually pay. */
export type PayableService = {
  resource: string;
  origin: string;
  provider: string;
  description: string;
  category: string;
  priceUsdc: number;
  network: string;
  /** How the seller is called. */
  method: string;
};

type CatalogItem = Record<string, unknown>;

function headers(): Record<string, string> {
  // The catalog sits behind a bot filter that refuses clients without a
  // User-Agent it recognises.
  const h: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "evabob-api/1.0 (+https://evabob.app)",
  };
  if (config.circle.apiKey) {
    h.Authorization = `Bearer ${config.circle.apiKey}`;
  }
  return h;
}

function atomicToUsdc(amount: string | number | undefined): number {
  if (amount == null) return 0;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  // USDC 6 decimals
  return n / 1_000_000;
}

function titleCase(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The CAIP-2 id of the network agent wallets pay on. */
export function agentPaymentNetwork(): string {
  return `eip155:${config.arc.chainId}`;
}

/**
 * Catalog entries the payer can settle: the `exact` scheme with Gateway
 * batching, on `network`, by a method the payer can send. Pure, so the rule
 * can be tested against a saved catalog. One entry per resource, cheapest
 * matching offer.
 */
export function payableFromCatalog(
  items: CatalogItem[],
  network: string,
): PayableService[] {
  const out = new Map<string, PayableService>();
  for (const item of items) {
    const resource = String(item.resource || "");
    let url: URL;
    try {
      url = new URL(resource);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const meta = (item.metadata as Record<string, unknown>) || {};
    const method = String(meta.method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
    const accepts = Array.isArray(item.accepts)
      ? (item.accepts as Array<Record<string, unknown>>)
      : [];
    const offers = accepts.filter((a) => {
      const extra = (a.extra as Record<string, unknown>) || {};
      return (
        a.network === network &&
        a.scheme === "exact" &&
        extra.name === "GatewayWalletBatched"
      );
    });
    if (offers.length === 0) continue;
    const price = Math.min(...offers.map((a) => atomicToUsdc(a.amount as string)));
    const provider = (meta.provider as Record<string, unknown>) || {};
    const existing = out.get(resource);
    // The same resource can be listed more than once, with different prices
    // and differently complete descriptions. Keep the lowest price and the
    // most complete description rather than whichever row came last.
    out.set(resource, {
      resource,
      origin: url.origin,
      provider: String(provider.name || existing?.provider || url.hostname),
      description: String(
        meta.description || provider.description || existing?.description || "",
      ),
      category: provider.category
        ? titleCase(String(provider.category))
        : existing?.category ?? "General",
      priceUsdc: existing ? Math.min(existing.priceUsdc, price) : price,
      network,
      method,
    });
  }
  return [...out.values()];
}

let catalogCache: { atMs: number; items: CatalogItem[] } | null = null;
const CATALOG_TTL_MS = 60 * 60 * 1000;

const CATALOG_PAGE = 100;
const CATALOG_PARALLEL = 6;
const CATALOG_MAX_ITEMS = 10_000;
let catalogRefresh: Promise<CatalogItem[]> | null = null;

async function catalogPage(offset: number): Promise<CatalogItem[]> {
  const res = await fetch(
    `https://api.circle.com/v2/x402/discovery/resources?limit=${CATALOG_PAGE}&offset=${offset}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const body = (await res.json()) as { items?: CatalogItem[] };
  return body.items ?? [];
}

/** Downloads every page, several at a time. One download runs at once. */
function refreshCatalog(): Promise<CatalogItem[]> {
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = (async () => {
    const items: CatalogItem[] = [];
    for (let offset = 0; offset < CATALOG_MAX_ITEMS; offset += CATALOG_PAGE * CATALOG_PARALLEL) {
      const pages = await Promise.all(
        Array.from({ length: CATALOG_PARALLEL }, (_, i) => catalogPage(offset + i * CATALOG_PAGE)),
      );
      for (const page of pages) items.push(...page);
      if (pages.some((page) => page.length < CATALOG_PAGE)) break;
    }
    catalogCache = { atMs: Date.now(), items };
    payableCache = null;
    return items;
  })().finally(() => {
    catalogRefresh = null;
  });
  return catalogRefresh;
}

/**
 * The whole public catalog. A copy under an hour old is returned as is; an
 * older one is returned at once and refreshed behind it; only the very first
 * call waits for the download.
 */
export async function fetchCatalog(): Promise<CatalogItem[]> {
  if (catalogCache) {
    if (Date.now() - catalogCache.atMs >= CATALOG_TTL_MS) {
      void refreshCatalog().catch((e) =>
        console.warn("[x402] catalog refresh failed:", e instanceof Error ? e.message : e));
    }
    return catalogCache.items;
  }
  return refreshCatalog();
}

let payableCache: PayableService[] | null = null;

/** Services an Evabob agent wallet can pay for on this deployment's network. */
export async function payableServices(): Promise<PayableService[]> {
  const items = await fetchCatalog();
  payableCache ??= payableFromCatalog(items, agentPaymentNetwork());
  return payableCache;
}

/**
 * The same list without ever waiting on Circle: what is known right now,
 * empty until the first download lands. For the payment path, where the
 * catalog only names and categorises a seller and must not hold a payment up.
 */
export function payableServicesNow(): PayableService[] {
  if (!catalogCache) {
    void refreshCatalog().catch(() => undefined);
    return [];
  }
  if (Date.now() - catalogCache.atMs >= CATALOG_TTL_MS) {
    void refreshCatalog().catch(() => undefined);
  }
  payableCache ??= payableFromCatalog(catalogCache.items, agentPaymentNetwork());
  return payableCache;
}

/** Starts the first download at boot, so the first payment finds it ready. */
export function warmCatalog(): void {
  void refreshCatalog().catch((e) =>
    console.warn("[x402] catalog warm-up failed:", e instanceof Error ? e.message : e));
}

/**
 * The origins agents may pay: the exact origins configured, plus — when the
 * allowlist includes `circle-marketplace` — every origin in Circle's catalog
 * that the payer can settle with. A catalog outage falls back to the explicit
 * origins only, which fails closed.
 */
export async function resolvedAgentOrigins(): Promise<string[]> {
  // Nothing configured means the curated marketplace, not nothing at all: an
  // empty list is one nobody fills in (services/agentMarketplace.ts).
  const configured = config.agents.resourceOrigins.length > 0
    ? config.agents.resourceOrigins
    : [MARKETPLACE_ORIGINS_TOKEN];
  const explicit = configured.filter((o) => o !== MARKETPLACE_ORIGINS_TOKEN);
  if (!configured.includes(MARKETPLACE_ORIGINS_TOKEN)) return explicit;
  try {
    const fromCatalog = (await payableServices()).map((s) => s.origin);
    return [...new Set([...explicit, ...fromCatalog])];
  } catch (e) {
    console.warn(
      "[x402] catalog unavailable; using explicit origins only:",
      e instanceof Error ? e.message : e,
    );
    return explicit;
  }
}

function mapItem(item: CatalogItem): DiscoveryEndpoint | null {
  const resource = String(item.resource || "");
  if (!resource) return null;
  const meta = (item.metadata as Record<string, unknown>) || {};
  const provider = (meta.provider as Record<string, unknown>) || {};
  const accepts = (item.accepts as Array<Record<string, unknown>>) || [];
  const first = accepts[0] || {};
  const amountRaw =
    first.maxAmountRequired ?? first.amount ?? first.maxAmount ?? "0";
  return {
    resource,
    method: String(meta.method || first.method || "GET"),
    description: String(
      meta.description || first.description || provider.description || resource,
    ),
    provider: String(provider.name || "unknown"),
    category: provider.category ? String(provider.category) : undefined,
    maxAmountUsdc: atomicToUsdc(amountRaw as string | number),
    network: first.network ? String(first.network) : undefined,
    supportsCircleGateway: Boolean(meta.supportsCircleGateway),
  };
}

/** Live search of Circle x402 discovery (public catalog; API key optional). */
export async function discoverResources(
  query: string,
  limit = 5,
): Promise<DiscoveryEndpoint[]> {
  const url = new URL("https://api.circle.com/v2/x402/discovery/resources");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: CatalogItem[] };
    return (body.items || [])
      .map((it) => mapItem(it))
      .filter((x): x is DiscoveryEndpoint => x != null);
  } catch (e) {
    console.warn("x402 discovery failed:", e);
    return [];
  }
}

export async function circleMarketplaceHealth(): Promise<{
  ok: boolean;
  detail: string;
  sampleCount?: number;
}> {
  try {
    const items = await discoverResources("coingecko", 1);
    return {
      ok: items.length > 0,
      detail:
        items.length > 0
          ? "x402 discovery reachable"
          : "discovery empty or blocked",
      sampleCount: items.length,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "discovery failed",
    };
  }
}
