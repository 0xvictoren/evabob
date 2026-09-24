# Security updates — 24 September 2026

This document describes the changes made after [`PRODUCT_AUDIT.md`](./PRODUCT_AUDIT.md): what each one does, how it works, and why it does not change how the app behaves for people using it normally. It also covers the two changes asked for explicitly: **fixing the agent payment API** and **making @handles permanent**.

## Ground rules followed

1. **Nothing a person does today stops working.** Every change is either invisible in normal use, a limit far above normal use, or behind a switch that is off by default.
2. **Installed app builds keep working.** Server changes accept exactly what the current APK sends. Where the app needed changes (permanent handle, recovery alert, memo warning), old builds keep working and simply don't show the new screens.
3. **Anything I could not test end to end is off by default** and documented with the steps to turn it on (the GA payment PIN, §3.1).

## Verification

| Check | Result |
|-------|--------|
| Server tests (`npm test`) | **446 of 448 pass**, including 26 new tests. The 2 failures also fail on the untouched code: they are the Node 22.22 / `tsx` import issue (audit F-05), not these changes. |
| Server typecheck (`tsc --noEmit`) | Clean |
| Compiled server (`npm run build` → `node dist/index.js`) | Boots; changed routes answered as expected when probed |
| Flutter (`flutter analyze`, `flutter test`) | No issues; **69 of 69 tests pass** (3 new) |
| Web (`next build`, `next start`) | Builds; `/` shows the new landing page; `/home`, `/wallet` and the other mock-up routes return 404 in production; `/claim` and `/privacy` render |

---

## 1. Agent payment API — fixed

### The bug
Every agent-key `POST` to `/v1/agent-api/*` was refused with `401 verified_user_required`: creating a task, accepting a delivery, disputing and cancelling. The routes' own agent-key check never ran.

The cause: `server/src/routes/api.ts` registers a write guard with `api.use("*", …)` that requires a signed-in *person* for every non-GET request. Hono mounts that sub-app's middleware at `/v1/*`, so it also runs for the separately mounted `agentApiRoutes` at `/v1/agent-api`. Only `/v1/x402/pay` was exempt.

### The fix
- `acceptsAgentKey(path)` in `server/src/middleware/auth.ts` is now exported. It is the single definition of which paths take an agent key (`/v1/x402/pay` and `/v1/agent-api/*`).
- The write guard in `api.ts` exempts exactly those paths, and nothing else. Their handlers already refuse anything that is not an agent principal (`callingAgent(c)` in `routes/agentCommerce.ts`, the principal check in `/v1/x402/pay`).

### What does not change
- An agent key still opens **only** those paths. On any other `/v1` route it is treated as a failed sign-in and refused.
- Revoked keys are still refused (`AGENT_KEY_REVOKED`).
- `/v1/x402/pay` behaves exactly as before.

### Tests — `server/src/routes/agent-api.test.ts`
It mounts the real routers in the same order as `index.ts` and calls them with a real agent key:
- `GET /v1/agent-api/me` → 200 with the agent's details
- `POST /v1/agent-api/tasks/:id/cancel` → reaches the handler (404 "No such task") instead of 401. **This test fails without the fix and passes with it.**
- A POST with no key → 401; with a revoked key → 401 `AGENT_KEY_REVOKED`
- An agent key on another write route (`/v1/contacts`) → 401
- `/v1/x402/pay` is still answered by the auth layer, not the person-only guard

### How an agent uses it now
```http
POST /v1/agent-api/tasks
Authorization: Bearer sk_evabob_…
Idempotency-Key: <16–100 chars>
Content-Type: application/json

{ "title": "Photograph the shop front", "amountUsdc": 2, "to": "@ada" }
```
The same key works for `/v1/agent-api/tasks/:id/accept`, `/dispute`, `/cancel` and `/v1/x402/pay`.

---

## 2. @handles are permanent

### The rule
**A person chooses their @handle once, at signup. After signup is finished it can never be changed.**

