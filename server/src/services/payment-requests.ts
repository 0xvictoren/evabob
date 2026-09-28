/**
 * Chat invoices + payment-request links.
 *
 * Line items live on the invoice. Escrow jobs are linked separately
 * (`escrowJobId`) — this module never releases funds.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dirname } from "node:path";
import { config } from "../config.js";
import { dataPath } from "../utils/data-path.js";
import { markPrimaryStoreDirty } from "./primary-store.js";

export type InvoiceItem = {
  id: string;
  description: string;
  amount: number;
};

/** How the receiver is allowed / chooses to pay. */
export type InvoicePaymentStructure = "full" | "split" | "escrow" | "milestones";

export type InvoiceStatus =
  | "open"
  | "paid"
  | "partial"
  | "escrow"
  | "released"
  | "refunded"
  | "cancelled"
  | "expired"
  /** The person it was sent to said no. Closes the request for everyone. */
  | "declined";

export type PaymentRequest = {
  id: string;
  /** Issuer (who created the invoice). */
  userId: string;
  senderId?: string;
  receiverId?: string;
  receiverHandle?: string;
  threadId?: string;
  items: InvoiceItem[];
  subtotal: number;
  /** Always equals subtotal today (no tax/fees). */
  total: number;
  amount: number;
  token: string;
  description: string;
  note?: string;
  allowedStructures: InvoicePaymentStructure[];
  chosenStructure?: InvoicePaymentStructure;
  status: InvoiceStatus;
  escrowJobId?: string;
  instantPaidUsdc?: number;
  escrowLockedUsdc?: number;
  /**
   * Who settled it, when, and the transaction that did it.
   *
   * Without these an invoice could say "paid" and nothing else — no payer,
   * no date, nothing to check against the chain. A receipt that cannot be
   * verified is decoration.
   */
  paidBy?: string;
  paidByLabel?: string;
  paidTxHash?: string;
  escrowTxHash?: string;
  /** The transaction that paid part of it ("Pay half, hold half"). */
  partialTxHash?: string;
  link: string;
  shareUrl: string;
  createdAt: string;
  paidAt?: string;
  expiresAt?: string;
  declinedBy?: string;
  declinedAt?: string;
  /**
   * When payment is due. The payer is reminded the day before, on the day,
   * and once more three days late; the issuer is told when it goes overdue.
   */
  dueAt?: string;
  reminders?: { beforeAt?: string; dueAt?: string; overdueAt?: string };
  /**
   * Paid by milestone: one hold per line item, each released on its own as
   * that part of the work is delivered.
   */
  milestoneTransferIds?: string[];
  /**
   * The amount as its creator typed it, in their own currency. Money is
   * always the dollar `total`; this is only so someone who asked for ₦2,500
   * sees ₦2,500 — not ₦2,500 converted to dollars and back — and so the
   * payer's app can show it in theirs.
   */
  display?: RequestDisplay;
};

export type RequestDisplay = { currency: "NGN" | "USD"; amount: number };

/** "₦2,500.00" when it was asked for in naira, else "$1.80" / "€1.80". */
export function requestAmountLabel(inv: Pick<PaymentRequest, "display" | "total" | "token">): string {
  const two = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (inv.display?.currency === "NGN") return `₦${two(inv.display.amount)}`;
  const symbol = (inv.token || "USDC").toUpperCase() === "EURC" ? "€" : "$";
  return `${symbol}${two(inv.total)}`;
}

export type Invoice = PaymentRequest;

const DATA_PATH = dataPath("payment-requests.json");

function load(): PaymentRequest[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8")) as PaymentRequest[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(rows: PaymentRequest[]) {
  // Settlement hashes are replay records. Dropping old invoices makes an old
  // payment proof reusable, so retention must be handled by archival storage.
  writeJsonAtomic(DATA_PATH, rows);
  markPrimaryStoreDirty();
}

function publicBase(): string {
  // Payment recipients belong on the public web app, never the API origin.
  const base = config.appPublicUrl || process.env.PUBLIC_URL || "https://evabob.app";
  return base.replace(/\/$/, "");
}

