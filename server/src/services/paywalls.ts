/**
 * Get paid by agents: paywalls for things a person made.
 *
 * A dataset, a photo set, a small API, an hour of someone's time. The person
 * makes a link; software that opens it is asked to pay (HTTP 402, the x402
 * protocol), pays, and gets the thing. Evabob hosts the paywall, takes the
 * payment and deposits it — the individual's version of pay-per-crawl, for
 * people who will never run a CDN.
 *
 * Pay after proof. A buyer's signed payment is only *verified* when it
 * arrives; Evabob then produces the content, checks it is usable, and only
 * then *settles* — takes the money. If the file cannot be read or the
 * person's API fails, the payment is never settled and the buyer is charged
 * nothing. Bookings of time wait longer: the payment is held, unsettled,
 * until the person accepts, and is dropped if they decline or do not answer
 * within BOOKING_ANSWER_MS. A signed Gateway payment stays valid for seven
 * days, which is what makes holding it possible.
 *
 * Payments land in a Circle-held treasury wallet's Gateway balance and are
 * paid out to each person in batches (PAYOUT_MIN_USDC, or a day after the
 * oldest sale), less the 0.05% platform fee and the network cost of the
 * payout itself.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { config } from "../config.js";
import { store } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { normalizeCategory, type SpendCategory } from "./agentAllowance.js";
import { judgeResponse, type Verdict } from "./agentEvidence.js";
import { alertUser } from "./notifyUser.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";

export const MIN_PRICE_USDC = 0.001;
export const MAX_PRICE_USDC = 1_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 5;
export const MAX_TOTAL_FILE_BYTES = 10 * 1024 * 1024;
/** Open paywalls one person may have. Far above real use; bounds storage. */
export const MAX_PAYWALLS_PER_PERSON = 100;
/** Stored files across all of one person's paywalls. */
export const MAX_FILE_BYTES_PER_PERSON = 200 * 1024 * 1024;
export const BOOKING_ANSWER_MS = 48 * 60 * 60 * 1000;
export const PAYOUT_MIN_USDC = 1;
export const PAYOUT_AFTER_MS = 24 * 60 * 60 * 1000;
/** Held back from each payout for the network cost of sending it. */
export const PAYOUT_NETWORK_FEE_USDC = 0.02;

/** Arc testnet, as Circle's Gateway facilitator names it. */
export const ARC_NETWORK = "eip155:5042002";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const GATEWAY_BATCHING = {
  name: "GatewayWalletBatched",
  version: "1",
  verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
} as const;
/** Seven days plus Circle's buffer: how long a signed payment stays valid. */
export const PAYMENT_VALIDITY_SECONDS = 7 * 24 * 60 * 60 + 100;

export type PaywallKind = "file" | "text" | "api" | "time";

export type PaywallFile = {
  name: string;
  /** Blob name in Mongo / data/paywall-files. Never served directly. */
  stored: string;
  bytes: number;
  sha256: string;
  mime: string;
};

export type Paywall = {
  type: "paywall";
  id: string;
  ownerId: string;
  kind: PaywallKind;
  title: string;
  description?: string;
  priceUsdc: number;
  category: SpendCategory;
  files?: PaywallFile[];
  text?: string;
  api?: { url: string; header?: { name: string; value: string } };
  time?: { minutes: number; note?: string };
  active: boolean;
  createdAt: string;
};

export type PaywallSale = {
  type: "sale";
  id: string;
  paywallId: string;
  ownerId: string;
  /** The paying wallet, as Gateway reported it. */
  payer: string;
  /** Set when the payer is an Evabob agent wallet. */
  buyerAgentId?: string;
  buyerPaymentKey?: string;
  amountUsdc: number;
  /** One use per signed payment. */
  nonce: string;
  status: "held" | "settled" | "not_charged" | "declined" | "expired" | "failed";
  reason?: string;
  settleReference?: string;
  /** A booking's held payment, kept only until it is settled or dropped. */
  held?: { payload: Record<string, unknown>; requirement: PaymentRequirement };
  request?: { message?: string };
  /** What the person sent back when accepting a booking. */
  details?: string;
  payoutId?: string;
  createdAt: string;
  decidedAt?: string;
};

export type PaywallPayout = {
  type: "payout";
  id: string;
  ownerId: string;
  grossUsdc: number;
  feeUsdc: number;
  networkFeeUsdc: number;
  netUsdc: number;
  saleIds: string[];
  status: "sending" | "sent" | "failed";
  transferId?: string;
  txHash?: string;
  error?: string;
  createdAt: string;
};

export type Treasury = { type: "treasury"; walletId: string; address: string; createdAt: string };

type Row = Paywall | PaywallSale | PaywallPayout | Treasury;

export class PaywallError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) {
    super(message);
  }
}

const DATA_PATH = dataPath("paywalls.json");
let rows: Row[] = load();

