/**
 * The marketplace: what people sell, what people want, and an agent that
 * puts the two together.
 *
 * Two kinds of post share one shape:
 *
 *   offer  "I sell this" — goods or a service, at a price
 *   want   "I need this" — what someone is looking for, and what they will pay
 *
 * A seller answers a want with a proposal (a price, a note, how soon). The
 * buyer of an offer, or the poster of a want who accepts a proposal, gets a
 * deal. A deal is not a new way to pay: it is an ordinary payment request
 * from the seller to the buyer (services/payment-requests.ts), so the buyer
 * chooses exactly what they can choose anywhere else in Evabob — pay it all,
 * pay half and hold half, or hold it all until it is delivered — and the
 * held part follows the job-hold rules (docs/HELD_PAYMENTS.md).
 *
 * Ranking is the same three things everywhere a list is shown: how well it
 * fits what was asked, how near the person is, and how good their record is.
 * The record is counted from what happened on Evabob — holds delivered,
 * holds refunded, reviews left by people who actually paid — not from what a
 * seller says about themselves. Outside accounts (Instagram, X, a website)
 * add to it only once someone has checked the seller controls them.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { store, type UserRecord } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { sellerRecord, type SellerRecord } from "./holdLinks.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";

// ─── Shapes ──────────────────────────────────────────────────────────────

export const MARKET_CATEGORIES = [
  { id: "home", label: "Home and cleaning", words: "clean cleaner cleaning laundry housekeeping fumigation gardener home maid nanny" },
  { id: "food", label: "Food and catering", words: "cook chef baker cake catering food meal small chops pastry jollof drinks" },
  { id: "repairs", label: "Repairs and trades", words: "repair plumber electrician carpenter mechanic generator ac technician welder painter tiler fix" },
  { id: "fashion", label: "Fashion and tailoring", words: "tailor fashion clothes dress shoes bag ankara aso-ebi fabric sew wig" },
  { id: "beauty", label: "Beauty and wellness", words: "hair braids barber makeup nails spa massage lashes skincare stylist" },
  { id: "phones", label: "Phones and electronics", words: "phone iphone laptop computer tv electronics gadget charger accessories" },
  { id: "design", label: "Design and media", words: "design logo graphics brand video photo photographer editing animation flyer" },
  { id: "tech", label: "Tech and software", words: "developer website app software code programming data it support" },
  { id: "lessons", label: "Lessons and tutoring", words: "tutor lesson teacher class teach training course coaching exam" },
  { id: "events", label: "Events", words: "event dj mc decoration decor rental planner hall usher wedding party" },
  { id: "delivery", label: "Delivery and errands", words: "delivery dispatch rider errand logistics move mover truck pickup" },
  { id: "farm", label: "Farm produce", words: "farm rice yam tomato pepper palm oil garri fish chicken egg vegetable produce" },
  { id: "rentals", label: "Rentals", words: "rent rental hire lease car apartment shortlet equipment generator chairs canopy" },
  { id: "other", label: "Everything else", words: "" },
] as const;

export type MarketCategory = (typeof MARKET_CATEGORIES)[number]["id"];
const CATEGORY_IDS = MARKET_CATEGORIES.map((c) => c.id) as readonly string[];

export type PostKind = "offer" | "want";
export type PostType = "goods" | "service";

export type MarketPlace = {
  country: string;
  /** State or region, e.g. "Lagos". */
  state: string;
  /** Town, area or neighbourhood, e.g. "Lekki". */
  area: string;
  /** Only when the person shared it; never shown, used only for distance. */
  lat?: number;
  lng?: number;
};

export type MarketPost = {
  id: string;
  kind: PostKind;
  type: PostType;
  ownerId: string;
  category: MarketCategory;
  title: string;
  description: string;
  /** Dollars. The price of an offer, or the most a want will pay. */
  priceUsd: number;
  /** The amount as typed, in the poster's own currency. */
  display?: { currency: string; amount: number };
  photos: string[];
  place: MarketPlace;
  /** Can be done or sent from anywhere (design work, a parcel by courier). */
  remote: boolean;
  /** Days to deliver, for the hold that pays for it. */
  deliveryDays: number;
  active: boolean;
  createdAt: string;
  closedAt?: string;
};

export type ProposalStatus = "sent" | "accepted" | "declined" | "withdrawn";

/** A seller's answer to a want. */
export type MarketProposal = {
  id: string;
  postId: string;
  sellerId: string;
  priceUsd: number;
  message: string;
  deliveryDays: number;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
};

export type MarketDeal = {
  id: string;
  postId: string;
  proposalId?: string;
  sellerId: string;
  buyerId: string;
  title: string;
  priceUsd: number;
  /** The payment request the buyer pays (services/payment-requests.ts). */
  requestId: string;
  createdAt: string;
};

export type MarketReview = {
  id: string;
  dealId: string;
  sellerId: string;
  buyerId: string;
  stars: number;
  text: string;
  createdAt: string;
};