function normalizeItems(
  items: Array<{ description?: string; amount?: number }> | undefined,
  fallbackAmount: number,
  fallbackDescription: string,
): InvoiceItem[] {
  const cleaned = (items || [])
    .map((it) => ({
      id: randomUUID(),
      description: String(it.description || "").trim() || "Item",
      amount: Number(it.amount),
    }))
    .filter((it) => Number.isFinite(it.amount) && it.amount > 0);
  if (cleaned.length > 0) return cleaned;
  if (fallbackAmount > 0) {
    return [
      {
        id: randomUUID(),
        description: fallbackDescription || "Invoice",
        amount: fallbackAmount,
      },
    ];
  }
  return [];
}

function hydrate(row: PaymentRequest): PaymentRequest {
  const items =
    Array.isArray(row.items) && row.items.length > 0
      ? row.items
      : normalizeItems(undefined, row.amount || 0, row.description || "");
  const subtotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  return {
    ...row,
    items,
    subtotal: row.subtotal ?? subtotal,
    total: row.total ?? row.amount ?? subtotal,
    amount: row.amount ?? subtotal,
    senderId: row.senderId || row.userId,
    allowedStructures:
      row.allowedStructures && row.allowedStructures.length > 0
        ? row.allowedStructures
        : (["full", "split", "escrow"] as InvoicePaymentStructure[]),
  };
}

function loadHydrated(): PaymentRequest[] {
  return load().map(hydrate);
}

export function createInvoice(input: {
  userId: string;
  items?: Array<{ description?: string; amount?: number }>;
  amount?: number;
  token?: string;
  description?: string;
  note?: string;
  threadId?: string;
  receiverId?: string;
  receiverHandle?: string;
  allowedStructures?: InvoicePaymentStructure[];
  expiresInMs?: number;
  /** ISO time payment is due. */
  dueAt?: string;
  /** Let the payer hold one payment per line item, released as each is delivered. */
  milestones?: boolean;
  display?: RequestDisplay;
}): PaymentRequest {
  const description = input.description?.trim() || input.note?.trim() || "";
  const items = normalizeItems(input.items, input.amount || 0, description);
  const total = items.reduce((s, it) => s + it.amount, 0);
  if (!(total > 0)) throw new Error("Invoice needs at least one priced item");
  if (input.milestones && (items.length < 2 || items.length > 10)) {
    throw new Error("Milestones need 2 to 10 priced lines, one per milestone");
  }
  const dueMs = input.dueAt ? Date.parse(input.dueAt) : NaN;
  if (input.dueAt && (!Number.isFinite(dueMs) || dueMs < Date.now() - 60_000)) {
    throw new Error("The due date must be in the future");
  }

  const allowed =
    input.allowedStructures && input.allowedStructures.length > 0
      ? input.allowedStructures
      : input.milestones
        ? (["full", "milestones"] as InvoicePaymentStructure[])
        : (["full", "split", "escrow"] as InvoicePaymentStructure[]);

  const id = randomUUID();
  const token = (input.token || "USDC").toUpperCase();
  const now = Date.now();
  const row: PaymentRequest = {
    id,
    userId: input.userId,
    senderId: input.userId,
    receiverId: input.receiverId,
    receiverHandle: input.receiverHandle,
    threadId: input.threadId,
    items,
    subtotal: total,
    total,
    amount: total,
    token,
    description: description || items.map((i) => i.description).join(", "),
    ...(input.display && input.display.amount > 0 ? { display: input.display } : {}),
    note: input.note?.trim() || "",
    allowedStructures: allowed,
    status: "open",
    link: `evabob://pay/${id}`,
    shareUrl: `${publicBase()}/pay/${id}`,
    createdAt: new Date(now).toISOString(),
    // A request with a due date stays payable well past it, so a late payer
    // can still pay after the overdue reminder.
    expiresAt: new Date(
      Math.max(
        now + (input.expiresInMs ?? 7 * 24 * 60 * 60 * 1000),
        Number.isFinite(dueMs) ? dueMs + 30 * 24 * 60 * 60 * 1000 : 0,
      ),
    ).toISOString(),
    ...(Number.isFinite(dueMs) ? { dueAt: new Date(dueMs).toISOString() } : {}),
  };
  const all = loadHydrated();
  all.unshift(row);
  save(all);
  return row;
}