function load(): Row[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const parsed = JSON.parse(readFileSync(DATA_PATH, "utf8")) as Row[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, rows);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  rows = load();
});

const paywalls = () => rows.filter((r): r is Paywall => r.type === "paywall");
const sales = () => rows.filter((r): r is PaywallSale => r.type === "sale");
const payouts = () => rows.filter((r): r is PaywallPayout => r.type === "payout");

export function getPaywall(id: string): Paywall | null {
  return paywalls().find((p) => p.id === id) ?? null;
}

export function getSale(id: string): PaywallSale | null {
  return sales().find((s) => s.id === id) ?? null;
}

// ─── Links ───────────────────────────────────────────────────────────────

function apiBase(): string {
  return (config.publicApiUrl || `http://localhost:${config.port}`).replace(/\/$/, "");
}

function appBase(): string {
  return (config.appPublicUrl || "https://evabob.app").replace(/\/$/, "");
}

/** The link a person shares. Browsers see a page; software is sent to pay. */
export function paywallUrl(id: string): string {
  return `${appBase()}/x/${id}`;
}

/** Where software pays and fetches. The shared link forwards here. */
export function paywallResourceUrl(id: string): string {
  return `${apiBase()}/x/${id}`;
}

const ID_PATH = /^\/x\/([A-Za-z0-9_-]{8,32})\/?$/;

/**
 * The paywall id when `raw` is one of Evabob's own paywall links, so an
 * Evabob agent paying one is handled here directly rather than over HTTP.
 */
