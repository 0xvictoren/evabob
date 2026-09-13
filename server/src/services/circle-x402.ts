/**
 * Circle Agent Marketplace (x402 discovery) client.
 * Catalog: https://agents.circle.com/services
 * API: https://api.circle.com/v1|v2/x402/discovery/resources
 */

import { config } from "../config.js";

export type MarketplaceSourceId =
  | "polymarket"
  | "reddit"
  | "twitter"
  | "youtube";

export type CuratedService = {
  id: MarketplaceSourceId;
  name: string;
  description: string;
  category: string;
  query: string;
  icon: string;
  marketplaceUrl: string;
};

export const CURATED_SERVICES: CuratedService[] = [
  {
    id: "polymarket",
    name: "Polymarket",
    description: "Prediction market odds, events, and trades",
    category: "PREDICTION_MARKETS",
    query: "polymarket",
    icon: "polymarket",
    marketplaceUrl: "https://agents.circle.com/services",
  },
  {
    id: "reddit",
    name: "Reddit",
    description: "Threads, comments, and community discussions",
    category: "SOCIAL_INTELLIGENCE",
    query: "reddit",
    icon: "reddit",
    marketplaceUrl: "https://agents.circle.com/services",
  },
  {
    id: "twitter",
    name: "Twitter / X",
    description: "Posts, profiles, and engagement data",
    category: "SOCIAL_INTELLIGENCE",
    query: "twitter",
    icon: "twitter",
    marketplaceUrl: "https://agents.circle.com/services",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Video search and channel intelligence",
    category: "SOCIAL_INTELLIGENCE",
    query: "youtube",
    icon: "youtube",
    marketplaceUrl: "https://agents.circle.com/services",
  },
];

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

export type SourceRunResult = {
  source: MarketplaceSourceId | string;
  ok: boolean;
  summary: string;
  costUsdc: number;
  endpoints: DiscoveryEndpoint[];
  error?: string;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
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

/** Normalized marketplace row for mobile Agents tab. */
export type MarketplaceServiceRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Provider / publisher name (e.g. CoinGecko, Exa). */
  provider: string;
  endpoints: number;
  price?: string | number;
  priceUsdc?: number;
  payTo?: string;
  network?: string;
  supportsGateway?: boolean;
  query: string;
  icon: string;
  marketplaceUrl: string;
  /** Raw discovery item for advanced use */
  raw?: unknown;
};

/** Product categories aligned with agents.circle.com/services. */
export const MARKETPLACE_CATEGORIES = [
  "Financial Analysis",
  "Prediction Markets",
  "Web Search",
  "Social Intelligence",
  "Data Enrichment",
  "Infrastructure",
  "Research",
  "Creative",
  "General",
] as const;