/** Legacy single-amount payment request (one line item). */
export function createPaymentRequest(input: {
  userId: string;
  amount: number;
  items?: Array<{ description?: string; amount?: number }>;
  token?: string;
  description?: string;
  note?: string;
  threadId?: string;
  receiverId?: string;
  receiverHandle?: string;
  dueAt?: string;
  milestones?: boolean;
  display?: RequestDisplay;
}): PaymentRequest {
  return createInvoice(input);
}

export function listPaymentRequests(userId: string): PaymentRequest[] {
  return listInvoicesForUser(userId)
    .filter((r) => r.role === "sent")
    .map((r) => r.invoice);
}

export function listInvoicesForUser(userId: string): Array<{
  invoice: PaymentRequest;
  role: "sent" | "received";
}> {
  const uid = userId.toLowerCase();
  return loadHydrated()
    .filter((r) => {
      const sender = (r.senderId || r.userId || "").toLowerCase();
      const receiver = (r.receiverId || "").toLowerCase();
      return sender === uid || receiver === uid;
    })
    .map((invoice) => ({
      invoice,
      role:
        (invoice.senderId || invoice.userId || "").toLowerCase() === uid
          ? ("sent" as const)
          : ("received" as const),
    }));
}

export function getPaymentRequest(id: string): PaymentRequest | undefined {
  const row = load().find((r) => r.id === id);
  return row ? hydrate(row) : undefined;
}

const TERMINAL: InvoiceStatus[] = [
  "paid",
  "released",
  "refunded",
  "cancelled",
  "expired",
  "declined",
];

/** Raised when someone tries to change an invoice that is not theirs to change. */
export class InvoicePermissionError extends Error {
  readonly code = "INVOICE_FORBIDDEN";
  constructor(message: string) {
    super(message);
    this.name = "InvoicePermissionError";
  }
}

/**
 * Who may move an invoice to `status`.
 *
 * The actor used to be accepted and ignored — the parameter was named
 * `_userId`. Any signed-in caller could mark a stranger's invoice paid, and
 * the route then rewrites the chat bubble to "Request · paid", so the creator
 * is told they were paid when nothing moved. Marking `cancelled` was an
 * equally free way to kill someone else's request.
 *
 * Cancelling is the creator's decision alone. Paying is the payer's, so it is
 * allowed for the creator or the named receiver — and, when an invoice names
 * no receiver, for anyone holding the link, because that is what a payment
 * link is for.
 */
function assertMayMark(
  invoice: PaymentRequest,
  status: PaymentRequest["status"],
  actorId: string | undefined,
): void {
  const owner = invoice.senderId || invoice.userId;
  const isOwner = Boolean(actorId && actorId === owner);

  if (status === "cancelled") {
    if (!isOwner) {
      throw new InvoicePermissionError(
        "Only the person who created this request can cancel it.",
      );
    }
    return;
  }

  if (status === "open") {
    if (!isOwner) {
      throw new InvoicePermissionError(
        "Only the person who created this request can reopen it.",
      );
    }
    return;
  }

  if (status === "paid" || status === "escrow" || status === "partial") {
    // An invoice with no named receiver is a shareable link: whoever holds it
    // may pay. One addressed to somebody is only theirs (or the creator's).
    if (!invoice.receiverId) return;
    const isReceiver = Boolean(actorId && actorId === invoice.receiverId);
    if (!isOwner && !isReceiver) {
      throw new InvoicePermissionError(
        "This request was addressed to someone else.",
      );
    }
  }
}

