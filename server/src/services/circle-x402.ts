/**
 * Circle Agent Marketplace (x402 discovery) client.
 * Catalog: https://agents.circle.com/services
 * API: https://api.circle.com/v2/x402/discovery/resources
 *
 * What an Evabob agent wallet can pay for is narrower than the catalog. The
 * payer (nanopay.ts) signs Circle Gateway batched authorizations on the
 * agent's own network, for GET requests with no caller headers. A seller is
 * payable only if it offers exactly that. In September 2026 the catalog held
 * 1,143 endpoints; 323 of them fit — all on Arc mainnet — and none on Arc
 * Testnet. So on testnet the honest list is empty, and the app says so rather
 * than showing a paid-agent feature that has nothing to pay.
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
 * Catalog entries the payer can settle: GET, the `exact` scheme with Gateway
 * batching, on `network`. Pure, so the rule can be tested against a saved
 * catalog. One entry per resource, cheapest matching offer.
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
    if (method !== "GET") continue;
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
    });
  }
  return [...out.values()];
}

let catalogCache: { atMs: number; items: CatalogItem[] } | null = null;
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** The whole public catalog, paged, cached for an hour. */
export async function fetchCatalog(): Promise<CatalogItem[]> {
  if (catalogCache && Date.now() - catalogCache.atMs < CATALOG_TTL_MS) {
    return catalogCache.items;
  }
  const items: CatalogItem[] = [];
  for (let offset = 0; offset < 5_000; offset += 100) {
    const res = await fetch(
      `https://api.circle.com/v2/x402/discovery/resources?limit=100&offset=${offset}`,
      { headers: headers(), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    const body = (await res.json()) as { items?: CatalogItem[] };
    const page = body.items ?? [];
    items.push(...page);
    if (page.length < 100) break;
  }
  catalogCache = { atMs: Date.now(), items };
  return items;
}

/** Services an Evabob agent wallet can pay for on this deployment's network. */
export async function payableServices(): Promise<PayableService[]> {
  return payableFromCatalog(await fetchCatalog(), agentPaymentNetwork());
}

/**
 * The origins agents may pay: the exact origins configured, plus — when the
 * allowlist includes `circle-marketplace` — every origin in Circle's catalog
 * that the payer can settle with. A catalog outage falls back to the explicit
 * origins only, which fails closed.
 */
export async function resolvedAgentOrigins(): Promise<string[]> {
  const configured = config.agents.resourceOrigins;
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