export function evabobPaywallId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const match = ID_PATH.exec(url.pathname);
  if (!match || !getPaywall(match[1]!)) return null;
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const base of [config.publicApiUrl, config.appPublicUrl]) {
    try {
      if (base) hosts.add(new URL(base).hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  return hosts.has(url.hostname.toLowerCase()) ? match[1]! : null;
}

// ─── Creating ────────────────────────────────────────────────────────────

function clean(text: string | undefined, max: number): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

function blobDir(): string {
  const dir = dataPath("paywall-files");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function storeBlob(bytes: Buffer, mime: string): Promise<{ stored: string; sha256: string }> {
  const stored = `paywall_${randomBytes(16).toString("hex")}`;
  const { mongoReady, mongoSaveAvatar } = await import("./mongo.js");
  if (mongoReady()) await mongoSaveAvatar(stored, mime, bytes);
  writeFileSync(resolve(blobDir(), stored), bytes);
  return { stored, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function loadBlob(stored: string): Promise<Buffer | null> {
  const onDisk = resolve(blobDir(), stored);
  if (existsSync(onDisk)) return readFileSync(onDisk);
  try {
    const { mongoLoadAvatar } = await import("./mongo.js");
    const row = await mongoLoadAvatar(stored);
    return row ? row.bytes : null;
  } catch {
    return null;
  }
}

export type NewPaywall = {
  kind: PaywallKind;
  title: string;
  description?: string;
  priceUsdc: number;
  category?: string;
  files?: Array<{ name: string; mime?: string; base64: string }>;
  text?: string;
  api?: { url: string; headerName?: string; headerValue?: string };
  time?: { minutes: number; note?: string };
};

export async function createPaywall(ownerId: string, input: NewPaywall): Promise<Paywall> {
  const owner = store.getUser(ownerId);
  if (!owner?.handle) throw new PaywallError("Pick a username in Profile first. Buyers see who they pay.");
  if (!/^0x[a-fA-F0-9]{40}$/.test(owner.evmAddress || "")) {
    throw new PaywallError("Finish setting up your wallet first, so there is somewhere to pay you.");
  }
  const title = clean(input.title, 80);
  if (!title) throw new PaywallError("Say what you are selling.");
  const theirs = paywalls().filter((p) => p.ownerId === ownerId);
  if (theirs.filter((p) => p.active).length >= MAX_PAYWALLS_PER_PERSON) {
    throw new PaywallError(
      `You have ${MAX_PAYWALLS_PER_PERSON} open paywalls. Close one you no longer use first.`,
      409,
    );
  }
  if (input.kind === "file") {
    const stored = theirs.reduce(
      (n, p) => n + (p.files ?? []).reduce((m, f) => m + f.bytes, 0),
      0,
    );
    const adding = (input.files ?? []).reduce(
      (n, f) => n + Math.floor((f.base64.length * 3) / 4),
      0,
    );
    if (stored + adding > MAX_FILE_BYTES_PER_PERSON) {
      throw new PaywallError("You have reached the storage limit for paywall files.", 409);
    }
  }
  const price = Math.round(input.priceUsdc * 1e6) / 1e6;
  if (!(price >= MIN_PRICE_USDC) || price > MAX_PRICE_USDC) {
    throw new PaywallError(`The price must be between $${MIN_PRICE_USDC} and $${MAX_PRICE_USDC}.`);
  }
  const row: Paywall = {
    type: "paywall",
    id: randomBytes(9).toString("base64url"),
    ownerId,
    kind: input.kind,
    title,
    description: clean(input.description, 500),
    priceUsdc: price,
    category: normalizeCategory(input.category ?? (input.kind === "time" ? "people" : input.kind === "api" ? "tools" : "data")),
    active: true,
    createdAt: new Date().toISOString(),
  };
  if (input.kind === "file") {
    const files = input.files ?? [];
    if (files.length === 0) throw new PaywallError("Add at least one file.");
    if (files.length > MAX_FILES) throw new PaywallError(`Up to ${MAX_FILES} files per link.`);
    const total = files.reduce((n, f) => n + Math.floor((f.base64.length * 3) / 4), 0);
    if (total > MAX_TOTAL_FILE_BYTES) throw new PaywallError("Up to 10 MB of files per link.");
    row.files = [];
    for (const f of files) {
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.length === 0) throw new PaywallError(`${f.name} is empty.`);
      if (bytes.length > MAX_FILE_BYTES) throw new PaywallError(`${f.name} is over 5 MB.`);
      const mime = f.mime || "application/octet-stream";
      const blob = await storeBlob(bytes, mime);
      row.files.push({ name: clean(f.name, 120) || "file", mime, bytes: bytes.length, ...blob });
    }
  } else if (input.kind === "text") {
    const text = (input.text ?? "").trim();
    if (!text) throw new PaywallError("Write what the buyer gets.");
    if (text.length > 100_000) throw new PaywallError("That is too long. Attach it as a file instead.");
    row.text = text;
  } else if (input.kind === "api") {
    const raw = (input.api?.url ?? "").trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PaywallError("That is not a web address.");
    }
    if (url.protocol !== "https:") throw new PaywallError("Your API must be on https.");
    const { validateAgentUrl } = await import("./safe-agent-http.js");
    try {
      validateAgentUrl(url.toString(), [url.origin]);
    } catch (e) {
      throw new PaywallError(e instanceof Error ? e.message : "That address cannot be used.");
    }
    const headerName = clean(input.api?.headerName, 60);
    const headerValue = (input.api?.headerValue ?? "").trim();
    if (headerName && !/^[A-Za-z0-9-]+$/.test(headerName)) throw new PaywallError("That header name is not valid.");
    row.api = {
      url: url.toString(),
      ...(headerName && headerValue ? { header: { name: headerName, value: headerValue.slice(0, 500) } } : {}),
    };
  } else if (input.kind === "time") {
    const minutes = Math.round(input.time?.minutes ?? 60);
    if (minutes < 5 || minutes > 8 * 60) throw new PaywallError("A booking is 5 minutes to 8 hours.");
    row.time = { minutes, note: clean(input.time?.note, 300) };
  } else {
    throw new PaywallError("Unknown kind of link.");
  }
  rows.push(row);
  save();
  // The treasury is created the first time anyone sells, not at startup.
  void ensureTreasury().catch((e) =>
    console.warn("[paywall] treasury not ready:", e instanceof Error ? e.message : e),
  );
  return row;
}

export function setPaywallActive(ownerId: string, id: string, active: boolean): Paywall {
  const row = getPaywall(id);
  if (!row || row.ownerId !== ownerId) throw new PaywallError("No such link", 404);
  row.active = active;
  save();
  return row;
}

// ─── Views ───────────────────────────────────────────────────────────────

function sellerName(ownerId: string) {
  const u = store.getUser(ownerId);
  return { name: u?.displayName || (u?.handle ? `@${u.handle}` : "Someone"), handle: u?.handle ? `@${u.handle}` : "" };
}

export type SellerRecord = {
  /** Paid for, and the content passed its check. */
  delivered: number;
  /** The content failed its check, so nobody was charged. */
  notCharged: number;
  /** Bookings the person declined or did not answer. */
  declined: number;
};

export function paywallSellerRecord(ownerId: string): SellerRecord {
  const mine = sales().filter((s) => s.ownerId === ownerId);
  return {
    delivered: mine.filter((s) => s.status === "settled").length,
    notCharged: mine.filter((s) => s.status === "not_charged" || s.status === "failed").length,
    declined: mine.filter((s) => s.status === "declined" || s.status === "expired").length,
  };
}

/** The person's own list, with what each link has earned. */
export function listPaywallsFor(ownerId: string) {
  return paywalls()
    .filter((p) => p.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => {
      const mine = sales().filter((s) => s.paywallId === p.id);
      const settled = mine.filter((s) => s.status === "settled");
      return {
        ...ownerView(p),
        sales: settled.length,
        earnedUsdc: Number(settled.reduce((n, s) => n + s.amountUsdc, 0).toFixed(6)),
        paidOutUsdc: Number(
          settled.filter((s) => s.payoutId && payoutStatus(s.payoutId) === "sent")
            .reduce((n, s) => n + s.amountUsdc, 0).toFixed(6),
        ),
        bookings: mine
          .filter((s) => s.status === "held")
          .map((s) => ({ id: s.id, message: s.request?.message ?? "", amountUsdc: s.amountUsdc, createdAt: s.createdAt, buyer: buyerLabel(s) })),
      };
    });
}

function payoutStatus(id: string) {
  return payouts().find((p) => p.id === id)?.status;
}

function buyerLabel(sale: PaywallSale): string {
  if (sale.buyerAgentId) {
    const agent = store.getAgentById(sale.buyerAgentId);
    const owner = agent ? store.getUser(agent.userId) : undefined;
    if (agent) return `${agent.label}${owner?.handle ? ` · owned by @${owner.handle}` : ""}`;
  }
  return `${sale.payer.slice(0, 6)}…${sale.payer.slice(-4)}`;
}

/** What the owner sees about a link: everything except their API secret. */
function ownerView(p: Paywall) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description ?? "",
    priceUsdc: p.priceUsdc,
    category: p.category,
    active: p.active,
    createdAt: p.createdAt,
    url: paywallUrl(p.id),
    resourceUrl: paywallResourceUrl(p.id),
    files: (p.files ?? []).map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime, sha256: f.sha256 })),
    api: p.api ? { url: p.api.url, header: p.api.header ? p.api.header.name : null } : null,
    time: p.time ?? null,
  };
}