export function markPaymentRequest(
  id: string,
  status: PaymentRequest["status"],
  actorId?: string,
  extra?: Partial<
    Pick<
      PaymentRequest,
      | "chosenStructure"
      | "escrowJobId"
      | "instantPaidUsdc"
      | "escrowLockedUsdc"
      | "paidBy"
      | "paidByLabel"
      | "paidAt"
      | "paidTxHash"
      | "escrowTxHash"
      | "partialTxHash"
      | "milestoneTransferIds"
    >
  >,
): PaymentRequest | null {
  const all = load();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const current = hydrate(all[i]);
  assertMayMark(current, status, actorId);
  for (const hash of [extra?.paidTxHash, extra?.escrowTxHash, extra?.partialTxHash]) {
    if (!hash) continue;
    const needle = hash.toLowerCase();
    const used = all.some((request, index) => index !== i &&
      [request.paidTxHash, request.escrowTxHash, request.partialTxHash]
        .some(existing => existing?.toLowerCase() === needle));
    if (used) throw new Error("Transaction is already attached to another invoice");
  }
  if (TERMINAL.includes(current.status) && status === "open") {
    throw new Error(`Invoice is already ${current.status} — cannot reopen it`);
  }
  if (
    TERMINAL.includes(current.status) &&
    (status === "paid" || status === "escrow" || status === "partial")
  ) {
    return current;
  }
  if (status === "paid" || status === "escrow" || status === "partial") {
    if (current.status !== "open" && current.status !== status && current.status !== "partial") {
      throw new Error(
        `Invoice is already ${current.status} — cannot mark ${status}`,
      );
    }
  }
  all[i] = hydrate({
    ...current,
    ...extra,
    status,
    paidAt:
      status === "paid" || status === "escrow" || status === "partial"
        ? new Date().toISOString()
        : current.paidAt,
  });
  save(all);
  return all[i];
}

/**
 * What is still owed on a request. After "Pay half, hold half" paid only its
 * first half, this is the rest — so the payer is asked for that, not the
 * whole amount again.
 */
export function requestRemaining(inv: Pick<PaymentRequest, "status" | "total" | "instantPaidUsdc">): number {
  if (inv.status !== "partial") return inv.total;
  const paid = inv.instantPaidUsdc ?? 0;
  return Math.max(0, Math.round((inv.total - paid) * 1_000_000) / 1_000_000);
}

/** Chat card payload — keep this shape stable. */
export function invoiceChatMeta(inv: PaymentRequest): Record<string, unknown> {
  return {
    type: "invoice",
    kind: "invoice",
    invoiceId: inv.id,
    requestId: inv.id,
    items: inv.items,
    subtotal: inv.subtotal,
    total: inv.total,
    amount: inv.total,
    amountUsdc: inv.token === "USDC" ? inv.total : null,
    token: inv.token,
    display: inv.display ?? null,
    description: inv.description,
    note: inv.note || "",
    allowedStructures: inv.allowedStructures,
    status: inv.status,
    senderId: inv.senderId || inv.userId,
    sender: inv.senderId || inv.userId,
    receiver: inv.receiverHandle || inv.receiverId || null,
    threadId: inv.threadId || null,
    escrowJobId: inv.escrowJobId || null,
    chosenStructure: inv.chosenStructure || null,
    paidTxHash: inv.paidTxHash || null,
    escrowTxHash: inv.escrowTxHash || null,
    instantPaidUsdc: inv.instantPaidUsdc ?? null,
    remaining: requestRemaining(inv),
    paidBy: inv.paidBy || null,
    paidByLabel: inv.paidByLabel || null,
    paidAt: inv.paidAt || null,
    expiresAt: inv.expiresAt || null,
    dueAt: inv.dueAt || null,
    milestoneTransferIds: inv.milestoneTransferIds || null,
    link: inv.link,
  };
}

/**
 * Addresses a request to someone, when it is shared with them in a chat. A
 * request that already names someone else keeps its payer.
 */
export function assignInvoiceReceiver(
  id: string,
  receiver: { id: string; handle?: string },
  threadId?: string,
): PaymentRequest | null {
  const all = load();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const row = all[i]!;
  if (row.receiverId && row.receiverId !== receiver.id) return hydrate(row);
  all[i] = {
    ...row,
    receiverId: receiver.id,
    receiverHandle: row.receiverHandle || (receiver.handle ? `@${receiver.handle}` : undefined),
    threadId: row.threadId || threadId,
  };
  save(all);
  return hydrate(all[i]!);
}