export const SOCIAL_PLATFORMS = ["instagram", "x", "tiktok", "facebook", "whatsapp", "website"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialLink = {
  platform: SocialPlatform;
  /** A handle without the @, a phone number, or a web address. */
  handle: string;
  /**
   *   added     the person typed it; nobody has checked it
   *   pending   they asked for a check and were given a code to post
   *   verified  the code was seen on that account
   *   rejected  a check was made and the code was not there
   */
  status: "added" | "pending" | "verified" | "rejected";
  /** What they are asked to put in their bio or on their page. */
  code?: string;
  requestedAt?: string;
  verifiedAt?: string;
  /** "auto" for a website the server read itself, else the reviewer's id. */
  verifiedBy?: string;
};

export type MarketProfile = {
  userId: string;
  /** What they do, in their own words. */
  bio: string;
  place?: MarketPlace;
  socials: SocialLink[];
  updatedAt: string;
};

type MarketData = {
  posts: MarketPost[];
  proposals: MarketProposal[];
  deals: MarketDeal[];
  reviews: MarketReview[];
  profiles: MarketProfile[];
};

export class MarketError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400, readonly code?: string) {
    super(message);
  }
}

export const MAX_OPEN_POSTS = 100;
export const MAX_MARKET_AMOUNT = 10_000;
export const MAX_PHOTOS = 4;

// ─── Storage ─────────────────────────────────────────────────────────────

const DATA_PATH = dataPath("market.json");
const empty = (): MarketData => ({ posts: [], proposals: [], deals: [], reviews: [], profiles: [] });
let data: MarketData = load();

function load(): MarketData {
  try {
    if (!existsSync(DATA_PATH)) return empty();
    // The snapshot keeps every dataset as an array, so the one record that
    // holds the market is stored as a list of one.
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8")) as Array<Partial<MarketData>> | Partial<MarketData>;
    const row = Array.isArray(raw) ? raw[0] : raw;
    return { ...empty(), ...(row ?? {}) };
  } catch {
    return empty();
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, [data]);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  data = load();
});