/** What anyone with the link sees. */
export function publicPaywallView(id: string) {
  const p = getPaywall(id);
  if (!p) return null;
  const seller = sellerName(p.ownerId);
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description ?? "",
    priceUsdc: p.priceUsdc,
    token: "USDC",
    category: p.category,
    active: p.active,
    seller: { ...seller, record: paywallSellerRecord(p.ownerId) },
    files: (p.files ?? []).map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })),
    time: p.time ? { minutes: p.time.minutes } : null,
    resourceUrl: paywallResourceUrl(p.id),
    network: ARC_NETWORK,
    payAfterProof: true,
  };
}

// ─── Treasury ────────────────────────────────────────────────────────────

let treasuryPromise: Promise<Treasury> | null = null;

export function treasury(): Treasury | null {
  return rows.find((r): r is Treasury => r.type === "treasury") ?? null;
}

/** The Circle-held wallet payments land in. Created once. */
export async function ensureTreasury(): Promise<Treasury> {
  const existing = treasury();
  if (existing) return existing;
  if (!treasuryPromise) {
    treasuryPromise = (async () => {
      const { provisionAgentWallet } = await import("./agentWallet.js");
      const wallet = await provisionAgentWallet();
      const row: Treasury = {
        type: "treasury",
        walletId: wallet.walletId,
        address: wallet.address,
        createdAt: new Date().toISOString(),
      };
      rows.push(row);
      save();
      console.log(`[paywall] treasury wallet ${row.address}`);
      return row;
    })().finally(() => {
      treasuryPromise = null;
    });
  }
  return treasuryPromise;
}

// ─── The x402 seller ─────────────────────────────────────────────────────

export type PaymentRequirement = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
};

export function requirementFor(p: Paywall, payTo: string): PaymentRequirement {
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    asset: ARC_USDC,
    amount: String(Math.round(p.priceUsdc * 1e6)),
    payTo,
    maxTimeoutSeconds: PAYMENT_VALIDITY_SECONDS,
    extra: { ...GATEWAY_BATCHING },
  };
}

export type Facilitator = {
  verify(payload: Record<string, unknown>, requirement: PaymentRequirement): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payload: Record<string, unknown>, requirement: PaymentRequirement): Promise<{ success: boolean; errorReason?: string; transaction?: string; payer?: string }>;
};

let facilitator: Facilitator | null = null;

/**
 * Circle Gateway's x402 facilitator, called directly. This is the same pair
 * of requests `BatchFacilitatorClient` in @circle-fin/x402-batching/server
 * makes; that module also needs @x402/evm for its resource-server half,
 * which this server does not use, so the two calls are made here instead.
 */
