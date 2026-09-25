# Held payments — the rules

Written down on 2026-09-18, before the first dispute, so that nobody has to
invent a rule while someone's money is waiting on it. The server enforces
these in `server/src/services/heldPayments.ts`; the app explains them on the
held-payment screen. Change them here first.

## Three kinds of held payment

| Kind | Used for | Released when | Goes back to the payer when |
|------|----------|---------------|-----------------------------|
| **Job** | An invoice paid "hold it until delivered", "half now, half held" or by milestone; an order paid through a seller's hold link | The payer confirms, or 7 days pass after the worker marks it delivered with no objection | The payer cancels before delivery; the worker gives it back; a reviewer decides so; or it expires with nothing delivered (90 days for invoices; the seller's delivery window for hold links, 14 days unless they chose otherwise) |
| **Cooling-off** | A first payment to someone new, when the sender leaves "wait 10 minutes" on | 10 minutes after it was made | The sender cancels inside the 10 minutes; or the server never released it and it expires (24 hours) |
| **Claim link** | Paying an email address that has no Evabob account yet | The recipient signs up and proves that email | The sender cancels before it is claimed; or it expires unclaimed (7 days) |

## What is never held

Only the three kinds above are held payments. Two things that move money in
steps are not:

- **Conversions (swaps)** are never shown as held. One that is still being
  confirmed reads "On the way"; the server asks the chain how it ended.
- **Sends** are never held either. A send still being confirmed reads
  "Confirming"; "Waiting for X to join" is only for a claim link.
- **Bridges** count as in flight only once their first PIN has been entered.
  The server finishes a bridge left for 40 minutes after that PIN. A bridge
  left before any PIN is dropped with "No PIN was entered, so nothing moved."

The recipient of a claim link sees it in the app ("Claim held money") and on
the web at `/claim`. The email is sent when the hold is created; if email is
down the money is still held and can still be claimed.

## Jobs, step by step

1. **The payer holds the money.** It leaves their balance and sits in the
   escrow contract, locked for the worker's identity (@handle or email).
2. **The worker marks it delivered**, with a short note and optional links to
   the work. The payer is notified.
3. **The payer has 7 days.** They can:
   - confirm, and the worker is paid now;
   - do nothing, and the worker is paid automatically when the 7 days end
     (with a reminder to the payer one day before);
   - cancel — which, after delivery, means the reconciliation form below.
4. **Before delivery**, the payer may cancel at any time and the money comes
   straight back. The worker is told.
5. **The worker may give the money back** at any point. That settles it,
   including an open review.

If a job is marked delivered close to its expiry, the hold is extended so the
7 days can run in full before any refund could open.

## Hold links: selling on WhatsApp and Instagram

A seller makes a link for one thing they sell — a title, a price and how many
days they need to deliver (**14 by default**, 1 to 60) — and pastes it into a
chat, a post or their bio. The public page (`/h/{id}`) shows the item, the
seller and their track record, and says: *"Your money is set aside for Ada
until your order arrives."* The word "escrow" is never shown.

A buyer who pays through it creates an ordinary **job** hold for the seller,
with the link's price and an expiry of exactly the delivery window. The
server takes the seller, price and window from the link itself, and checks the
hold against them before recording it. From there every rule above applies
unchanged, as the product owner chose on 2026-09-18: the seller marks it
delivered, the buyer has 7 days, silence pays the seller, a cancel after
delivery goes to review — and if nothing is marked delivered within the
window, the hold expires and the buyer is refunded.

A seller's track record counts their finished job holds: delivered and paid;
not delivered in time; and refunded after a review found against them. A
buyer cancelling before delivery, or the seller giving the money back, does
not count against them.

## Invoices paid by milestone

An invoice with 2 to 10 lines can be marked "paid by milestone". The payer
then sets each line aside as its own job hold, all under one PIN, and each is
released on its own when that part is marked delivered (or 7 days after, with
no objection). Cancelling or reviewing one milestone does not touch the
others. The server checks that the holds match the invoice lines — payer,
recipient, amounts, in order — before recording them.

Invoices can also carry a due date and a payer. The payer is reminded the day
before, on the day, and once three days late; the sender is told when it goes
overdue.

## Cancelling after delivery: the reconciliation form and review

A payer who cancels after the worker has marked the work delivered must say
why. They choose a reason — *I no longer need it*, *it is not what we
agreed*, *I did not receive it*, or *something else* — and write what happened
(at least a sentence or two), with optional links.

That does **not** move any money. It opens a review:

- Nothing is released or refunded automatically while a review is open.
- The hold's expiry is pushed out (kept at least ~15–30 days ahead, and never
  past a year from when it was created), so the payer cannot simply wait for
  the refund that normally opens at expiry.
- The worker is asked to add their side: what they delivered and when, with
  links.
- The payer may still end it by paying — confirming releases the money to the
  worker and closes the review.
- The worker may still end it by giving the money back.

**A person at Evabob decides.** An operator (a user id in `OPERATOR_USER_IDS`)
reads both sides and chooses one outcome: all of it to the worker, or all of
it back to the payer. The contract cannot split a hold, so there is no
partial outcome. The decision note is shown to both people; the operator's
identity is not.

What the reviewer weighs, in order (confirmed by the product owner on
2026-09-18):

1. **Evidence of delivery.** Links to the work, and whether it matches the
   invoice description. Delivered and matching → the worker.
2. **Evidence it was not delivered, or not what was agreed.** Specific,
   checkable differences from the invoice → the payer.
3. **"I no longer need it" after delivery** is not a reason to take back
   payment for work that was done. Without evidence the work is missing or
   wrong → the worker.
4. **When it is genuinely unclear**, the burden sits with whoever is asking to
   reverse the default: after delivery the default is that the worker is
   paid.

While a review is open, **both people and the reviewer can talk in a
conversation on the payment**, each message with up to 5 links and 3 photos
as evidence (the parcel at the door, the damaged item, the chat where
something was agreed). Everyone involved sees every message. The reviewer
appears only as "Reviewer". Photos are stored under random names, reachable
only by those given the path. Each new message notifies the others.

Operators decide from `GET /v1/operator/reviews` and
`POST /v1/operator/reviews/:transferId/decide` with `{ outcome, note }`, and
write in the conversation with
`POST /v1/operator/reviews/:transferId/messages`. The decision note is
required and is shown to both people.

## What the contract guarantees, whatever the server does

PaymentEscrowV3 (`0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39` on Arc Testnet):

- A release can only pay the address the identity registry resolves the
  worker's identity to. The server decides *when*, never *who*.
- An early refund (`refundWithAttestation`) can only pay the original payer.
- An expiry extension can only move expiry later, and never past a year after
  the hold was created.
- If the server stops entirely, every hold still refunds to its payer once it
  expires. Money cannot be stranded by the server going away.

The chain is also the authority over the server's own records. Before a
release, and whenever a hold is opened, the server reads the transfer: one
already paid out or refunded is marked so, rather than offered for payment
again. Each on-chain hold is recorded once, however often the app reports it.

## Timing, and what runs it

Automatic releases, reminders and expiry extensions run from the scheduled
`/internal/cron/tick` and also whenever either person opens their held
payments, so a late scheduler delays a release rather than losing it. See
`docs/HOSTED_ENVIRONMENTS.md` for the schedule.
