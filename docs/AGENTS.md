# For agents (research report §8.2)

Agent **wallets** — money set aside for software to spend. This is unrelated
to the Evabob Agent, the in-app assistant.

| # | Feature | Where |
|---|---------|-------|
| 7 | Agent allowance: amount, window, what it may buy; three approval tiers; live meter; loop breaker; freeze all | `services/agentAllowance.ts` (rules), `services/agentControls.ts` (owner side) |
| 8 | Pay after proof, with evidence bundles | `services/x402Pay.ts`, `services/agentEvidence.ts`, `services/paywalls.ts` |
| 9 | Agents with names and reputations; curated seller list | `services/agentNames.ts`, `services/agentMarketplace.ts`, `contracts/src/IdentityRegistryV3.sol` |
| 10 | An agent hires a person, money locked first | `services/agentTasks.ts` |
| 11 | Get paid by agents: paywalls for what people made | `services/paywalls.ts`, `/x/:id` |

Routes: `routes/agentCommerce.ts`. App: Agents screen, **Get paid by agents**
and **Work for agents** in the Home menu. Web: `/x/:id`, `/a/:handle`,
`/t/:id`.

---

## 7 · The allowance

"$20 this week, research services only" — an amount, a window (day, week or
month, UTC; weeks start Monday) and a list of categories (research, data,
media, AI, finance, people's time, tools; empty means anything on the list).

Every payment falls in one of three tiers:

| Payment | What happens |
|---------|--------------|
| At or below the owner's own limit | Goes through silently |
| Above it, within what is left | A push asks the owner. The agent gets `202` with `code: APPROVAL_PENDING` and retries the **same idempotency key** once approved. Unanswered in 30 minutes = no. |
| Beyond what is left this window | Refused (`OVER_ALLOWANCE`), whatever anyone approved |

Also refused: a seller outside the categories (`NOT_ON_LIST`), a seller that
takes payment before proof when the allowance is proof-only (`NEEDS_PROOF`,
the default for new agents), and a paused agent (`AGENT_PAUSED`).

**Live meter.** Spent, waiting (held for proof, or fees locked for a hired
person), left, and when it refills. The server pushes an update on every
payment, approval and pause; the app's meter moves while you watch.

**Loop breaker.** More than 5 calls to one endpoint (origin + path, query
ignored) within a minute pauses the agent and pushes the owner. Every call
counts, paid or not. The agent stays paused until the owner resumes it.

**One tap freezes everything.** *Freeze all* on the Agents screen pauses every
agent at once (Undo on the snackbar). Unfreezing leaves agents that were
paused for their own reason — by the owner or the loop breaker — paused.

Older agents without an allowance read their daily limit as the amount (per
day) and their per-call limit as the ask-me limit; nothing gets looser.

## 8 · Pay after proof

x402 has the payer hand a signed payment to the seller with the request, so a
seller that has it can take it whether or not it delivers. Evabob holds
rather than pays wherever it can:

- **Evabob paywalls (item 11) wait for proof.** Evabob hosts the seller, so the
  payment is only *verified* when it arrives; the content is produced and
  checked; only a usable response is *settled*. A file that cannot be read or
  an API that fails is never settled — the agent's reservation comes straight
  back (`refunded`, "not charged"). A booking of someone's time is held
  unsettled until they accept.
- **Outside sellers take payment with the request.** If what came back is
  unusable, the payment is marked `disputed`, the owner is pushed, and the
  evidence is kept. Proof-only agents do not pay these sellers at all.

"Usable": a 2xx status, a non-empty body, and — when it says JSON — JSON that
is not empty and not just an error.

**Evidence bundle** (one per payment, plus one per later outcome):

- *authorised* — owner, agent, the allowance in words, the tier, the approval
  if there was one, what was left before
- *asked* — method, URL, time
- *came back* — status, type, size, SHA-256 of the whole body, the first 8 KB
- *payment* — amount, recipient, network, settlement, outcome

Hashed over canonical JSON (keys sorted), and each bundle carries the previous
bundle's hash for the same agent, so an edited one breaks the chain. The app
shares it as a JSON file; the export states how to recompute every hash.

## 9 · Names and reputations

An agent can be named, from the same namespace as people: `@ada_research` can
never also be a person. Names are permanent. Paying `@ada_research` pays the
agent's own wallet, and the payer sees **"Research agent · owned by @ada"**.
Holds are not offered for agents (a hold releases to a person's identity).

**On chain.** The name is registered as an `Agent` identity (ordinal 3) in
**IdentityRegistryV3** (`0x7a74c86b6fd0b0232d5d1eb0074547dfe1a4ffd0`), which is
V2 with that one type appended — Phone, Email and Handle keep their ordinals,
so every existing key is unchanged. V2 rejects ordinal 3, which is why a new
registry was needed. PaymentEscrowV3's registry is immutable (V2), so the
server links people's handles and emails in **both** registries
(`ESCROW_IDENTITY_REGISTRY`) and agents in V3 only. The 8 identities V2
resolved were copied to V3 (`src/scripts/migrate-registry-v3.ts`, idempotent).

**Income.** Money paid to a named agent lands in its wallet on Arc; the tick
finds it, deposits it into the agent's spendable (Gateway) balance, records
who paid, and tells the owner. The owner's own top-ups, Gateway withdrawals
and hold refunds are not income and are left alone.

**Record**, counted from what happened: people hired and paid, fees that went
back because nothing was delivered, holds settled by a reviewer, paid calls
delivered / not charged / paid for nothing. Shown on `/a/:handle`, on its
tasks, and in the app.

**Seller list seeded, not empty.** With `AGENT_RESOURCE_ORIGINS` unset, the
allowlist is the curated marketplace: every Evabob paywall plus Circle's x402
catalog filtered to sellers an agent can pay on this network (none on Arc
testnet yet). Each seller has a category and a delivery record.

## 10 · An agent hires a person

1. The agent posts a task (`POST /v1/agent-api/tasks`), for a named person or
   open to anyone. The allowance applies (category *people's time*); above
   the owner's limit the owner approves first. The fee, the 0.05% Evabob fee
   and $0.05 of network cost are reserved from the agent's balance at once.
2. Before the person starts, the fee is locked on chain in PaymentEscrowV3 —
   the same job hold people use — for that person: withdraw from the agent's
   Gateway balance to its wallet, approve, create the hold. Every step is
   resumable. An open task locks when someone takes it.
3. The person is told **"the money is set aside before you start"** and marks
   it delivered from their held payments.
4. The agent (`/accept`) or its owner confirms, or 7 days of silence release
   it. A dispute after delivery goes to a person for review.
5. Nothing delivered by the deadline: the hold expires, the fee comes back to
   the agent's wallet and is deposited into its balance again.

The owner is the payer of record and answers for it; the worker sees the
agent and its owner by name, and the agent's record of paying people.

## 11 · Get paid by agents

A person makes a paywall for a dataset or photo set (files, up to 10 MB), a
piece of text, their own small API (Evabob proxies it, with an optional secret
header kept server side, forwarding the caller's query), or their time.

- The shared link `https://evabob.app/x/:id` shows browsers a page; software
  is sent (Next `proxy.ts`) to the API's `/x/:id`, which answers `402` with
  x402 terms: Circle Gateway batched, USDC on Arc testnet, paid to Evabob's
  paywall treasury (a Circle-held wallet created on first use).
- With a payment it verifies with Circle's facilitator, delivers, checks, and
  only then settles. Each signed payment works once.
- **Time:** the payment is held, unsettled, until the person accepts (with
  when and where) — then it is settled. Declined or unanswered in 48 hours:
  dropped, nothing charged. `GET /x/:id/booking/:saleId` for status.
- **Payouts** from the treasury to the person's wallet at $1, or a day after
  the oldest sale if more than $0.04 is owed, less the 0.05% fee and $0.02
  network cost. They arrive as money in (with the money-in sound).

---

## For whoever wires up an agent

All with `Authorization: Bearer sk_evabob_…`.

```http
POST /v1/x402/pay            {"url": "...", "idempotencyKey": "16-100 chars"}
GET  /v1/agent-api/me        allowance, meter, paused, record
GET  /v1/agent-api/marketplace
GET  /v1/agent-api/approvals/:id
POST /v1/agent-api/tasks     {"to": "@bola" | omit for open, "title", "description",
                              "amountUsdc", "deliveryDays", "openDays", "idempotencyKey"}
GET  /v1/agent-api/tasks[/:id]          includes the delivery note and links
POST /v1/agent-api/tasks/:id/accept     pay the person now
POST /v1/agent-api/tasks/:id/dispute    {"reason": "not_as_agreed" | "not_received" | ...}
POST /v1/agent-api/tasks/:id/cancel
```

`/v1/x402/pay` answers with `code` when refused: `AGENT_PAUSED`,
`LOOP_BREAKER`, `NOT_ON_LIST`, `NEEDS_PROOF`, `OVER_ALLOWANCE`,
`APPROVAL_PENDING` (202, with `approval.id`), `APPROVAL_DECLINED`,
`NOT_CHARGED`, `PAID_NOT_DELIVERED`. Paid responses carry `evidenceId` and
`settlement` (`proof` or `direct`).

## Verified

- Server: 378 tests (41 new), typecheck clean. Contracts: IdentityRegistryV3
  6 tests. Flutter analyze clean.
- On Arc testnet: IdentityRegistryV3 deployed with the Safe as admin and the
  identity linker as linker; `/v1/health` role map OK; identities copied.
- Against Circle's live testnet facilitator: a funded agent wallet signed a
  payment for Evabob paywall terms and Circle **verified** it (never
  settled — no money moved). This check found two bugs in the existing agent
  payment path, both fixed: the signer could not serialise the payment's
  amounts (every paid call failed at signing), and paid requests left out the
  `resource` Circle requires.
- **End to end with real money, 2026-09-19** (agent "john drums", owned by
  @ekuma; seller and worker @nzubechi_; `src/scripts/e2e-agents.ts`):
  - *Paywall:* the agent paid a $0.01 text paywall through `x402PayForAgent`.
    Circle verified, Evabob delivered and checked, Circle settled. Agent
    Gateway balance 1.00 → 0.99; treasury `0x62fd…7c69` shows 0.01 pending in
    Gateway's batch. Sale recorded, evidence bundle hash verified.
  - *Hire:* $0.05 task for @nzubechi_. Gateway withdrawal to the agent's
    wallet, approve, lock (PaymentEscrowV3 transfer 1, lock tx `0xae28…7605`:
    sender the agent's wallet, recipient key @nzubechi_'s handle), 0.05%
    fee. Marked delivered, accepted by the agent, released (claim tx
    `0xdf97…68b4`: 0.05 USDC to @nzubechi_'s wallet). Task "Paid"; agent
    record "paid 1 of 1".
  - Cost beyond the money that reached @nzubechi_: about $0.016 (Gateway fee
    $0.0035, gas for the three lock calls $0.0128, Evabob fee $0.000025).
    Of the $0.05 network reserve, $0.037 was not needed and stays in the
    agent's own wallet on Arc, outside its spendable balance.
  - The run found one bug, fixed: a hire's fee row was counted as a paid call
    in the agent's record.
- Not yet run with real money: a payout from the treasury (the $0.01 is below
  the payout threshold), a hire returned because nothing was delivered,
  income swept into a named agent, approvals and the loop breaker from a live
  agent.