function circleFacilitator(): Facilitator {
  const base = config.gatewayApiBase.replace(/\/v1\/?$/, "");
  const call = async (path: "verify" | "settle", payload: unknown, requirement: unknown) => {
    const res = await fetch(`${base}/v1/x402/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        { paymentPayload: payload, paymentRequirements: requirement },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const key = path === "verify" ? "isValid" : "success";
    if (data && typeof data === "object" && key in data) return data as Record<string, unknown>;
    throw new Error(`Circle Gateway ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  };
  return {
    verify: async (payload, requirement) =>
      (await call("verify", payload, requirement)) as Awaited<ReturnType<Facilitator["verify"]>>,
    settle: async (payload, requirement) =>
      (await call("settle", payload, requirement)) as Awaited<ReturnType<Facilitator["settle"]>>,
  };
}

async function getFacilitator(): Promise<Facilitator> {
  if (!facilitator) facilitator = circleFacilitator();
  return facilitator;
}

/** Asks Circle to verify a signed payment, and nothing else. */
export async function verifyWithCircle(payload: Record<string, unknown>, requirement: PaymentRequirement) {
  return circleFacilitator().verify(payload, requirement);
}

/** Tests replace Circle's facilitator with a fake. */
export function setFacilitatorForTests(fake: Facilitator | null): void {
  facilitator = fake;
}

export type PaywallResponse = { status: number; headers: Record<string, string>; body: string };

function json(status: number, body: unknown, headers: Record<string, string> = {}): PaywallResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function paymentRequired(p: Paywall, requirement: PaymentRequirement, error = "Payment required"): PaywallResponse {
  const seller = sellerName(p.ownerId);
  const doc = {
    x402Version: 2,
    error,
    resource: {
      url: paywallResourceUrl(p.id),
      description: p.description || p.title,
      mimeType: "application/json",
    },
    accepts: [requirement],
  };
  return json(402, {
    ...doc,
    paywall: {
      title: p.title,
      priceUsdc: p.priceUsdc,
      seller: seller.handle || seller.name,
      kind: p.kind,
      payAfterProof: true,
      note:
        p.kind === "time"
          ? `Nothing is charged until ${seller.handle || seller.name} accepts the booking.`
          : "You are charged only if what comes back is usable.",
    },
  }, { "payment-required": Buffer.from(JSON.stringify(doc)).toString("base64") });
}

function decodePayment(header: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one-use id of a signed payment: its EIP-3009 nonce. */
export function paymentNonce(payload: Record<string, unknown>): string {
  const inner = (payload.payload ?? {}) as Record<string, unknown>;
  const auth = (inner.authorization ?? {}) as Record<string, unknown>;
  if (typeof auth.nonce === "string" && auth.nonce) return auth.nonce.toLowerCase();
  return createHash("sha256").update(JSON.stringify(inner)).digest("hex");
}

/** The buyer paid for exactly what is on offer, to exactly this treasury. */
export function acceptedMatches(payload: Record<string, unknown>, requirement: PaymentRequirement): boolean {
  const a = (payload.accepted ?? {}) as Record<string, unknown>;
  return (
    a.scheme === requirement.scheme &&
    a.network === requirement.network &&
    String(a.asset ?? "").toLowerCase() === requirement.asset.toLowerCase() &&
    String(a.amount ?? "") === requirement.amount &&
    String(a.payTo ?? "").toLowerCase() === requirement.payTo.toLowerCase()
  );
}

async function produce(p: Paywall, query: string): Promise<{ status: number; contentType: string; body: string }> {
  if (p.kind === "text") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ title: p.title, text: p.text ?? "" }) };
  }
  if (p.kind === "file") {
    const files = [];
    for (const f of p.files ?? []) {
      const bytes = await loadBlob(f.stored);
      // A file that cannot be read, or no longer matches what was uploaded,
      // fails the whole delivery: nobody pays for half a dataset.
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== f.sha256) {
        return { status: 500, contentType: "application/json", body: JSON.stringify({ error: `${f.name} could not be read` }) };
      }
      files.push({ name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256, base64: bytes.toString("base64") });
    }
    return { status: 200, contentType: "application/json", body: JSON.stringify({ title: p.title, files }) };
  }
  if (p.kind === "api" && p.api) {
    const upstream = new URL(p.api.url);
    const extra = new URLSearchParams(query);
    for (const [k, v] of extra) upstream.searchParams.append(k, v);
    const { safeAgentGet } = await import("./safe-agent-http.js");
    try {
      const res = await safeAgentGet(upstream.toString(), [upstream.origin],
        p.api.header ? { [p.api.header.name]: p.api.header.value } : {});
      return { status: res.status, contentType: res.headers["content-type"] || "", body: res.text };
    } catch (e) {
      return { status: 502, contentType: "application/json", body: JSON.stringify({ error: e instanceof Error ? e.message : "unreachable" }) };
    }
  }
  return { status: 500, contentType: "application/json", body: JSON.stringify({ error: "nothing to deliver" }) };
}

export type SaleListener = (sale: PaywallSale, verdict: Verdict | null) => void;
const listeners: SaleListener[] = [];

/** x402Pay listens, to finish an Evabob agent's held payment. */
export function onSaleOutcome(fn: SaleListener): void {
  listeners.push(fn);
}

function emit(sale: PaywallSale, verdict: Verdict | null) {
  for (const fn of listeners) {
    try {
      fn(sale, verdict);
    } catch (e) {
      console.warn("[paywall] listener failed", e instanceof Error ? e.message : e);
    }
  }
}

function money(n: number) {
  return `$${n < 1 ? n.toFixed(n < 0.01 ? 3 : 2) : n.toFixed(2)}`;
}

