/**
 * Who may change an invoice.
 *
 * `markPaymentRequest` used to take the actor as `_userId` and ignore it, so
 * any signed-in caller could mark a stranger's invoice paid — and the route
 * then rewrote the chat bubble to "Request · paid", telling the creator they
 * had been paid when nothing moved. Cancelling someone else's request was
 * equally free.
 *
 * These run against a temp working directory: the store resolves its file
 * from process.cwd(), and an earlier test in this repo wrote rows into the
 * real database as a side effect.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-invoices-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const {
  createInvoice,
  markPaymentRequest,
  InvoicePermissionError,
} = await import("./payment-requests.js");

before(() => process.chdir(scratch));
after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows refuses to unlink a file the store still holds open, and only
    // when other suites in the same run have it warm. A stray temp directory
    // is not worth turning a green suite red.
  }
});

const OWNER = "invoice-owner";
const PAYER = "invoice-payer";
const STRANGER = "invoice-stranger";

const addressed = () =>
  createInvoice({
    userId: OWNER,
    receiverId: PAYER,
    items: [{ description: "work", amount: 10 }],
  });

const openLink = () =>
  createInvoice({ userId: OWNER, items: [{ description: "work", amount: 10 }] });

describe("invoice permissions", () => {
  it("lets the named payer pay", () => {
    const inv = addressed();
    assert.equal(markPaymentRequest(inv.id, "paid", PAYER)?.status, "paid");
  });

  it("lets the creator record payment", () => {
    const inv = addressed();
    assert.equal(markPaymentRequest(inv.id, "paid", OWNER)?.status, "paid");
  });

  it("refuses a stranger marking an addressed invoice paid", () => {
    const inv = addressed();
    assert.throws(
      () => markPaymentRequest(inv.id, "paid", STRANGER),
      InvoicePermissionError,
    );
    // and it stays open
    assert.equal(markPaymentRequest(inv.id, "paid", PAYER)?.status, "paid");
  });

  it("refuses a stranger marking escrow", () => {
    const inv = addressed();
    assert.throws(
      () => markPaymentRequest(inv.id, "escrow", STRANGER),
      InvoicePermissionError,
    );
  });

  it("still lets anyone with the link pay an unaddressed invoice", () => {
    // A request with no named receiver is a shareable payment link.
    const inv = openLink();
    assert.equal(markPaymentRequest(inv.id, "paid", STRANGER)?.status, "paid");
  });

  it("only the creator may cancel", () => {
    const mine = openLink();
    assert.throws(
      () => markPaymentRequest(mine.id, "cancelled", STRANGER),
      InvoicePermissionError,
    );
    assert.equal(
      markPaymentRequest(mine.id, "cancelled", OWNER)?.status,
      "cancelled",
    );
  });

  it("refuses cancellation even by the named payer", () => {
    const inv = addressed();
    assert.throws(
      () => markPaymentRequest(inv.id, "cancelled", PAYER),
      InvoicePermissionError,
    );
  });

  it("returns null for an unknown invoice rather than throwing", () => {
    assert.equal(markPaymentRequest("no-such-invoice", "paid", OWNER), null);
  });

  it("does not let one transaction settle two invoices", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const first = addressed();
    const second = addressed();
    markPaymentRequest(first.id, "paid", PAYER, { paidTxHash: hash });
    assert.throws(
      () => markPaymentRequest(second.id, "paid", PAYER, { paidTxHash: hash }),
      /already attached to another invoice/,
    );
  });

  it("does not reopen a terminal invoice", () => {
    const invoice = addressed();
    markPaymentRequest(invoice.id, "paid", PAYER);
    assert.throws(
      () => markPaymentRequest(invoice.id, "open", OWNER),
      /cannot reopen/,
    );
  });
});

describe("due dates and milestones", async () => {
  const { reminderDue, takeDueInvoiceReminders } = await import("./payment-requests.js");
  const DAY = 24 * 60 * 60 * 1000;

  it("reminds the day before, on the day, and three days late — once each", () => {
    const now = Date.now();
    const due = now + 5 * DAY;
    const inv = createInvoice({ userId: "issuer-due", amount: 40, description: "Logo", dueAt: new Date(due).toISOString(), receiverId: "payer-due" });
    assert.equal(reminderDue(inv, due - 2 * DAY), null);
    assert.equal(reminderDue(inv, due - 12 * 60 * 60 * 1000), "before");
    assert.equal(reminderDue(inv, due + 60_000), "due");
    assert.equal(reminderDue(inv, due + 4 * DAY), "overdue");
    // It stays payable well after the due date.
    assert.ok(Date.parse(inv.expiresAt!) > due + 20 * DAY);

    const first = takeDueInvoiceReminders(due - 60_000).filter((r) => r.invoice.id === inv.id);
    assert.deepEqual(first.map((r) => r.kind), ["before"]);
    assert.equal(takeDueInvoiceReminders(due - 30_000).filter((r) => r.invoice.id === inv.id).length, 0);
    assert.deepEqual(takeDueInvoiceReminders(due + 60_000).filter((r) => r.invoice.id === inv.id).map((r) => r.kind), ["due"]);
    assert.deepEqual(takeDueInvoiceReminders(due + 4 * DAY).filter((r) => r.invoice.id === inv.id).map((r) => r.kind), ["overdue"]);
    assert.equal(takeDueInvoiceReminders(due + 9 * DAY).filter((r) => r.invoice.id === inv.id).length, 0);
  });

  it("does not chase paid invoices or past due dates at creation", () => {
    const inv = createInvoice({ userId: "issuer-due", amount: 10, description: "x", dueAt: new Date(Date.now() + DAY).toISOString() });
    assert.equal(reminderDue({ ...inv, status: "paid" }, Date.now() + 2 * DAY), null);
    assert.throws(() => createInvoice({ userId: "issuer-due", amount: 10, dueAt: new Date(Date.now() - DAY).toISOString() }));
  });

  it("offers milestones only for 2 to 10 priced lines", () => {
    const inv = createInvoice({
      userId: "issuer-ms",
      items: [{ description: "Design", amount: 100 }, { description: "Build", amount: 200 }],
      milestones: true,
    });
    assert.deepEqual(inv.allowedStructures, ["full", "milestones"]);
    assert.throws(() => createInvoice({ userId: "issuer-ms", amount: 50, milestones: true }), /2 to 10/);
  });
});
