/**
 * Reminds people about invoices around their due date, so the person owed
 * money does not have to chase it.
 *
 * The payer hears the day before, on the day, and once more three days late.
 * The person who sent the invoice is told when it goes overdue, so they know
 * it has been chased. Only invoices with a known payer (a chat invoice, or one
 * addressed to someone) are chased; an open link has no one to remind.
 */

import { store } from "../store/db.js";
import { alertUser } from "./notifyUser.js";
import { takeDueInvoiceReminders, type InvoiceReminder, type PaymentRequest } from "./payment-requests.js";

function money(inv: PaymentRequest): string {
  const symbol = (inv.token || "USDC").toUpperCase() === "EURC" ? "€" : "$";
  const left = Math.max(0, inv.total - (inv.instantPaidUsdc ?? 0) - (inv.escrowLockedUsdc ?? 0));
  return `${symbol}${(inv.status === "partial" ? left : inv.total).toFixed(2)}`;
}

function name(userId: string | undefined): string {
  const u = userId ? store.getUser(userId) : undefined;
  return u?.handle ? `@${u.handle}` : u?.displayName || "Someone";
}

const PAYER_COPY: Record<InvoiceReminder, (from: string, amount: string, what: string) => { title: string; body: string }> = {
  before: (from, amount, what) => ({
    title: "Invoice due tomorrow",
    body: `${amount} to ${from} for ${what} is due tomorrow.`,
  }),
  due: (from, amount, what) => ({
    title: "Invoice due today",
    body: `${amount} to ${from} for ${what} is due today.`,
  }),
  overdue: (from, amount, what) => ({
    title: "Invoice overdue",
    body: `${amount} to ${from} for ${what} was due 3 days ago.`,
  }),
};

export function sendInvoiceReminders(now = Date.now()): { reminded: number } {
  let reminded = 0;
  for (const { invoice, kind } of takeDueInvoiceReminders(now)) {
    const issuerId = invoice.senderId || invoice.userId;
    const what = invoice.description || "your invoice";
    const link = invoice.link;
    if (invoice.receiverId) {
      alertUser(invoice.receiverId, {
        kind: "invoice_due",
        ...PAYER_COPY[kind](name(issuerId), money(invoice), what),
        link,
      });
      reminded += 1;
    }
    if (kind === "overdue") {
      alertUser(issuerId, {
        kind: "invoice_due",
        title: "Invoice overdue",
        body: invoice.receiverId
          ? `${name(invoice.receiverId)} has not paid ${money(invoice)} for ${what}. We have reminded them.`
          : `${money(invoice)} for ${what} is 3 days overdue. Share the link again to chase it.`,
        link,
      });
    }
  }
  return { reminded };
}