/**
 * One request to a paywall, from anyone: software over HTTP, or an Evabob
 * agent wallet in-process. Without a payment it answers 402 with the terms;
 * with one it verifies, delivers, checks, and only then settles.
 */
export async function handlePaywallRequest(input: {
  id: string;
  query?: string;
  paymentSignature?: string | null;
  buyer?: { agentId: string; paymentKey: string };
  /** A booking request's message to the person. */
  message?: string;
}): Promise<PaywallResponse> {
  const p = getPaywall(input.id);
  if (!p) return json(404, { error: "No such link" });
  if (!p.active) return json(410, { error: "The seller has closed this link" });
  let t: Treasury;
  try {
    t = await ensureTreasury();
  } catch {
    return json(503, { error: "Payments are not available right now. Nothing was charged." });
  }
  const requirement = requirementFor(p, t.address);
  if (!input.paymentSignature) return paymentRequired(p, requirement);

  const payload = decodePayment(input.paymentSignature);
  if (!payload) return json(400, { error: "The payment could not be read" });
  if (!acceptedMatches(payload, requirement)) {
    return paymentRequired(p, requirement, "The payment does not match this link's price or recipient");
  }
  const nonce = paymentNonce(payload);
  if (sales().some((s) => s.nonce === nonce)) {
    return json(409, { error: "This payment has already been used" });
  }

  let verified: Awaited<ReturnType<Facilitator["verify"]>>;
  try {
    verified = await (await getFacilitator()).verify(payload, requirement);
  } catch (e) {
    return json(502, { error: `The payment could not be checked: ${e instanceof Error ? e.message : e}` });
  }
  if (!verified.isValid) {
    return paymentRequired(p, requirement, verified.invalidReason || "The payment was not valid");
  }

  const sale: PaywallSale = {
    type: "sale",
    id: `sale_${randomBytes(9).toString("hex")}`,
    paywallId: p.id,
    ownerId: p.ownerId,
    payer: verified.payer || String(((payload.payload as Record<string, unknown>)?.authorization as Record<string, unknown>)?.from ?? ""),
    ...(input.buyer ? { buyerAgentId: input.buyer.agentId, buyerPaymentKey: input.buyer.paymentKey } : {}),
    amountUsdc: p.priceUsdc,
    nonce,
    status: "held",
    createdAt: new Date().toISOString(),
  };
  rows.push(sale);

  // Time: hold the signed payment, unsettled, until the person answers.
  if (p.kind === "time") {
    sale.held = { payload, requirement };
    sale.request = { message: clean(input.message ?? new URLSearchParams(input.query ?? "").get("message") ?? "", 500) };
    save();
    alertUser(p.ownerId, {
      kind: "paywall_booking",
      title: `Booking request · ${money(p.priceUsdc)}`,
      body: `${buyerLabel(sale)} wants ${p.time?.minutes ?? 60} minutes of your time for "${p.title}". Accept to be paid.`,
      link: `evabob://paywall/${p.id}`,
    });
    return json(202, {
      booking: sale.id,
      status: "waiting_for_seller",
      message: `Nothing is charged until ${sellerName(p.ownerId).handle || "the seller"} accepts. If they decline or do not answer within 48 hours, the payment is dropped.`,
      statusUrl: `${paywallResourceUrl(p.id)}/booking/${sale.id}`,
    });
  }

  const delivered = await produce(p, input.query ?? "");
  const verdict = judgeResponse({ status: delivered.status, contentType: delivered.contentType, body: delivered.body });
  if (!verdict.usable) {
    sale.status = "not_charged";
    sale.reason = verdict.reason;
    sale.decidedAt = new Date().toISOString();
    save();
    emit(sale, verdict);
    return json(502, { error: verdict.reason, charged: false, message: "Nothing was charged." });
  }

  let settled: Awaited<ReturnType<Facilitator["settle"]>>;
  try {
    settled = await (await getFacilitator()).settle(payload, requirement);
  } catch (e) {
    settled = { success: false, errorReason: e instanceof Error ? e.message : String(e) };
  }
  if (!settled.success) {
    sale.status = "failed";
    sale.reason = settled.errorReason || "The payment could not be taken";
    sale.decidedAt = new Date().toISOString();
    save();
    emit(sale, verdict);
    return paymentRequired(p, requirement, sale.reason);
  }
  sale.status = "settled";
  sale.settleReference = settled.transaction;
  sale.decidedAt = new Date().toISOString();
  save();
  emit(sale, verdict);
  alertUser(p.ownerId, {
    kind: "paywall_sale",
    title: `${money(p.priceUsdc)} from ${buyerLabel(sale)}`,
    body: `For "${p.title}". It reaches your balance with your next payout.`,
    link: `evabob://paywall/${p.id}`,
  });
  const receipt = Buffer.from(JSON.stringify({
    success: true,
    transaction: settled.transaction ?? null,
    network: ARC_NETWORK,
    payer: sale.payer,
  })).toString("base64");
  return {
    status: 200,
    headers: { "content-type": delivered.contentType || "application/json", "payment-response": receipt },
    body: delivered.body,
  };
}

