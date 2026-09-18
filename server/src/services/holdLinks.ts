/**
 * Hold-until-delivered links for people who sell on WhatsApp and Instagram.
 *
 * "Send the money and I'll ship" is where most small online sales go wrong:
 * the buyer pays a stranger and hopes. A seller makes one link for a thing
 * they sell and pastes it into a chat, a post or their bio. A buyer who opens
 * it pays into a hold instead of straight to the seller: the money is set
 * aside for the seller until the order arrives.
 *
 * The rules are exactly the job-hold rules (docs/HELD_PAYMENTS.md), chosen by
 * the product owner: the seller marks it delivered, the buyer has 7 days to
 * confirm or object, and silence pays the seller. A buyer who cancels after
 * delivery goes to a person for review. Nothing delivered by the delivery
 * window the seller set (14 days unless they chose otherwise) and the money
 * goes back to the buyer — the hold simply expires.
 *
 * Every order is an ordinary job hold with `holdLinkId` set, so it appears in
 * both people's held payments and is released, refunded and reviewed by the
 * same code. A seller's track record is counted from their finished holds.
 *
 * The word "escrow" is deliberately never shown to anyone.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { store, type UserRecord } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { listAllTracked } from "./escrow-jobs.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";
import type { ProtectedEscrowRecord } from "./mongo.js";

export const DEFAULT_DELIVERY_DAYS = 14;
export const MAX_DELIVERY_DAYS = 60;
export const MAX_HOLD_LINK_AMOUNT = 10_000;

export type HoldLink = {
  /** Public, unguessable, and what goes in the URL. */
  id: string;
  sellerId: string;
  title: string;
  description?: string;
  /** USDC. */
  amount: number;
  /** Days the seller has to deliver before the money goes back. */
  deliveryDays: number;
  active: boolean;
  createdAt: string;
  closedAt?: string;
};

export class HoldLinkError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

const DATA_PATH = dataPath("hold-links.json");
let links: HoldLink[] = load();

function load(): HoldLink[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as HoldLink[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, links);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  links = load();
});

export function holdLinkUrl(id: string): string {
  return `${(config.appPublicUrl || "https://evabob.app").replace(/\/$/, "")}/h/${id}`;
}

export function holdLinkDeepLink(id: string): string {
  return `evabob://hold/${id}`;
}

function clean(text: string | undefined, max: number): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

export function createHoldLink(
  sellerId: string,
  input: { title: string; description?: string; amount: number; deliveryDays?: number },
): HoldLink {
  const seller = store.getUser(sellerId);
  // The hold is locked for the seller's @handle, so they need one.
  if (!seller?.handle) {
    throw new HoldLinkError("Pick a username in Profile first. Buyers pay you by it.");
  }
  const title = clean(input.title, 80);
  if (!title) throw new HoldLinkError("Say what you are selling.");
  const amount = Math.round(input.amount * 1e6) / 1e6;
  if (!(amount >= 0.01) || amount > MAX_HOLD_LINK_AMOUNT) {
    throw new HoldLinkError(`The price must be between $0.01 and $${MAX_HOLD_LINK_AMOUNT}.`);
  }
  const deliveryDays = Math.round(input.deliveryDays ?? DEFAULT_DELIVERY_DAYS);
  if (deliveryDays < 1 || deliveryDays > MAX_DELIVERY_DAYS) {
    throw new HoldLinkError(`Delivery time must be 1 to ${MAX_DELIVERY_DAYS} days.`);
  }
  const link: HoldLink = {
    id: randomBytes(9).toString("base64url"),
    sellerId,
    title,
    description: clean(input.description, 400),
    amount,
    deliveryDays,
    active: true,
    createdAt: new Date().toISOString(),
  };
  links.push(link);
  save();
  return link;
}

export function getHoldLink(id: string): HoldLink | null {
  return links.find((l) => l.id === id) ?? null;
}

export function setHoldLinkActive(sellerId: string, id: string, active: boolean): HoldLink {
  const link = getHoldLink(id);
  if (!link || link.sellerId !== sellerId) throw new HoldLinkError("No such link", 404);
  link.active = active;
  if (active) delete link.closedAt;
  else link.closedAt = new Date().toISOString();
  save();
  return link;
}

// ─── Track record ────────────────────────────────────────────────────────

export type SellerRecord = {
  /** Orders the seller delivered and was paid for. */
  delivered: number;
  /** Orders never marked delivered in time, so the buyer got the money back. */
  notDelivered: number;
  /** Buyers who objected after delivery and a reviewer agreed with them. */
  refundedAfterReview: number;
  /** Orders still waiting on delivery or confirmation. */
  inProgress: number;
};