/** Tests only. */
export function resetMarketForTests(): void {
  data = empty();
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

function clean(text: string | undefined, max: number): string {
  return (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// ─── Places and distance ─────────────────────────────────────────────────

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function cleanPlace(input: Partial<MarketPlace> | undefined): MarketPlace | undefined {
  if (!input) return undefined;
  const state = clean(input.state, 40);
  const area = clean(input.area, 60);
  const lat = input.lat == null ? NaN : Number(input.lat);
  const lng = input.lng == null ? NaN : Number(input.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0);
  // A point alone is a place too: someone who tapped "Use my location"
  // before typing where they are still gets ranked by distance.
  if (!state && !area && !hasPoint) return undefined;
  return {
    country: clean(input.country, 40) || "Nigeria",
    state,
    area,
    // Rounded to about a kilometre: enough to rank by, too coarse to find a door.
    ...(hasPoint ? { lat: Number(lat.toFixed(2)), lng: Number(lng.toFixed(2)) } : {}),
  };
}

export function kmBetween(a: MarketPlace, b: MarketPlace): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Nearness = { score: number; label: string | null; km: number | null };

/**
 * How near two people are, from 0 to 1. A measured distance wins when both
 * shared one; otherwise the names of their area and state are compared.
 * Pure.
 */
export function nearness(viewer: MarketPlace | undefined, other: MarketPlace | undefined, remote = false): Nearness {
  const far: Nearness = remote
    ? { score: 0.55, label: "Works from anywhere", km: null }
    : { score: 0.15, label: other?.state ? `In ${other.area ? `${other.area}, ` : ""}${other.state}` : null, km: null };
  if (!viewer || !other) return far;
  const km = kmBetween(viewer, other);
  if (km != null) {
    const label = km < 1 ? "Less than 1 km away" : `About ${km < 10 ? km.toFixed(1) : Math.round(km)} km away`;
    const score = km <= 3 ? 1 : km <= 10 ? 0.85 : km <= 30 ? 0.65 : km <= 100 ? 0.4 : 0.15;
    return { score: Math.max(score, remote ? 0.55 : 0), label, km };
  }
  const sameState = norm(viewer.state) !== "" && norm(viewer.state) === norm(other.state);
  const sameArea = sameState && norm(viewer.area) !== "" && norm(viewer.area) === norm(other.area);
  if (sameArea) return { score: 1, label: `In ${other.area}, like you`, km: null };
  if (sameState) return { score: 0.7, label: `In ${other.area ? `${other.area}, ` : ""}${other.state}`, km: null };
  return far;
}

// ─── Profiles and reputation ─────────────────────────────────────────────

function profileRow(userId: string): MarketProfile | undefined {
  return data.profiles.find((p) => p.userId === userId);
}

function ensureProfile(userId: string): MarketProfile {
  let row = profileRow(userId);
  if (!row) {
    row = { userId, bio: "", socials: [], updatedAt: new Date().toISOString() };
    data.profiles.push(row);
  }
  return row;
}

export function placeOf(userId: string): MarketPlace | undefined {
  return profileRow(userId)?.place;
}

export function cleanSocialHandle(platform: SocialPlatform, raw: string): string {
  let h = clean(raw, 120);
  if (platform === "website") {
    if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
    let url: URL;
    try {
      url = new URL(h);
    } catch {
      throw new MarketError("That web address does not look right.");
    }
    if (url.protocol !== "https:") throw new MarketError("Use an https:// address.");
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  if (platform === "whatsapp") {
    const digits = h.replace(/[^\d+]/g, "");
    if (!/^\+?\d{8,15}$/.test(digits)) throw new MarketError("Enter the WhatsApp number with its country code.");
    return digits;
  }
  // A pasted profile link becomes its handle.
  h = h.replace(/^https?:\/\/(www\.)?[^/]+\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(h)) throw new MarketError("That username does not look right.");
  return h;
}

export function saveProfile(
  userId: string,
  input: { bio?: string; place?: Partial<MarketPlace>; socials?: Array<{ platform: SocialPlatform; handle: string }> },
): MarketProfile {
  const row = ensureProfile(userId);
  if (input.bio !== undefined) row.bio = clean(input.bio, 400);
  if (input.place !== undefined) row.place = cleanPlace(input.place);
  if (input.socials !== undefined) {
    const next: SocialLink[] = [];
    for (const s of input.socials.slice(0, SOCIAL_PLATFORMS.length)) {
      if (!SOCIAL_PLATFORMS.includes(s.platform) || next.some((n) => n.platform === s.platform)) continue;
      if (!clean(s.handle, 120)) continue;
      const handle = cleanSocialHandle(s.platform, s.handle);
      const before = row.socials.find((o) => o.platform === s.platform);
      // A check belongs to one handle. Change the handle and it starts over.
      next.push(before && before.handle.toLowerCase() === handle.toLowerCase()
        ? before
        : { platform: s.platform, handle, status: "added" });
    }
    row.socials = next;
  }
  row.updatedAt = new Date().toISOString();
  save();
  return row;
}

/** The person asks for an account to be checked and gets a code to post. */
export function requestSocialCheck(userId: string, platform: SocialPlatform): SocialLink {
  const link = ensureProfile(userId).socials.find((s) => s.platform === platform);
  if (!link) throw new MarketError("Add that account to your profile first.", 404);
  if (link.status === "verified") return link;
  link.code = link.code ?? `evabob-${randomBytes(3).toString("hex")}`;
  link.status = "pending";
  link.requestedAt = new Date().toISOString();
  save();
  return link;
}

export function decideSocialCheck(input: {
  userId: string;
  platform: SocialPlatform;
  verified: boolean;
  by: string;
}): SocialLink {
  const link = profileRow(input.userId)?.socials.find((s) => s.platform === input.platform);
  if (!link) throw new MarketError("No such account.", 404);
  link.status = input.verified ? "verified" : "rejected";
  link.verifiedBy = input.by;
  link.verifiedAt = input.verified ? new Date().toISOString() : undefined;
  save();
  return link;
}

/** Accounts waiting for a person to look at them. */
export function pendingSocialChecks() {
  return data.profiles.flatMap((p) =>
    p.socials
      .filter((s) => s.status === "pending")
      .map((s) => ({ ...s, userId: p.userId, owner: store.getUser(p.userId)?.handle ?? null })));
}

export type Reputation = {
  /** 0 to 100. */
  score: number;
  tier: "new" | "building" | "trusted" | "top";
  tierLabel: string;
  /** Average of reviews by people who paid; null with none yet. */
  rating: number | null;
  reviews: number;
  record: SellerRecord;
  /** Deals whose payment went through. */
  dealsPaid: number;
  verifiedSocials: SocialPlatform[];
  memberSince: string | null;
  /** The plain reasons behind the score, strongest first. */
  reasons: string[];
};

/**
 * The score, from the facts. Pure, so the rule can be tested and explained.
 *
 *   up to 45  delivered work, by share of finished holds, growing with volume
 *   up to 30  reviews from buyers who paid, pulled toward 3.5 while there are few
 *   up to 15  outside accounts someone checked (5 each)
 *   up to 10  time on Evabob (a year for the full 10)
 *   minus     12 for each refund a reviewer ordered, 4 for each order never delivered
 */
export function scoreReputation(input: {
  record: SellerRecord;
  ratingSum: number;
  reviews: number;
  dealsPaid: number;
  verifiedSocials: number;
  ageDays: number;
}): { score: number; tier: Reputation["tier"] } {
  const { record } = input;
  const finished = record.delivered + record.notDelivered + record.refundedAfterReview;
  const done = record.delivered + Math.max(0, input.dealsPaid - finished) * 0.5;
  const share = finished > 0 ? record.delivered / finished : input.dealsPaid > 0 ? 0.8 : 0;
  const volume = 1 - Math.exp(-done / 6);
  const delivery = 45 * share * volume;
  const smoothed = (input.ratingSum + 3.5 * 3) / (input.reviews + 3);
  const reviewWeight = 1 - Math.exp(-input.reviews / 4);
  const rating = 30 * Math.max(0, (smoothed - 2.5) / 2.5) * reviewWeight;
  const socials = Math.min(15, input.verifiedSocials * 5);
  const age = Math.min(10, (Math.max(0, input.ageDays) / 365) * 10);
  const penalty = record.refundedAfterReview * 12 + record.notDelivered * 4;
  const score = Math.round(Math.max(0, Math.min(100, delivery + rating + socials + age - penalty)));
  const tier: Reputation["tier"] =
    finished + input.dealsPaid === 0 && input.reviews === 0
      ? "new"
      : score >= 70 && record.delivered >= 10
        ? "top"
        : score >= 45 && record.delivered >= 3
          ? "trusted"
          : "building";
  return { score, tier };
}

const TIER_LABEL: Record<Reputation["tier"], string> = {
  new: "New here",
  building: "Building a record",
  trusted: "Trusted",
  top: "Top seller",
};

function dealPaid(deal: MarketDeal, statusOf: (requestId: string) => string | undefined): boolean {
  const s = statusOf(deal.requestId);
  return s === "paid" || s === "partial" || s === "escrow" || s === "released";
}

let requestStatus: (requestId: string) => string | undefined = () => undefined;
/** Wired by the routes so this file does not import payment requests at load. */
export function setRequestStatusReader(reader: (requestId: string) => string | undefined): void {
  requestStatus = reader;
}

export function reputationOf(userId: string, now = Date.now()): Reputation {
  const user = store.getUser(userId);
  const record = sellerRecord(userId);
  const mine = data.reviews.filter((r) => r.sellerId === userId);
  const ratingSum = mine.reduce((s, r) => s + r.stars, 0);
  const dealsPaid = data.deals.filter((d) => d.sellerId === userId && dealPaid(d, requestStatus)).length;
  const verifiedSocials = (profileRow(userId)?.socials ?? [])
    .filter((s) => s.status === "verified")
    .map((s) => s.platform);
  const created = (user as (UserRecord & { createdAt?: string }) | undefined)?.createdAt;
  const ageDays = created ? (now - Date.parse(created)) / 86_400_000 : 0;
  const { score, tier } = scoreReputation({
    record,
    ratingSum,
    reviews: mine.length,
    dealsPaid,
    verifiedSocials: verifiedSocials.length,
    ageDays: Number.isFinite(ageDays) ? ageDays : 0,
  });
  const reasons: string[] = [];
  if (record.delivered > 0) reasons.push(`${record.delivered} delivered and paid`);
  if (mine.length > 0) reasons.push(`${(ratingSum / mine.length).toFixed(1)} from ${mine.length} ${mine.length === 1 ? "buyer" : "buyers"}`);
  if (verifiedSocials.length > 0) reasons.push(`${verifiedSocials.map(socialName).join(", ")} checked`);
  if (record.refundedAfterReview > 0) reasons.push(`${record.refundedAfterReview} refunded after review`);
  if (record.notDelivered > 0) reasons.push(`${record.notDelivered} not delivered`);
  if (reasons.length === 0) reasons.push("No finished orders yet");
  return {
    score,
    tier,
    tierLabel: TIER_LABEL[tier],
    rating: mine.length > 0 ? Number((ratingSum / mine.length).toFixed(2)) : null,
    reviews: mine.length,
    record,
    dealsPaid,
    verifiedSocials,
    memberSince: created ?? null,
    reasons,
  };
}

export function socialName(p: SocialPlatform): string {
  return { instagram: "Instagram", x: "X", tiktok: "TikTok", facebook: "Facebook", whatsapp: "WhatsApp", website: "Website" }[p];
}

/** Where a checked account can be opened, so a buyer can look for themselves. */
export function socialUrl(s: Pick<SocialLink, "platform" | "handle">): string {
  switch (s.platform) {
    case "instagram": return `https://instagram.com/${s.handle}`;
    case "x": return `https://x.com/${s.handle}`;
    case "tiktok": return `https://tiktok.com/@${s.handle}`;
    case "facebook": return `https://facebook.com/${s.handle}`;
    case "whatsapp": return `https://wa.me/${s.handle.replace(/^\+/, "")}`;
    case "website": return s.handle;
  }
}

/** What anyone may see of a person on the market. Never their wallet or email. */
export function personCard(userId: string, viewerPlace?: MarketPlace) {
  const user = store.getUser(userId);
  const profile = profileRow(userId);
  const near = nearness(viewerPlace, profile?.place);
  return {
    id: userId,
    name: user?.displayName || (user?.handle ? `@${user.handle}` : "Someone on Evabob"),
    handle: user?.handle ? `@${user.handle}` : null,
    avatarUrl: user?.avatarUrl ?? null,
    avatarBundleIndex: user?.avatarBundleIndex ?? null,
    bio: profile?.bio ?? "",
    place: profile?.place ? { state: profile.place.state, area: profile.place.area, country: profile.place.country } : null,
    near: near.label,
    socials: (profile?.socials ?? []).map((s) => ({
      platform: s.platform,
      name: socialName(s.platform),
      handle: s.handle,
      url: socialUrl(s),
      verified: s.status === "verified",
    })),
    reputation: reputationOf(userId),
    reviews: data.reviews
      .filter((r) => r.sellerId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((r) => ({
        stars: r.stars,
        text: r.text,
        at: r.createdAt,
        by: store.getUser(r.buyerId)?.handle ? `@${store.getUser(r.buyerId)!.handle}` : "A buyer",
      })),
  };
}

/** A person's own profile, with what only they should see (codes to post). */
export function myProfile(userId: string) {
  const row = ensureProfile(userId);
  return {
    bio: row.bio,
    place: row.place ?? null,
    socials: row.socials.map((s) => ({ ...s, name: socialName(s.platform), url: socialUrl(s) })),
    reputation: reputationOf(userId),
  };
}

// ─── Posts ───────────────────────────────────────────────────────────────

/** A category guessed from the words someone used. Pure. */
export function guessCategory(text: string): MarketCategory {
  const words = new Set(norm(text).split(/[^a-z0-9-]+/).filter(Boolean));
  let best: MarketCategory = "other";
  let bestHits = 0;
  for (const c of MARKET_CATEGORIES) {
    const hits = c.words.split(" ").filter((w) => w && (words.has(w) || words.has(`${w}s`))).length;
    if (hits > bestHits) {
      best = c.id;
      bestHits = hits;
    }
  }
  return best;
}

export function createPost(
  ownerId: string,
  input: {
    kind: PostKind;
    type: PostType;
    category?: string;
    title: string;
    description?: string;
    priceUsd: number;
    display?: { currency: string; amount: number };
    photos?: string[];
    place?: Partial<MarketPlace>;
    remote?: boolean;
    deliveryDays?: number;
  },
): MarketPost {
  const owner = store.getUser(ownerId);
  // Money for a deal is held for the seller's @handle, so they need one.
  if (!owner?.handle) throw new MarketError("Pick a username in Profile first.", 400, "HANDLE_REQUIRED");
  const title = clean(input.title, 90);
  if (title.length < 3) {
    throw new MarketError(input.kind === "want" ? "Say what you need." : "Say what you are offering.");
  }
  const price = Number(input.priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new MarketError(input.kind === "want" ? "Say how much you will pay." : "Set a price.");
  }
  if (price > MAX_MARKET_AMOUNT) throw new MarketError(`The most a post can be is $${MAX_MARKET_AMOUNT.toLocaleString("en-US")}.`);
  if (data.posts.filter((p) => p.ownerId === ownerId && p.active).length >= MAX_OPEN_POSTS) {
    throw new MarketError(`You have ${MAX_OPEN_POSTS} open posts. Close one first.`, 409);
  }
  const description = clean(input.description, 1_500);
  const place = cleanPlace(input.place) ?? placeOf(ownerId);
  // A post shows its area by name; a position alone ranks but tells a reader nothing.
  if (!place || (!place.state && !place.area)) {
    throw new MarketError("Say where you are, so people near you can find this.", 400, "PLACE_REQUIRED");
  }
  const category = input.category && CATEGORY_IDS.includes(input.category)
    ? (input.category as MarketCategory)
    : guessCategory(`${title} ${description}`);
  const days = Math.round(Number(input.deliveryDays ?? 7));
  const post: MarketPost = {
    id: newId("mp"),
    kind: input.kind,
    type: input.type,
    ownerId,
    category,
    title,
    description,
    priceUsd: Number(price.toFixed(6)),
    ...(input.display && input.display.amount > 0 ? { display: input.display } : {}),
    photos: (input.photos ?? []).filter((p) => /^\/uploads\/market_[a-f0-9]{32}\.(jpg|png|webp)$/.test(p)).slice(0, MAX_PHOTOS),
    place,
    remote: Boolean(input.remote),
    deliveryDays: Number.isFinite(days) ? Math.min(60, Math.max(1, days)) : 7,
    active: true,
    createdAt: new Date().toISOString(),
  };
  data.posts.unshift(post);
  // The first post also says where the person is, for everything after it.
  if (!placeOf(ownerId)) ensureProfile(ownerId).place = place;
  save();
  return post;
}

export function getPost(id: string): MarketPost | undefined {
  return data.posts.find((p) => p.id === id);
}

export function setPostActive(ownerId: string, id: string, active: boolean): MarketPost {
  const post = getPost(id);
  if (!post || post.ownerId !== ownerId) throw new MarketError("No such post.", 404);
  post.active = active;
  post.closedAt = active ? undefined : new Date().toISOString();
  save();
  return post;
}

export function postsBy(ownerId: string): MarketPost[] {
  return data.posts.filter((p) => p.ownerId === ownerId);
}

// ─── Ranking ─────────────────────────────────────────────────────────────

const STOP = new Set("a an the and or for to of in on at with my i me need want looking someone who can is are be it this that some any please good best near".split(" "));

export function keywords(text: string): string[] {
  return [...new Set(norm(text).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

const stem = (w: string) => w.replace(/(ing|ers|er|es|s)$/, "");

/** How well a post fits some words, 0 to 1. Title matches count double. Pure. */
export function relevance(queryWords: string[], post: Pick<MarketPost, "title" | "description" | "category">): number {
  if (queryWords.length === 0) return 0.5;
  const title = new Set(keywords(post.title).map(stem));
  const body = new Set(keywords(`${post.description} ${MARKET_CATEGORIES.find((c) => c.id === post.category)?.words ?? ""}`).map(stem));
  let got = 0;
  for (const w of queryWords.map(stem)) {
    if (title.has(w)) got += 1;
    else if (body.has(w)) got += 0.5;
  }
  return Math.min(1, got / queryWords.length);
}

export type Ranked = {
  post: MarketPost;
  score: number;
  near: Nearness;
  reputation: Reputation;
  fit: number;
  /** Why it is where it is, in words a person would use. */
  why: string[];
};

export type Sort = "best" | "nearest" | "top_rated" | "price_low" | "price_high" | "newest";

/**
 * One ordering rule for every list: fit, then nearness, then record, then
 * price. `budgetUsd` is what a want will pay; offers above it lose points
 * rather than disappearing, because people stretch for the right seller.
 */
export function rankPosts(input: {
  posts: MarketPost[];
  query?: string;
  viewerPlace?: MarketPlace;
  budgetUsd?: number;
  sort?: Sort;
  now?: number;
}): Ranked[] {
  const words = keywords(input.query ?? "");
  const reps = new Map<string, Reputation>();
  const out: Ranked[] = [];
  for (const post of input.posts) {
    const fit = relevance(words, post);
    if (words.length > 0 && fit === 0) continue;
    const near = nearness(input.viewerPlace, post.place, post.remote);
    let rep = reps.get(post.ownerId);
    if (!rep) {
      rep = reputationOf(post.ownerId, input.now);
      reps.set(post.ownerId, rep);
    }
    const priceFit = input.budgetUsd && input.budgetUsd > 0
      ? post.priceUsd <= input.budgetUsd ? 1 : Math.max(0, 1 - (post.priceUsd - input.budgetUsd) / input.budgetUsd)
      : 0.5;
    const score = fit * 0.4 + near.score * 0.25 + (rep.score / 100) * 0.25 + priceFit * 0.1;
    const why: string[] = [];
    if (near.label) why.push(near.label);
    if (rep.tier !== "new") why.push(rep.reasons[0]!);
    else why.push("New here");
    if (input.budgetUsd && post.priceUsd <= input.budgetUsd) why.push("Within your budget");
    out.push({ post, score, near, reputation: rep, fit, why });
  }
  const sort = input.sort ?? "best";
  out.sort((a, b) => {
    switch (sort) {
      case "nearest": return b.near.score - a.near.score || b.score - a.score;
      case "top_rated": return b.reputation.score - a.reputation.score || b.score - a.score;
      case "price_low": return a.post.priceUsd - b.post.priceUsd;
      case "price_high": return b.post.priceUsd - a.post.priceUsd;
      case "newest": return b.post.createdAt.localeCompare(a.post.createdAt);
      default: return b.score - a.score || b.post.createdAt.localeCompare(a.post.createdAt);
    }
  });
  return out;
}

export function browse(input: {
  viewerId: string;
  kind: PostKind;
  type?: PostType;
  category?: string;
  query?: string;
  sort?: Sort;
  limit?: number;
}): Ranked[] {
  const posts = data.posts.filter((p) =>
    p.active && p.kind === input.kind &&
    (!input.type || p.type === input.type) &&
    (!input.category || p.category === input.category));
  return rankPosts({ posts, query: input.query, viewerPlace: placeOf(input.viewerId), sort: input.sort })
    .slice(0, Math.min(100, input.limit ?? 60));
}

// ─── The matching agent ──────────────────────────────────────────────────

/**
 * For a want: the offers that answer it, best first. This is the "agent"
 * a person sees — it reads the market for them and says why each one made
 * the list. Sellers further down are not hidden; the list is a shortlist.
 */
export function matchWant(want: MarketPost, limit = 8): Ranked[] {
  const candidates = data.posts.filter((p) =>
    p.active && p.kind === "offer" && p.ownerId !== want.ownerId &&
    (p.type === want.type || p.category === want.category));
  const query = `${want.title} ${want.description}`;
  const ranked = rankPosts({ posts: candidates, query, viewerPlace: want.place, budgetUsd: want.priceUsd });
  // Same category with no shared words is still worth a look, after the rest.
  const seen = new Set(ranked.map((r) => r.post.id));
  const sameCategory = rankPosts({
    posts: candidates.filter((p) => p.category === want.category && want.category !== "other" && !seen.has(p.id)),
    viewerPlace: want.place,
    budgetUsd: want.priceUsd,
  }).map((r) => ({ ...r, score: r.score * 0.6 }));
  return [...ranked, ...sameCategory].slice(0, limit);
}

/** Sellers worth telling about a new want: the owners of its best matches. */
export function sellersToTell(want: MarketPost, limit = 5): string[] {
  return [...new Set(matchWant(want, 20).map((r) => r.post.ownerId))].slice(0, limit);
}

// ─── Proposals ───────────────────────────────────────────────────────────

export function sendProposal(
  sellerId: string,
  postId: string,
  input: { priceUsd: number; message?: string; deliveryDays?: number },
): MarketProposal {
  const post = getPost(postId);
  if (!post || post.kind !== "want") throw new MarketError("No such request.", 404);
  if (!post.active) throw new MarketError("This request is closed.", 409);
  if (post.ownerId === sellerId) throw new MarketError("This is your own request.", 403);
  const seller = store.getUser(sellerId);
  if (!seller?.handle) throw new MarketError("Pick a username in Profile first.", 400, "HANDLE_REQUIRED");
  const price = Number(input.priceUsd);
  if (!Number.isFinite(price) || price <= 0 || price > MAX_MARKET_AMOUNT) throw new MarketError("Enter your price.");
  const days = Math.round(Number(input.deliveryDays ?? post.deliveryDays));
  const existing = data.proposals.find((p) => p.postId === postId && p.sellerId === sellerId && p.status === "sent");
  const fields = {
    priceUsd: Number(price.toFixed(6)),
    message: clean(input.message, 600),
    deliveryDays: Number.isFinite(days) ? Math.min(60, Math.max(1, days)) : post.deliveryDays,
  };
  if (existing) {
    // One live offer per seller per request: sending again replaces it.
    Object.assign(existing, fields, { createdAt: new Date().toISOString() });
    save();
    return existing;
  }
  const proposal: MarketProposal = {
    id: newId("pr"),
    postId,
    sellerId,
    ...fields,
    status: "sent",
    createdAt: new Date().toISOString(),
  };
  data.proposals.push(proposal);
  save();
  return proposal;
}

export function proposalsFor(postId: string): MarketProposal[] {
  return data.proposals.filter((p) => p.postId === postId);
}

export function proposalsBy(sellerId: string): MarketProposal[] {
  return data.proposals
    .filter((p) => p.sellerId === sellerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProposal(id: string): MarketProposal | undefined {
  return data.proposals.find((p) => p.id === id);
}

export function setProposalStatus(actorId: string, id: string, status: "declined" | "withdrawn"): MarketProposal {
  const proposal = getProposal(id);
  const post = proposal ? getPost(proposal.postId) : undefined;
  if (!proposal || !post) throw new MarketError("No such offer.", 404);
  const allowed = status === "withdrawn" ? proposal.sellerId === actorId : post.ownerId === actorId;
  if (!allowed) throw new MarketError("That is not yours to change.", 403);
  if (proposal.status !== "sent") throw new MarketError("This offer is already settled.", 409);
  proposal.status = status;
  proposal.decidedAt = new Date().toISOString();
  save();
  return proposal;
}

/** The poster's shortlist of proposals: fit to budget, nearness, record. */
export function rankProposals(want: MarketPost) {
  return proposalsFor(want.id)
    .filter((p) => p.status === "sent" || p.status === "accepted")
    .map((p) => {
      const rep = reputationOf(p.sellerId);
      const near = nearness(want.place, placeOf(p.sellerId));
      const priceFit = p.priceUsd <= want.priceUsd ? 1 : Math.max(0, 1 - (p.priceUsd - want.priceUsd) / want.priceUsd);
      return { proposal: p, reputation: rep, near, score: priceFit * 0.35 + near.score * 0.3 + (rep.score / 100) * 0.35 };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Deals ───────────────────────────────────────────────────────────────

/**
 * Records a deal once its payment request exists. The request is made by the
 * route (it needs the payment-requests module); this only keeps the link
 * between the post, the two people and the request.
 */
export function recordDeal(input: Omit<MarketDeal, "id" | "createdAt">): MarketDeal {
  const deal: MarketDeal = { ...input, id: newId("md"), createdAt: new Date().toISOString() };
  data.deals.unshift(deal);
  if (input.proposalId) {
    const proposal = getProposal(input.proposalId);
    if (proposal) {
      proposal.status = "accepted";
      proposal.decidedAt = deal.createdAt;
    }
    // The request has its seller. Other offers are declined, the post closes.
    for (const other of proposalsFor(input.postId)) {
      if (other.id !== input.proposalId && other.status === "sent") {
        other.status = "declined";
        other.decidedAt = deal.createdAt;
      }
    }
    const post = getPost(input.postId);
    if (post) {
      post.active = false;
      post.closedAt = deal.createdAt;
    }
  }
  save();
  return deal;
}

export function getDeal(id: string): MarketDeal | undefined {
  return data.deals.find((d) => d.id === id);
}

export function dealsFor(userId: string): MarketDeal[] {
  return data.deals.filter((d) => d.buyerId === userId || d.sellerId === userId);
}

/** An open deal the buyer already started on this post, to reuse rather than repeat. */
export function openDealFor(buyerId: string, postId: string): MarketDeal | undefined {
  return data.deals.find((d) => d.buyerId === buyerId && d.postId === postId && requestStatus(d.requestId) === "open");
}

export function dealView(deal: MarketDeal, viewerId: string) {
  const status = requestStatus(deal.requestId) ?? "open";
  const review = data.reviews.find((r) => r.dealId === deal.id);
  const iBought = deal.buyerId === viewerId;
  const other = store.getUser(iBought ? deal.sellerId : deal.buyerId);
  return {
    id: deal.id,
    postId: deal.postId,
    title: deal.title,
    priceUsd: deal.priceUsd,
    requestId: deal.requestId,
    payLink: `evabob://pay/${deal.requestId}`,
    role: iBought ? "buyer" : "seller",
    with: other?.handle ? `@${other.handle}` : other?.displayName ?? "Someone",
    status,
    paid: dealPaid(deal, requestStatus),
    canReview: iBought && dealPaid(deal, requestStatus) && !review,
    review: review ? { stars: review.stars, text: review.text } : null,
    createdAt: deal.createdAt,
  };
}

// ─── Reviews ─────────────────────────────────────────────────────────────

/** Only the buyer of a deal that was paid can review it, once. */
export function leaveReview(buyerId: string, dealId: string, input: { stars: number; text?: string }): MarketReview {
  const deal = getDeal(dealId);
  if (!deal || deal.buyerId !== buyerId) throw new MarketError("No such deal.", 404);
  if (!dealPaid(deal, requestStatus)) throw new MarketError("You can review once you have paid.", 409);
  if (data.reviews.some((r) => r.dealId === dealId)) throw new MarketError("You already reviewed this.", 409);
  const stars = Math.round(Number(input.stars));
  if (!(stars >= 1 && stars <= 5)) throw new MarketError("Choose 1 to 5 stars.");
  const review: MarketReview = {
    id: newId("rv"),
    dealId,
    sellerId: deal.sellerId,
    buyerId,
    stars,
    text: clean(input.text, 600),
    createdAt: new Date().toISOString(),
  };
  data.reviews.push(review);
  save();
  return review;
}

// ─── Views ───────────────────────────────────────────────────────────────

export function absoluteUpload(path: string): string {
  return `${(config.publicApiUrl || "").replace(/\/+$/, "")}${path}`;
}

export function postCard(r: Ranked) {
  const owner = store.getUser(r.post.ownerId);
  return {
    id: r.post.id,
    kind: r.post.kind,
    type: r.post.type,
    category: r.post.category,
    title: r.post.title,
    description: r.post.description,
    priceUsd: r.post.priceUsd,
    display: r.post.display ?? null,
    photos: r.post.photos,
    place: { state: r.post.place.state, area: r.post.place.area },
    remote: r.post.remote,
    deliveryDays: r.post.deliveryDays,
    active: r.post.active,
    createdAt: r.post.createdAt,
    near: r.near.label,
    why: r.why,
    seller: {
      id: r.post.ownerId,
      name: owner?.displayName || (owner?.handle ? `@${owner.handle}` : "Someone"),
      handle: owner?.handle ? `@${owner.handle}` : null,
      avatarUrl: owner?.avatarUrl ?? null,
      avatarBundleIndex: owner?.avatarBundleIndex ?? null,
      score: r.reputation.score,
      tier: r.reputation.tier,
      tierLabel: r.reputation.tierLabel,
      rating: r.reputation.rating,
      reviews: r.reputation.reviews,
      delivered: r.reputation.record.delivered,
      verifiedSocials: r.reputation.verifiedSocials,
    },
  };
}

/** One post as a card for a given viewer, outside any list. */
export function cardFor(post: MarketPost, viewerId: string) {
  return postCard(rankPosts({ posts: [post], viewerPlace: placeOf(viewerId) })[0]!);
}