/** A booking's state, for whoever made it. Details only once accepted. */
export function bookingStatus(paywallId: string, saleId: string) {
  const sale = getSale(saleId);
  if (!sale || sale.paywallId !== paywallId) return null;
  const status =
    sale.status === "held" ? "waiting_for_seller"
      : sale.status === "settled" ? "accepted"
        : sale.status;
  return {
    booking: sale.id,
    status,
    charged: sale.status === "settled",
    details: sale.status === "settled" ? sale.details ?? "" : undefined,
    reason: sale.reason,
  };
}

export async function answerBooking(
  ownerId: string,
  saleId: string,
  answer: { accept: true; details: string } | { accept: false },
): Promise<PaywallSale> {
  const sale = getSale(saleId);
  if (!sale || sale.ownerId !== ownerId) throw new PaywallError("No such booking", 404);
  if (sale.status !== "held" || !sale.held) throw new PaywallError("That booking has already been answered", 409);
  const p = getPaywall(sale.paywallId);
  if (!answer.accept) {
    sale.status = "declined";
    sale.reason = "The seller declined";
    delete sale.held;
    sale.decidedAt = new Date().toISOString();
    save();
    emit(sale, null);
    return sale;
  }
  const details = (answer.details ?? "").trim();
  if (!details) throw new PaywallError("Say when and where, so the buyer can turn up.");
  let settled: Awaited<ReturnType<Facilitator["settle"]>>;
  try {
    settled = await (await getFacilitator()).settle(sale.held.payload, sale.held.requirement);
  } catch (e) {
    settled = { success: false, errorReason: e instanceof Error ? e.message : String(e) };
  }
  delete sale.held;
  sale.decidedAt = new Date().toISOString();
  if (!settled.success) {
    sale.status = "failed";
    sale.reason = settled.errorReason || "The buyer's payment could not be taken";
    save();
    emit(sale, null);
    throw new PaywallError("The buyer's payment could not be taken, so the booking is off. You have not been committed to anything.", 409);
  }
  sale.status = "settled";
  sale.details = details.slice(0, 1_000);
  sale.settleReference = settled.transaction;
  save();
  emit(sale, { usable: true, reason: "The seller accepted the booking." });
  void p;
  return sale;
}

/** Bookings nobody answered are dropped; the buyer is never charged. */
export function expireBookings(now = Date.now()): number {
  let n = 0;
  for (const sale of sales()) {
    if (sale.status !== "held" || now - Date.parse(sale.createdAt) < BOOKING_ANSWER_MS) continue;
    sale.status = "expired";
    sale.reason = "The seller did not answer in time";
    delete sale.held;
    sale.decidedAt = new Date(now).toISOString();
    emit(sale, null);
    n += 1;
  }
  if (n) save();
  return n;
}

// ─── Payouts ─────────────────────────────────────────────────────────────

/** Which settled sales are due to be paid out, per person. Pure. */
export function duePayouts(all: PaywallSale[], now: number): Map<string, PaywallSale[]> {
  const byOwner = new Map<string, PaywallSale[]>();
  for (const s of all) {
    if (s.status !== "settled" || s.payoutId) continue;
    byOwner.set(s.ownerId, [...(byOwner.get(s.ownerId) ?? []), s]);
  }
  const due = new Map<string, PaywallSale[]>();
  for (const [owner, list] of byOwner) {
    const gross = list.reduce((n, s) => n + s.amountUsdc, 0);
    const oldest = Math.min(...list.map((s) => Date.parse(s.decidedAt ?? s.createdAt)));
    const worthSending = gross > PAYOUT_NETWORK_FEE_USDC * 2;
    if (gross >= PAYOUT_MIN_USDC || (worthSending && now - oldest >= PAYOUT_AFTER_MS)) due.set(owner, list);
  }
  return due;
}