export function normalizeCategoryLabel(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "General";
  const u = s.toUpperCase().replace(/[_-]+/g, " ");
  if (u.includes("PREDICTION") || u.includes("POLYMARKET") || u.includes("KALSHI"))
    return "Prediction Markets";
  if (u.includes("FINANC") || u.includes("CRYPTO") || u.includes("MARKET DATA") || u.includes("DEFI"))
    return "Financial Analysis";
  if (u.includes("SEARCH") || u.includes("WEB") || u.includes("TAVILY") || u.includes("EXA") || u.includes("SERPER"))
    return "Web Search";
  if (u.includes("SOCIAL") || u.includes("TWITTER") || u.includes("X ") || u === "X" || u.includes("REDDIT") || u.includes("INFLUENCER"))
    return "Social Intelligence";
  if (u.includes("ENRICH") || u.includes("CONTACT") || u.includes("APOLLO") || u.includes("TOMBA") || u.includes("LEAD"))
    return "Data Enrichment";
  if (u.includes("INFRA") || u.includes("RPC") || u.includes("MAIL") || u.includes("PHONE") || u.includes("QUICKNODE") || u.includes("NODE"))
    return "Infrastructure";
  if (u.includes("RESEARCH") || u.includes("SCHOLAR") || u.includes("JOB"))
    return "Research";
  if (u.includes("CREATIVE") || u.includes("IMAGE") || u.includes("VIDEO") || u.includes("MEDIA") || u.includes("GENERAT"))
    return "Creative";
  // Title-case raw for display
  return s
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Live Circle x402 Discovery catalog (public, keyless when possible).
 * Falls back to curated list on failure.
 */
export async function getMarketplaceServices(query?: {
  category?: string;
  maxPrice?: string;
  limit?: number;
  q?: string;
}): Promise<MarketplaceServiceRow[]> {
  const limit = query?.limit ?? 50;
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  if (query?.category) params.set("category", query.category);
  if (query?.q) params.set("query", query.q);

  try {
    const res = await fetch(
      `https://api.circle.com/v2/x402/discovery/resources?${params}`,
      { headers: headers() },
    );
    if (!res.ok) {
      throw new Error(`discovery HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      items?: Array<Record<string, unknown>>;
      data?: Array<Record<string, unknown>>;
    };
    const items = data.items ?? data.data ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      return CURATED_SERVICES.map(curatedToRow);
    }
    const rows = items.map((item) => normalizeDiscoveryItem(item));
    if (query?.category) {
      const cat = query.category.toLowerCase();
      return rows.filter(
        (r) =>
          r.category.toLowerCase().includes(cat) ||
          r.name.toLowerCase().includes(cat),
      );
    }
    if (query?.q) {
      const q = query.q.toLowerCase();
      return rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q),
      );
    }
    return rows;
  } catch {
    return CURATED_SERVICES.map(curatedToRow);
  }
}

export async function getMarketplaceServiceById(
  id: string,
): Promise<MarketplaceServiceRow | null> {
  const all = await getMarketplaceServices({ limit: 100 });
  const found = all.find(
    (s) => s.id === id || s.id.includes(id) || s.name === id,
  );
  if (found) return found;
  const curated = CURATED_SERVICES.find((s) => s.id === id);
  return curated ? curatedToRow(curated) : null;
}

function curatedToRow(s: CuratedService): MarketplaceServiceRow {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    category: normalizeCategoryLabel(s.category),
    provider: s.name,
    endpoints: 1,
    query: s.query,
    icon: s.icon,
    marketplaceUrl: s.marketplaceUrl,
  };
}

function normalizeDiscoveryItem(
  item: Record<string, unknown>,
): MarketplaceServiceRow {
  const meta = (item.metadata as Record<string, unknown>) || {};
  const provider = (meta.provider as Record<string, unknown>) || {};
  const accepts = Array.isArray(item.accepts)
    ? (item.accepts as Array<Record<string, unknown>>)
    : [];
  const first = accepts[0] || {};
  const resource =
    (item.resource as string) ||
    (item.url as string) ||
    (item.id as string) ||
    randomId();
  const providerName =
    (provider.name as string) ||
    (meta.providerName as string) ||
    (item.provider as string) ||
    "";
  const name =
    (meta.name as string) ||
    (item.name as string) ||
    providerName ||
    "Unknown";
  const description =
    (meta.description as string) ||
    (provider.description as string) ||
    (item.description as string) ||
    "";
  const categoryRaw =
    (provider.category as string) ||
    (meta.category as string) ||
    (item.category as string) ||
    "GENERAL";
  const amount = first.amount as string | number | undefined;
  const providerLabel = providerName || name.split(/[\s·|/]/)[0] || name;
  return {
    id: resource,
    name,
    description,
    category: normalizeCategoryLabel(categoryRaw),
    provider: providerLabel,
    endpoints: accepts.length || 1,
    price: amount,
    priceUsdc: atomicToUsdc(amount),
    payTo: first.payTo as string | undefined,
    network: first.network as string | undefined,
    supportsGateway: Boolean(item.supportsCircleGateway),
    query: name,
    icon: "hub",
    marketplaceUrl: "https://agents.circle.com/services",
    raw: item,
  };
}

function randomId() {
  return `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapItem(item: Record<string, unknown>): DiscoveryEndpoint | null {
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
  const versions = ["v1", "v2"] as const;
  for (const v of versions) {
    const url = new URL(
      `https://api.circle.com/${v}/x402/discovery/resources`,
    );
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    try {
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        items?: Array<Record<string, unknown>>;
      };
      const items = body.items || [];
      return items
        .map((it) => mapItem(it))
        .filter((x): x is DiscoveryEndpoint => x != null);
    } catch (e) {
      console.warn(`x402 discovery ${v} failed:`, e);
    }
  }
  return [];
}

/**
 * Parallel research across curated sources.
 * Discovers live marketplace endpoints and estimates per-call USDC cost.
 * Live settlement: POST /v1/x402/pay with agent API key (see x402Pay.ts).
 * This path still bills the agent ledger for discovery usage when not paying.
 */
export async function runParallelSources(input: {
  userQuery: string;
  sources: string[];
}): Promise<SourceRunResult[]> {
  const sources = input.sources.length
    ? input.sources
    : CURATED_SERVICES.map((s) => s.id);

  const tasks = sources.map(async (source): Promise<SourceRunResult> => {
    const curated = CURATED_SERVICES.find((s) => s.id === source);
    const searchQ = curated
      ? `${curated.query} ${input.userQuery}`.trim()
      : `${source} ${input.userQuery}`.trim();

    try {
      const endpoints = await discoverResources(searchQ, 4);
      if (endpoints.length === 0) {
        // Fallback: search with just the source keyword
        const fallback = await discoverResources(curated?.query || source, 4);
        if (fallback.length === 0) {
          return {
            source,
            ok: false,
            summary: `No marketplace endpoints found for "${source}"`,
            costUsdc: 0,
            endpoints: [],
            error: "empty_catalog",
          };
        }
        const cost = Math.min(
          0.05,
          fallback.reduce((s, e) => s + e.maxAmountUsdc, 0) || 0.01,
        );
        return {
          source,
          ok: true,
          summary: `${fallback.length} endpoint(s) for ${curated?.name || source} · top: ${fallback[0]?.description || fallback[0]?.resource}`,
          costUsdc: Number(cost.toFixed(6)),
          endpoints: fallback,
        };
      }

      const cost = Math.min(
        0.05,
        endpoints.reduce((s, e) => s + e.maxAmountUsdc, 0) || 0.01,
      );
      return {
        source,
        ok: true,
        summary: `Found ${endpoints.length} payable endpoint(s) matching “${input.userQuery}” on ${curated?.name || source}. Ready for x402 pay-per-call via Circle Gateway.`,
        costUsdc: Number(cost.toFixed(6)),
        endpoints,
      };
    } catch (e) {
      return {
        source,
        ok: false,
        summary: "Discovery failed",
        costUsdc: 0,
        endpoints: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  return Promise.all(tasks);
}

export async function circleMarketplaceHealth(): Promise<{
  ok: boolean;
  detail: string;
  sampleCount?: number;
}> {
  try {
    const items = await discoverResources("polymarket", 1);
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