- **During signup** (the account's `onboardingCompletedAt` is still `null`), the handle can be set, and set again if the first choice fails (for example, it turns out to be taken on-chain). Signup still requires an explicit choice before it can finish, as before.
- **After signup**, `POST /v1/users/handle` returns **409** with `code: "HANDLE_PERMANENT"` and the message "*Your @handle is permanent. It was set when you signed up and cannot be changed.*" Re-sending the handle the account already has is accepted as a no-op, so retries never error.
- **Accounts from before the signup step existed** (no `onboardingCompletedAt` at all) count as finished, so their current handle is now permanent too.

### Why this also closes a payment bug
A handle is linked on-chain to the wallet it was first given to, and the escrow contract releases held payments to that wallet. If a handle could move to someone else, their held payments would go to the previous owner (audit EV-02). Permanent handles, plus the reservation below, make that impossible for new cases.

### Deleted accounts keep their handle reserved
When an account is deleted, its handle moves to a new `retiredHandle` field instead of being freed. `isHandleTaken` counts retired handles, so nobody can ever take one. Payments by that handle find no one, so nothing can be sent to a deleted person.

### Lookalike handles are refused
Because handles are now permanent, a new handle containing `evabob` (for example `evabob_support`) is refused, so it can't become a permanent impersonation tool. Existing handles are not affected. The Evabob assistant's own `@evabob` handle is set internally and is not affected.

### Changes by place

| Where | Change |
|-------|--------|
| `server/src/store/db.ts` | `updateHandle` allows changes only while `handleIsOpen(user)` (signup unfinished) and returns `HANDLE_PERMANENT` otherwise. The 2-month cooldown is removed (no longer needed). `anonymizeUser` keeps `retiredHandle`. `isHandleTaken` checks retired handles. A deleted account is never given a new default handle. |
| `server/src/routes/api.ts` | `/users/handle` returns 409 + `code` for a permanent handle. |
| `server/src/utils/handles.ts` | New handles containing "evabob" are refused. |
| `server/src/knowledge/evabob-kb.ts` | The assistant now says the handle is permanent. |
| `mobile/…/profile_screen.dart` | The @handle row opens a read-only sheet ("chosen when you signed up and is permanent") instead of an edit dialog. |
| `mobile/…/post_signup_onboarding.dart` | The signup screen says "*Choose carefully: your @handle is permanent and cannot be changed later.*" |

**Older app builds:** the Profile edit dialog still appears there, but saving shows the server's "permanent" message and nothing changes. Signup works as before.

### Tests — `server/src/store/handles-permanent.test.ts`
Signup can choose and re-choose; after signup a change returns `HANDLE_PERMANENT`; the same handle is a no-op; accounts from before the signup step are locked; a deleted account's handle stays reserved and cannot be taken by a new account.

---

## 3. Security fixes

Each item names the audit finding it addresses.

### 3.1 GA payments without a PIN (EV-01) — mitigated now, full fix behind a switch

**Background.** After a person approves Evabob once per network, every GA payment is signed on the server by the ops key acting as their Gateway delegate, with no PIN for each payment.

**On now (no change to how anyone pays):**
- **An alert on every GA payment the moment it is sent**: "*Paid from your GA — X USDC to 0x12…34. Not you? …*" (`sendGatewayPayment` in `services/gatewayPayFlow.ts`, new alert kind `ga_payment_sent`). A payment the person didn't make is noticed immediately. Older app builds show it like any other notification.
- **A per-user rate limit** (`MONEY_MOVES`, 30 per minute) on `/v1/circle/gateway/*`, so a stolen session can't be scripted to drain in bulk. The app makes at most 4 calls per payment.

**Built but off by default: `GATEWAY_PAY_REQUIRE_PIN`.** When it is `true`:
1. `/v1/circle/gateway/pay` no longer sends or schedules the payment. It asks Circle for a message-signing challenge whose text names the payment ("*Evabob: pay 5 USDC from your GA to 0x12…34*"), parks the payment in memory under that challenge id (`services/gatewayPinGate.ts`), and returns the challenge.
2. The app shows the PIN screen. **Installed builds already do this**: any challenges `/gateway/pay` returns are run through the normal PIN flow.
3. After the PIN, every app build calls `/v1/circle/verify-challenges`. When Circle reports the challenge `COMPLETE` for the **same person**, the server releases that payment **once**, plans it again, and sends it (or schedules it if a network approval is still being confirmed).
4. A payment whose PIN never comes is dropped after 10 minutes. Nothing was sent.

Why it is off: the Circle message-signing challenge in the PIN screen could not be exercised from this environment (no Circle credentials or device). **To turn it on:** set `GATEWAY_PAY_REQUIRE_PIN=true` on a test deployment, make one GA payment from a phone, and check that (a) the PIN screen shows the payment text, (b) the payment arrives, and (c) cancelling the PIN sends nothing. Then set it in `render.yaml`. Tests: `server/src/services/gatewayPinGate.test.ts` (released once, only for its own person, dropped after the window).

**Still to do (a design change, not a switch):** replace the shared ops-key delegate with a per-user delegate key held in a KMS/HSM, with per-user daily limits, so a leak of one key cannot reach every GA.

### 3.2 Held payments credited to the wrong person (EV-02)
- `releaseToRecipient` (`services/heldPayments.ts`) now records "Payment received" for **the owner of the wallet the contract actually paid**, not whoever holds the handle today. If the two ever disagree, it logs a warning instead of telling the wrong person they were paid.
- With permanent and reserved handles (§2), the mismatch can no longer arise for new cases.

### 3.3 Account deletion (EV-06)
- **On-chain identities are retired.** When an account is deleted, its handle and email links are unlinked on-chain in the background (`retireAccountIdentities` in `services/identity.ts`). Only links that still point at **that account's own wallet** are touched. Afterwards, held payments addressed to the deleted person return to their payers instead of releasing to a wallet nobody can open. A failure is logged and never undoes the deletion.
- **The Mongo user mirror now forgets** the handle, phone, photo and extra sign-in ids of a deleted account. Before, `$set` left them there.
- **The deletion response is truthful** about the AI provider (it previously always said "disabled"). It also reports `identityLinksRetiring`.
- **App copy:** the delete sheet now says the person will not be able to sign in again and should send their money out first. Deletion itself is not blocked.

### 3.4 Ops wallet as an open bridge relayer (EV-03)
- `/v1/circle/cctp/finish` now checks that a burn the caller names by hash came **from one of the caller's own wallets** (`burnBelongsTo` in `services/cctp.ts`). It looks for the wallet as an indexed topic in the burn receipt, which works for CCTP V1 and V2.
- Burns resolved from the person's own PIN challenge skip the check, since they are theirs by construction.
- **It never blocks a real retry:** if the receipt can't be read (busy RPC, unknown network, no wallet list), the finish carries on as before. Only a readable burn from someone else's wallet is refused (403).
- **Rate limit** `MONEY_MOVES` (30/min per person) on `/v1/app-kit/ucw/bridge` and `/v1/circle/cctp/*`.
- **Not changed:** no minimum bridge amount (that would block small bridges); abandoned-bridge completion only ever handles the person's own jobs.

### 3.5 Rate limits and forged addresses (EV-04)
- New setting **`CLIENT_IP_HEADER`**. With `TRUST_PROXY=true`, the rate limiter reads the client address from this header, which the hosting edge sets and overwrites, before falling back to `X-Forwarded-For`, whose left-most entry a client can forge.
- `render.yaml` / `render.free.yaml` set `CLIENT_IP_HEADER=true-client-ip`. **If a request arrives without it, the old behaviour applies unchanged**, so this cannot make things worse.
- **Check after deploying:** send a request with a made-up `X-Forwarded-For` and confirm it doesn't get a fresh rate-limit bucket.
- Tests: `server/src/middleware/rate-limit-client-ip.test.ts`.

### 3.6 Email and wallet lookups (EV-05)
- `/v1/users/lookup`, `/v1/payees/check` and `/v1/escrow/recipient-status` share a per-person allowance of **120 lookups per 10 minutes**. The app makes one per scan, review or send, so normal use never reaches it; bulk scraping stops.
- `/v1/public/claims/:id` now names the sender **only for claim links**. Before, anyone could walk the sequential ids and tie every held payment's on-chain sender to a name and photo. Job and 10-minute holds show amount and status only, which is all the claim screens need.

### 3.7 Account recovery could not be stopped (EV-07)
- The app now opens `evabob://account-recovery/<id>`: it is on the deep-link allowlist and routed in `app_shell.dart`.
- Tapping the "Account recovery requested" alert shows **"Was this you?"** with **Stop it**, which calls the existing `POST /v1/users/recovery/:id/cancel` (`mobile/lib/features/profile/account_recovery_alert.dart`).
- Tests: `mobile/test/app_link_service_test.dart`.

### 3.8 Savings circles: joining a second circle (EV-08)
- Joining now approves **what is already approved plus this circle's commitment** (`joinCallsFor` in `services/groupMoney.ts`), instead of replacing the approval. A member of two circles is no longer marked "behind" in the first.
- If the current approval can't be read, it approves this commitment alone, exactly as before.
- **Still to do (product decision):** collateral, and a clear warning that early recipients could stop paying.

### 3.9 Privacy notice and memo warning (EV-09)
- **Privacy notice** (`src/app/privacy/page.tsx`) corrected. It now states that, where the test network has them on, a payment note and a one-way hash of the email can be written on-chain, and that the handle is linked on-chain. It also states plainly what the assistant sends to DeepSeek when turned on; the unimplemented "aliases" claim is removed.
- **Memo field:** `/v1/config/public` now reports `onchainMemos` only when notes are **really** written on-chain (flag and contract both set). The send screen's note field then reads "*Add a note · anyone can see it, forever*".
- On-chain email links stay on for the testnet. Turning them off would stop "Hold it for them" payments to people who are not on Evabob yet.

### 3.10 Per-person limits (EV-10)
All limits are far above normal use:

| What | Limit |
|------|-------|
| Active agent wallets | 25 (each is a Circle wallet) |
| Open paywalls | 100 |
| Paywall file storage | 200 MB per person |
| Open sell-with-a-link links | 200 |
| Chat message length | 4,000 characters |

Each returns a clear message saying what to close first.

### 3.11 Claim-link emails (EV-11)
- The **subject is fixed** ("You have X USDC waiting on Evabob"); the sender's words never reach it.
- The sender is shown by their **verified @handle**, never a free-text display name or their email address.
- **Links are stripped** from the sender's note (`emailSafeNote`), so a tiny payment can't deliver phishing from Evabob's address.
- **Tiny amounts show in full** (not "0.00").
- Tests: `server/src/services/notify-email.test.ts`.
- **Still to do (config):** send from an owned domain with SPF, DKIM and DMARC instead of a Gmail address through Brevo.

### 3.12 Family check on every route (EV-12)
- `/v1/circle/transfer`, `/v1/app-kit/ucw/send` and `/v1/app-kit/ucw/spend` now apply the same family check as `/v1/circle/send`. The app does not use these routes, so nothing in it changes.
- `/v1/app-kit/ucw/compose` (which the app does use) is left alone, because that flow has no screen for entering the family code.

### 3.13 Public website (EV-13)
- `/` is now a **simple landing page** (test-network notice, Privacy, Terms) instead of a redirect to the mock wallet.
- **The design mock-up** (`/home`, `/wallet`, `/send` and so on, all fake data) **returns 404 in production**. It still works locally, or with `EVABOB_SHOW_MOCKUP=true`.
- The claim page's "address bar" text comes from configuration (`NEXT_PUBLIC_APP_HOST`), not the request's `Host` header. "THIS LINK ONLY WORKS ONCE" (not true) now reads "ONLY THE PERSON IT WAS SENT TO CAN CLAIM IT".
- The CSP's `connect-src` follows the configured API URL.
- **Still to do:** enforce the CSP (it is still report-only) once a report endpoint shows no violations.

### 3.14 Smaller fixes (EV-15, EV-16)
- **EV-15:** if saving to the database fails after an action ran, the message now says "*This may already have gone through. Check Activity before trying again*" instead of "Retry later", which could have caused double sends.
- **EV-16:** the cron secret is compared in constant time.

---

## 4. Not changed, and why

Each of these needs a product decision, a device test, or a design change that would alter how the app behaves today:

| Item | Why not now | How to do it |
|------|-------------|--------------|
| **Per-user Gateway delegate (EV-01 full fix)** | Needs a new key design and a migration of existing delegates. | Create a delegate key per user in a KMS/HSM; re-run the one-time approval to point at it; cap daily spend per user; keep the PIN switch on. |
| **Block deletion while money remains (EV-06)** | Would block a function, which was ruled out. | Show the balance in the delete sheet and offer "Send it to…" before the final confirm. |
| **Circle collateral (EV-08)** | Changes how circles work. | Add a collateralised mode to `MoneyCircles` (members deposit one or more contributions up front, returned at the end), plus member track records. |
| **Platform fee on every route (EV-12)** | App Kit's `send` has no batch, so adding the fee means changing the rail. | Route all sends through one policy function that builds the transfer and fee batch. |
| **Neutral default handle and display name (EV-14)** | The signup screen pre-fills the email's first part; changing it changes signup. | Suggest a neutral handle and ask for a display name at signup. |
| **Turn off on-chain email links on testnet (H-06)** | Would stop "Hold it for them" payments to people not on Evabob yet. | Replace email keys on-chain with random recipient ids resolved by the server. |
| **Enforce the web CSP (M-08)** | Needs a violation-report endpoint first. | Add `report-to`, watch for a week, then switch to `Content-Security-Policy`. |
| **Node / `tsx` import issue (F-05)** | Tooling, not security; CI is green today. | Pin the Node minor version in CI and `.nvmrc`. |

## 5. Deploying

1. Deploy the server and web as usual. `render.yaml` adds `CLIENT_IP_HEADER=true-client-ip` and `GATEWAY_PAY_REQUIRE_PIN=false`.
2. Build a new APK so people get the permanent-handle Profile sheet, the recovery "Stop it" dialog and the memo warning. **Old APKs keep working** in the meantime.
3. After deploying, check the rate limiter ignores a forged `X-Forwarded-For` (§3.5).
4. When ready, test and turn on `GATEWAY_PAY_REQUIRE_PIN` (§3.1).
