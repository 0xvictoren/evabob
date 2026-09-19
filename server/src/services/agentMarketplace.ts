/**
 * The curated marketplace an agent's seller list is seeded from.
 *
 * An allowlist that starts empty is one nobody fills in, so agents either do
 * nothing or get a blanket "allow everything". Instead the list starts from
 * two curated sources:
 *
 *   - Evabob paywalls: things people here sell to software (paywalls.ts).
 *     Always payable, and they take the money only after the response is
 *     checked — pay after proof.
 *   - Circle's x402 catalog, filtered to sellers an agent wallet can settle
 *     with on this network (circle-x402.ts). They take payment with the
 *     request, so an agent that only pays after proof skips them.
 *
 * Every seller carries a category, which is what an allowance's "research
 * services only" is checked against, and a record counted from what actually
 * happened: calls delivered, calls that failed their check and cost nothing,
 * and calls a seller was paid for but returned nothing usable.
 */

import { normalizeCategory, type SpendCategory } from "./agentAllowance.js";
import { evidenceForSeller } from "./agentEvidence.js";
import {
  evabobPaywallId,
  getPaywall,
  paywallResourceUrl,
  paywallSellerRecord,
  publicPaywallView,
} from "./paywalls.js";

export type Seller = {
  /** Origin for outside sellers; the paywall URL for Evabob paywalls. */
  id: string;
  name: string;
  category: SpendCategory;
  /** Takes the money only after the response passes the check. */
  waitsForProof: boolean;
  source: "evabob" | "circle-catalog" | "configured";
  paywallId?: string;
};

export type SellerRecord = {
  delivered: number;
  /** Failed the check; nobody was charged. */
  notCharged: number;
  /** Paid, and returned nothing usable. */
  paidNotDelivered: number;
};

/** Counts a seller's record from evidence bundles. Pure over its input. */
export function recordFromEvidence(
  bundles: Array<{ payment: { outcome: string }; cameBack: { verdict: { usable: boolean } } }>,
): SellerRecord {
  const out: SellerRecord = { delivered: 0, notCharged: 0, paidNotDelivered: 0 };
  for (const b of bundles) {
    if (b.payment.outcome === "paid" && b.cameBack.verdict.usable) out.delivered += 1;
    else if (b.payment.outcome === "not_charged") out.notCharged += 1;
    else if (b.payment.outcome === "paid_not_delivered") out.paidNotDelivered += 1;
  }
  return out;
}

/**
 * Who is behind a URL an agent wants to pay, or null when it is on no list
 * at all — which an agent may not pay.
 */
export async function sellerFor(url: string): Promise<Seller | null> {
  const paywallId = evabobPaywallId(url);
  if (paywallId) {
    const view = publicPaywallView(paywallId);
    if (!view) return null;
    return {
      id: paywallResourceUrl(paywallId),
      name: view.seller.handle || view.seller.name,
      category: normalizeCategory(view.category),
      waitsForProof: true,
      source: "evabob",
      paywallId,
    };
  }
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const { resolvedAgentOrigins, payableServices } = await import("./circle-x402.js");
  const allowed = await resolvedAgentOrigins();
  if (!allowed.includes(origin)) return null;
  let catalog: Awaited<ReturnType<typeof payableServices>> = [];
  try {
    catalog = await payableServices();
  } catch {
    /* catalog down: configured origins still work, uncategorised */
  }
  const entry = catalog.find((s) => s.origin === origin);
  return {
    id: origin,
    name: entry?.provider || new URL(origin).hostname,
    category: normalizeCategory(entry?.category),
    waitsForProof: false,
    source: entry ? "circle-catalog" : "configured",
  };
}

export function sellerRecordFor(seller: Seller): SellerRecord {
  if (seller.paywallId) {
    const p = getPaywall(seller.paywallId);
    const r = p ? paywallSellerRecord(p.ownerId) : { delivered: 0, notCharged: 0 };
    return { delivered: r.delivered, notCharged: r.notCharged, paidNotDelivered: 0 };
  }
  return recordFromEvidence(evidenceForSeller(seller.id));
}

export type MarketItem = {
  id: string;
  source: Seller["source"];
  name: string;
  seller: string;
  description: string;
  category: SpendCategory;
  priceUsdc: number;
  waitsForProof: boolean;
  record: SellerRecord;
};

/** The marketplace as the app shows it: what an agent can pay for here. */
export async function listMarketplace(): Promise<{ items: MarketItem[]; note: string | null }> {
  const { listPublicPaywalls } = await import("./paywalls.js");
  const evabob: MarketItem[] = listPublicPaywalls().map((p) => ({
    id: p.resourceUrl,
    source: "evabob" as const,
    name: p.title,
    seller: p.seller.handle || p.seller.name,
    description: p.description,
    category: normalizeCategory(p.category),
    priceUsdc: p.priceUsdc,
    waitsForProof: true,
    record: { delivered: p.seller.record.delivered, notCharged: p.seller.record.notCharged, paidNotDelivered: 0 },
  }));
  let outside: MarketItem[] = [];
  let note: string | null = null;
  try {
    const { payableServices, resolvedAgentOrigins } = await import("./circle-x402.js");
    const allowed = new Set(await resolvedAgentOrigins());
    outside = (await payableServices())
      .filter((s) => allowed.has(s.origin))
      .map((s) => ({
        id: s.origin,
        source: "circle-catalog" as const,
        name: s.provider,
        seller: new URL(s.origin).hostname,
        description: s.description,
        category: normalizeCategory(s.category),
        priceUsdc: s.priceUsdc,
        waitsForProof: false,
        record: recordFromEvidence(evidenceForSeller(s.origin)),
      }));
    if (outside.length === 0) note = "Circle's catalog has no sellers on this network yet.";
  } catch {
    note = "Circle's catalog is unavailable right now.";
  }
  return { items: [...evabob, ...outside], note };
}