export async function runPaywallPayouts(now = Date.now()): Promise<{ paid: number; errors: string[] }> {
  const errors: string[] = [];
  let paid = 0;
  const t = treasury();
  if (!t) return { paid, errors };
  // Finish payouts whose mint was not confirmed when they were sent.
  for (const payout of payouts().filter((x) => x.status === "sending" && x.transferId && !x.txHash)) {
    try {
      const { pollGatewayTransfer } = await import("./gateway-e2e.js");
      const polled = await pollGatewayTransfer(payout.transferId!, { timeoutMs: 5_000 });
      if (polled.mintTx) finishPayout(payout, polled.mintTx);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const due = duePayouts(sales(), now);
  if (due.size === 0) return { paid, errors };
  const { fetchGatewayBalances } = await import("./gateway.js");
  let available: number;
  try {
    available = (await fetchGatewayBalances(t.address as `0x${string}`)).totalUsdc;
  } catch (e) {
    return { paid, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const { feeUnitsFor, toUnits, platformFeeSettings } = await import("./platformFee.js");
  for (const [ownerId, list] of due) {
    const owner = store.getUser(ownerId);
    if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner.evmAddress || "")) continue;
    const grossUnits = list.reduce((n, s) => n + toUnits(s.amountUsdc), 0n);
    const feeUnits = feeUnitsFor(grossUnits);
    const networkUnits = toUnits(PAYOUT_NETWORK_FEE_USDC);
    const netUnits = grossUnits - feeUnits - networkUnits;
    if (netUnits <= 0n) continue;
    const gross = Number(grossUnits) / 1e6;
    // Gateway credits a seller once its batch settles; wait for it.
    if (available + 1e-9 < gross) continue;
    const payout: PaywallPayout = {
      type: "payout",
      id: `po_${randomBytes(9).toString("hex")}`,
      ownerId,
      grossUsdc: gross,
      feeUsdc: Number(feeUnits) / 1e6,
      networkFeeUsdc: PAYOUT_NETWORK_FEE_USDC,
      netUsdc: Number(netUnits) / 1e6,
      saleIds: list.map((s) => s.id),
      status: "sending",
      createdAt: new Date(now).toISOString(),
    };
    for (const s of list) s.payoutId = payout.id;
    rows.push(payout);
    save();
    try {
      const { submitGatewayBurnTransfer } = await import("./gateway-e2e.js");
      const { circleGatewayBurnSigner } = await import("./agentWallet.js");
      const fee = platformFeeSettings();
      const result = await submitGatewayBurnTransfer({
        amountUsdc: payout.netUsdc,
        destinationDomain: 26,
        destinationAddress: owner.evmAddress,
        sourceDepositor: t.address as Address,
        signerAccount: circleGatewayBurnSigner({ walletId: t.walletId, address: t.address as Address }),
        sourceDomain: 26,
        sources: [{ domain: 26, amountUsdc: 0, raw: netUnits + feeUnits }],
        ...(feeUnits > 0n && fee.recipient ? { platformFee: { units: feeUnits, recipient: fee.recipient as Address } } : {}),
        enableForwarder: false,
      });
      payout.transferId = result.transferId;
      available -= gross;
      if (result.mintTx) finishPayout(payout, result.mintTx);
      else save();
      paid += 1;
    } catch (e) {
      // Nothing was sent: free the sales for the next attempt.
      payout.status = "failed";
      payout.error = e instanceof Error ? e.message : String(e);
      for (const s of list) delete s.payoutId;
      save();
      errors.push(payout.error);
    }
  }
  return { paid, errors };
}

function finishPayout(payout: PaywallPayout, txHash: string) {
  payout.status = "sent";
  payout.txHash = txHash;
  save();
  const titles = [...new Set(payout.saleIds
    .map((id) => getSale(id)?.paywallId)
    .map((id) => (id ? getPaywall(id)?.title : undefined))
    .filter((t): t is string => Boolean(t)))];
  if (!store.hasActivityTxHash(payout.ownerId, txHash, "paywall_payout")) {
    store.addActivity({
      userId: payout.ownerId,
      kind: "receive",
      title: "Paid by agents",
      description: `For ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? " and more" : ""}`,
      amountUsdc: payout.netUsdc,
      token: "USDC",
      amountToken: payout.netUsdc,
      platformFee: payout.feeUsdc,
      platformFeeToken: "USDC",
      counterparty: "Evabob paywall",
      txHash,
      mode: "paywall_payout",
      status: "completed",
      settlementVerified: true,
    });
  }
  alertUser(payout.ownerId, {
    kind: "money_in",
    title: `${money(payout.netUsdc)} from agents`,
    body: `Paid out for ${titles.slice(0, 2).join(", ") || "your paywalls"}.`,
    amountUsdc: payout.netUsdc,
    token: "USDC",
    txHash,
    moneyIn: true,
  });
}

/** Sales for one paywall, newest first, for the owner. */
export function salesFor(ownerId: string, paywallId: string) {
  return sales()
    .filter((s) => s.ownerId === ownerId && s.paywallId === paywallId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100)
    .map((s) => ({
      id: s.id,
      status: s.status,
      amountUsdc: s.amountUsdc,
      buyer: buyerLabel(s),
      reason: s.reason ?? null,
      message: s.request?.message ?? null,
      paidOut: s.payoutId ? payoutStatus(s.payoutId) === "sent" : false,
      createdAt: s.createdAt,
    }));
}

/** Every open paywall, as anyone sees it: the Evabob half of the marketplace. */
export function listPublicPaywalls() {
  return paywalls()
    .filter((p) => p.active)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map((p) => publicPaywallView(p.id)!)
    .filter(Boolean);
}