/** The person a request was sent to says no. Only they may; it closes the request. */
export function declineInvoice(id: string, userId: string): PaymentRequest {
  const all = load();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) throw new InvoicePermissionError("No such request.");
  const row = hydrate(all[i]!);
  const issuer = row.senderId || row.userId;
  if (issuer === userId) {
    throw new InvoicePermissionError("You sent this request — cancel it instead.");
  }
  if (row.receiverId && row.receiverId !== userId) {
    throw new InvoicePermissionError("This request was sent to someone else.");
  }
  if (row.status !== "open") {
    throw new InvoicePermissionError(`This request is already ${row.status}.`);
  }
  all[i] = { ...row, status: "declined", declinedBy: userId, declinedAt: new Date().toISOString() };
  save(all);
  return all[i]!;
}

/** Plain words for where a request stands, for its card. */
export function invoiceStatusLabel(inv: PaymentRequest): string {
  const open =
    inv.status === "open" && inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()
      ? "expired"
      : inv.status;
  return (
    {
      open: "Request · unpaid",
      partial: "Request · part paid",
      paid: "Request · paid",
      escrow: "Request · money set aside",
      released: "Request · paid",
      refunded: "Request · refunded",
      cancelled: "Request · cancelled",
      expired: "Request · expired",
      declined: "Request · declined",
    } as Record<string, string>
  )[open] ?? `Request · ${open}`;
}

/**
 * What a chat card shows for a request: every line, the total, and where it
 * stands. Written by the server from the request itself, so a card in a chat
 * cannot be made up by whoever posted it.
 */
export function invoiceCardMeta(inv: PaymentRequest): Record<string, unknown> {
  return {
    ...invoiceChatMeta(inv),
    type: "invoice_card",
    kind: "payment_request",
    rawStatus: inv.status,
    status: invoiceStatusLabel(inv),
    open: inv.status === "open" && !(inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()),
    issuerId: inv.senderId || inv.userId,
    receiverId: inv.receiverId || null,
    items: inv.items.map((it) => ({ description: it.description, amount: it.amount })),
  };
}

/** Request ids named by pay links in a message (evabob://pay/… or …/pay/…). */
export function payLinkIds(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:evabob:\/\/pay\/|\/pay\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const m of text.matchAll(re)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export type InvoiceReminder = "before" | "due" | "overdue";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which due-date reminder this invoice needs now, if any. Pure. At most one
 * per call, and each only once: the day before, on the day, three days late.
 */
export function reminderDue(inv: PaymentRequest, now: number): InvoiceReminder | null {
  if (!inv.dueAt || !(inv.status === "open" || inv.status === "partial")) return null;
  const due = Date.parse(inv.dueAt);
  if (!Number.isFinite(due)) return null;
  const sent = inv.reminders ?? {};
  if (now >= due + 3 * DAY_MS) return sent.overdueAt ? null : "overdue";
  if (now >= due) return sent.dueAt ? null : "due";
  if (now >= due - DAY_MS) return sent.beforeAt || sent.dueAt ? null : "before";
  return null;
}

/**
 * Invoices that need a reminder now, marked as reminded. The caller sends
 * them; marking first means a crash can skip a reminder but never repeat one.
 */
export function takeDueInvoiceReminders(now = Date.now()): Array<{
  invoice: PaymentRequest;
  kind: InvoiceReminder;
}> {
  const all = loadHydrated();
  const out: Array<{ invoice: PaymentRequest; kind: InvoiceReminder }> = [];
  for (let i = 0; i < all.length; i++) {
    const kind = reminderDue(all[i], now);
    if (!kind) continue;
    const at = new Date(now).toISOString();
    const key = kind === "before" ? "beforeAt" : kind === "due" ? "dueAt" : "overdueAt";
    all[i] = { ...all[i], reminders: { ...all[i].reminders, [key]: at } };
    out.push({ invoice: all[i], kind });
  }
  if (out.length) save(all);
  return out;
}

export function expireOpenInvoices(now = Date.now()): PaymentRequest[] {
  const all = loadHydrated();
  const expired: PaymentRequest[] = [];
  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    if (row.status !== "open" || !row.expiresAt) continue;
    if (new Date(row.expiresAt).getTime() > now) continue;
    all[i] = { ...row, status: "expired" };
    expired.push(all[i]);
  }
  if (expired.length) save(all);
  return expired;
}