function identitiesOf(user: UserRecord): string[] {
  return [user.handle, user.email]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.replace(/^@/, "").trim().toLowerCase());
}

/** Pure: counts a seller's finished job holds. */
export function countSellerRecord(holds: ProtectedEscrowRecord[], identities: string[]): SellerRecord {
  const mine = new Set(identities);
  const out: SellerRecord = { delivered: 0, notDelivered: 0, refundedAfterReview: 0, inProgress: 0 };
  for (const h of holds) {
    if (h.purpose !== "job" || !mine.has(h.recipientId.toLowerCase())) continue;
    if (h.status === "claimed") out.delivered += 1;
    else if (h.status === "pending") out.inProgress += 1;
    else if (h.status === "refunded") {
      if (h.settledBy === "review_refunded") out.refundedAfterReview += 1;
      // A payer cancelling before anything was delivered, or the seller
      // handing it back, says nothing against the seller.
      else if (h.settledBy === "expired" || (!h.settledBy && !h.deliveredAt)) out.notDelivered += 1;
    }
  }
  return out;
}

export function sellerRecord(sellerId: string): SellerRecord {
  const seller = store.getUser(sellerId);
  if (!seller) return { delivered: 0, notDelivered: 0, refundedAfterReview: 0, inProgress: 0 };
  return countSellerRecord(listAllTracked(), identitiesOf(seller));
}

// ─── Views ───────────────────────────────────────────────────────────────

function ordersFor(linkId: string): ProtectedEscrowRecord[] {
  return listAllTracked().filter((h) => h.holdLinkId === linkId);
}

/** The seller's own list, with how each link is doing. */
export function listHoldLinksFor(sellerId: string) {
  return links
    .filter((l) => l.sellerId === sellerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((l) => {
      const orders = ordersFor(l.id);
      return {
        ...l,
        url: holdLinkUrl(l.id),
        orders: {
          total: orders.length,
          waiting: orders.filter((o) => o.status === "pending").length,
          paid: orders.filter((o) => o.status === "claimed").length,
          returned: orders.filter((o) => o.status === "refunded").length,
        },
      };
    });
}

/** What anyone with the link sees. Nothing private about seller or buyers. */
export function publicHoldLinkView(id: string) {
  const link = getHoldLink(id);
  if (!link) return null;
  const seller = store.getUser(link.sellerId);
  if (!seller?.handle) return null;
  return {
    id: link.id,
    title: link.title,
    description: link.description ?? "",
    amount: link.amount,
    token: "USDC",
    deliveryDays: link.deliveryDays,
    active: link.active,
    seller: {
      name: seller.displayName || `@${seller.handle}`,
      handle: `@${seller.handle}`,
      avatarUrl: seller.avatarUrl && !seller.avatarUrl.startsWith("data:") ? seller.avatarUrl : null,
      memberSince: seller.createdAt,
    },
    record: sellerRecord(link.sellerId),
    url: holdLinkUrl(link.id),
    deepLink: holdLinkDeepLink(link.id),
  };
}

/**
 * Checks a hold that claims to be an order through this link, before it is
 * recorded as one: the link is open, the money was locked for this seller,
 * for this price, for at least the delivery window.
 */
export function assertHoldLinkOrder(input: {
  holdLinkId: string;
  buyerId: string;
  recipientNormalized: string;
  amountUsdc: number;
  expiresAtMs: number;
  nowMs?: number;
}): HoldLink {
  const link = getHoldLink(input.holdLinkId);
  if (!link) throw new HoldLinkError("That link does not exist", 404);
  if (!link.active) throw new HoldLinkError("The seller has closed this link", 409);
  if (link.sellerId === input.buyerId) throw new HoldLinkError("You cannot buy from your own link");
  const seller = store.getUser(link.sellerId);
  if (!seller || !identitiesOf(seller).includes(input.recipientNormalized.toLowerCase())) {
    throw new HoldLinkError("That payment was not set aside for this seller");
  }
  if (Math.abs(input.amountUsdc - link.amount) > 1e-6) {
    throw new HoldLinkError("That payment does not match the price on the link");
  }
  const now = input.nowMs ?? Date.now();
  // A day's slack for the time between locking and recording.
  const minExpiry = now + (link.deliveryDays - 1) * 24 * 60 * 60 * 1000;
  if (input.expiresAtMs < minExpiry) {
    throw new HoldLinkError("That payment is not held for the seller's delivery time");
  }
  return link;
}
