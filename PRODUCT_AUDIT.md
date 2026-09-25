# Evabob — Product, Security and UX Audit

**Date:** 24 September 2026
**Commit audited:** `cba8e1e` (`main`, "Commit the Gradle wrapper so CI can run ./gradlew")
**Scope:** Hono/Node API (`server/`), Flutter app (`mobile/`), Solidity contracts (`contracts/`), Next.js public web app (`src/`), deployment config (`render*.yaml`), CI and repository contents.
**Method:** Manual source review of every route file and the money-moving services, re-verification of each finding in the earlier [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) (19 Sep 2026), local runs of the server test suite, type-checker and `npm audit`, small proof-of-concept scripts where a finding needed confirming, and a review of the tester guide (`user_test.pdf`), the redesign brief and the saved error screenshots (`error/`).

> **How to read the severities.** Evabob runs on testnet and says so clearly. Each finding is still rated as if this code handled real money, because that is the decision it has to support. Where a problem only applies to the current testnet config, the finding says so.

> **Update, 24 September 2026:** fixes for most of these findings, the agent API bug (F-01) and permanent @handles are described in [`SECURITY_UPDATES.md`](./SECURITY_UPDATES.md). This report is kept as written, as the record of what was found.

> **Update, 25 September 2026:** UX-06 — screenshots are now allowed everywhere (`FLAG_SECURE` removed). UX-03 in part — "Your GA" is now "Gateway Account" throughout. The Home menu was reordered by the product owner (Request, Sell with a link, Circles and collections, Get paid by agents, Work for agents, Convert, Gateway Account, Move money, Agent wallets). See `docs/STATUS.md`.

---

## Contents

1. [Summary](#1-summary)
2. [New security findings](#2-new-security-findings)
3. [Status of the 19 September audit findings](#3-status-of-the-19-september-audit-findings)
4. [Functional bugs and engineering issues](#4-functional-bugs-and-engineering-issues)
5. [UI/UX errors and improvements](#5-uiux-errors-and-improvements)
6. [Feature inventory](#6-feature-inventory)
7. [What to improve or change](#7-what-to-improve-or-change)
8. [Repository hygiene](#8-repository-hygiene)
9. [What is done well](#9-what-is-done-well)
10. [Limits of this audit](#10-limits-of-this-audit)

---

## 1. Summary

A lot has improved since the 19 September audit. Of its 21 findings, **11 are fixed** and **9 are partly fixed**: cleartext traffic, JWT validation, token logging, public chat photos, the CDN-loaded PIN page, the app-lock PIN, receipt revocation and notification previews. None has regressed. The code is careful, heavily commented and well tested (420 of 422 server tests pass locally, and CI on `main` is green).

This audit found **16 new security issues**: 2 High, 8 Medium, 5 Low and 1 informational. It also found **8 functional bugs** and a set of UX problems. The two most important:

1. **The Gateway ("Your GA") balance can be spent with nothing but a sign-in token.** After the one-time delegate setup, every Gateway payment is signed on the server by the ops key, with no PIN. So a stolen Dynamic session token is enough to empty a user's GA to any address. A leak of the ops key would drain every delegated GA at once.
2. **Recycled `@handles` send held money to the wrong person.** Deleting an account frees its handle in the database but leaves it linked on-chain. Direct sends to that handle reach the new owner. Held payments (the 10-minute first-payment wait, job holds, sell-with-a-link orders, milestones) are released to whichever wallet the chain resolves: the old owner's. Evabob then records "Payment received" for the new owner.

The biggest product-level issues:

- **The claim flow dead-ends for new users.** No app-store link exists, and the public web domain's home page is a **mock wallet showing made-up balances**.
- **Account deletion strands money.** A deleted account can never sign in again, so any wallet balance becomes unreachable, while the confirmation sheet says the money "is not deleted".
- **The privacy notice doesn't match the testnet config.** It promises no free text on-chain and "short-lived aliases" for AI, but the hosted testnet turns on on-chain memos and email links, and the AI tools send raw emails and wallet addresses.
- **Scope has outrun the core.** A "send money like a message" app now also ships agent wallets, x402 paywalls, agent-hired tasks, savings circles, cross-chain moves and a Gateway account, which shows up as a 9-item overflow menu full of jargon.

### Top 10 actions, in order

| # | Action | Findings |
|---|--------|----------|
| 1 | Require a user-signed challenge (PIN) for every Gateway payment. Stop using the ops key as every user's Gateway delegate. | EV-01 |
| 2 | On account deletion and handle changes, unlink on-chain identities. Never assign a handle whose on-chain key belongs to another wallet. Record receipts for the wallet actually paid. | EV-02, EV-06 |
| 3 | Block account deletion while any balance, hold or circle is open, or offer a "withdraw everything first" step. | EV-06 |
| 4 | Only relay CCTP burns that belong to the caller's own jobs. Set a minimum bridge amount. Put bridge routes on the spend rate limit. | EV-03 |
| 5 | Take the client IP from the right-most trusted `X-Forwarded-For` hop, or Render's `True-Client-IP`. | EV-04 |
| 6 | Fix the `/v1/agent-api/*` routes, which reject every agent-key POST. | F-01 |
| 7 | Build the account-recovery cancel screen and add `account-recovery` to the deep-link allowlist. | EV-07 |
| 8 | Make the circle join approval additive, or escrow each circle's commitment. Tell users plainly that a circle has no collateral. | EV-08 |
| 9 | Align the privacy notice with the actual config, or turn off `FEATURE_ONCHAIN_MEMOS` / `FEATURE_ONCHAIN_EMAIL_LINKS` on testnet and actually implement the AI aliasing. | EV-09 |
| 10 | Replace the web root's fake wallet with a real landing page. Add store or APK links to the claim page. | EV-13, UX-01 |

---

## 2. New security findings

Severity counts: **High 2 · Medium 8 · Low 5 · Info 1**.

| ID | Severity | Title |
|----|----------|-------|
| EV-01 | **High** | Gateway (GA) balance spendable with a session token alone |
| EV-02 | **High** | Recycled `@handles`: held payments go to the previous owner |
| EV-03 | Medium | Ops wallet is an open CCTP relayer (gas drain) |
| EV-04 | Medium | Rate limits bypassable by spoofing `X-Forwarded-For` |
| EV-05 | Medium | Email/wallet enumeration and wallet de-anonymisation |
| EV-06 | Medium | Account deletion strands funds and locks the person out forever |
| EV-07 | Medium | Account-recovery safety delay cannot be used by the victim |
| EV-08 | Medium | Savings circles: allowance overwrite and no collateral |
| EV-09 | Medium | Privacy notice contradicts what the hosted testnet does |
| EV-10 | Medium | Resource exhaustion: no per-user quotas, long-held requests |
| EV-11 | Low | Claim-link emails are a phishing channel |
| EV-12 | Low | Family check and platform fee enforced on only some spend routes |
| EV-13 | Low | Public web: fake wallet at `/`, report-only CSP, Host echo |
| EV-14 | Low | Default handle and display name expose the email address |
| EV-15 | Low | "Retry later" 503 after a state change may already have happened |
| EV-16 | Info | Cron secret compared with `===` |

---

### EV-01 — High — Gateway (GA) balance spendable with a session token alone

**Where:** `server/src/routes/circle-wallets.ts:666` (`POST /v1/circle/gateway/pay`), `server/src/services/gatewayPayFlow.ts:44`, `server/src/services/gateway-e2e.ts:1048` (`gatewayPayFromUserDepositor` signs with `getDeployerAccount()`), `server/src/routes/circle-wallets.ts:109` (`POST /v1/circle/session`).

**What happens.** To pay from the GA, a user adds Evabob's ops key as a Gateway delegate once, with a PIN. After that, `/gateway/pay` builds the burn intent and **the server signs it with the ops key**. The user signs nothing. The request needs only a `userToken`, and `/v1/circle/session` hands one to any caller holding a valid Dynamic JWT. The destination address is whatever the caller sends.

**Impact.**
- **Session theft becomes fund theft.** Anyone holding a user's Dynamic JWT (from a lost phone, a log, the pre-HTTPS builds, or a malicious WebView) can call `/circle/session` and then `/circle/gateway/pay` with their own `destinationAddress`, and drain the GA. The family check, the cooling-off hold and the PIN are all skipped.
- **One key controls every GA.** Compromising the ops key (a hot key that "signs constantly", per `docs/STATUS.md`) lets an attacker sign burn intents for **every user who has added the delegate**. `docs/STATUS.md` mentions this in passing. The README says "every user fund move goes through a Circle PIN challenge", which is not true for the GA.

**Fix.**
- Make each GA payment user-authorised: either a Circle typed-data challenge the user signs (EIP-712 burn intent from the user's SCA), or a per-payment PIN challenge that the server checks before it signs.
- If a server delegate is unavoidable, use a **separate delegate key per user or per purpose**, held in an HSM/KMS. Add per-user daily limits and require re-authentication above a threshold.
- Add `/circle/gateway/pay` to the `SENSITIVE` rate limit and notify the user on every GA spend.

---

### EV-02 — High — Recycled `@handles`: held payments go to the previous owner

**Where:** `server/src/store/db.ts:582-640` (`anonymizeUser` deletes `user.handle` but never unlinks on-chain), `server/src/routes/api.ts:86-131` (`scheduleIdentityLink`: on a conflict it logs "Not retrying" and the new user keeps the handle), `server/src/store/db.ts:485-501` (new users get a default handle without an on-chain check), `server/src/services/heldPayments.ts:352-420` (`releaseToRecipient` pays `target.account` from the chain, then credits `store.findUserByHandle(...)`), `server/src/services/heldPayments.ts:123-135` (`roleFor` uses the *current* handle).

**What happens.** A handle has two sources of truth:

| Path | Resolves `@alice` via |
|------|-----------------------|
| Direct send (`resolvePayee`) | The database: whoever holds the handle now |
| Held payment (`PaymentEscrowV3.claimWithAttestation`) | The on-chain registry: whoever it was **first** linked to (the registry never re-assigns a key) |

When user A deletes their account, the handle is freed in the database, but A's on-chain link stays **active**. User B then gets `@alice`, either as a default at sign-up (the email local part, `db.ts:485`) or by choosing it. B's own on-chain link fails with `IdentityConflictError`, which is only logged. From then on:

- Any **held** payment to `@alice` — including the **10-minute first-payment wait, which is on by default** — is released on-chain to **A's orphaned wallet**. `releaseToRecipient` then writes "Payment received" into **B's** activity and sends B a money-in alert. The payer sees "Held payment sent".
- B holds the "worker" role on those holds (`roleFor` matches on the handle). So B can mark work delivered and start the 7-day auto-release that pays A.

After a *handle change* (as opposed to a deletion), the old handle is unlinked (inactive but still owned by A). A new owner then leaves those holds stuck until they refund. If the unlink fails (`api.ts:2800`, "cleanup pending"), the link stays active and the misdirection above applies to A, **who is still an active user and actually receives the money**.

**Impact.** Money is paid to the wrong person or becomes unreachable, and Evabob's records say the right person was paid. Both payer and payee are misled.

**Fix.**
- On deletion and handle change, `linkerUnlink`/`adminUnlink` every on-chain identity for the wallet, and retry until it succeeds (a queued job, not a best-effort log line).
- **Reserve** handles whose on-chain key is owned by another wallet: `isHandleTaken` must consult the registry. Never give a new account a handle it cannot link.
- In `releaseToRecipient`, record the receipt for the user who **owns `target.account`**, not for whoever holds the handle today. Refuse to release (and alert an operator) if the two disagree.
- Base `roleFor` on the wallet or immutable account id stored at hold creation, not on the current handle.

---

### EV-03 — Medium — Ops wallet is an open CCTP relayer (gas drain)

**Where:** `server/src/routes/circle-wallets.ts:970-1150` (`POST /v1/circle/cctp/finish`), `server/src/services/appKitMoney.ts:1840-1940` (abandoned-bridge completion), `server/src/index.ts:165-195` (bridge routes not covered by `SENSITIVE`).

**What happens.**
- `/cctp/finish` accepts **any** `burnTxHash`. It never checks that the burn belongs to the caller or to one of their jobs. It then mints on the destination chain **from the ops wallet, paying destination gas**. Any signed-in user can have Evabob relay any Arc CCTP V2 burn with an open `destinationCaller`, including other people's.
- Abandoned bridges are finished from the ops wallet after 40 minutes. There is **no minimum bridge amount**, and `/app-kit/ucw/bridge` is limited only by the general 300/min rate limit. The "2× gas charge" is recorded but never collected (`appKitMoney.ts:1925`).

**Impact.** The ops wallet's ETH on Base and Ethereum Sepolia can be drained by micro-bridges or by relaying third-party burns. Once it is empty, real users' bridges stall. The cost is small on testnet, but on mainnet every Ethereum mint costs real dollars.

**Fix.** Only mint burns tied to a job the caller owns, and check the burn's `mintRecipient` is the caller's wallet. Set a minimum bridge amount that covers relay gas. Add bridge, `cctp/*` and `gateway/*` routes to the `SENSITIVE` limit. Cap relay spend per user per day, and collect or deduct the relay fee.

---

### EV-04 — Medium — Rate limits bypassable by spoofing `X-Forwarded-For`

**Where:** `server/src/middleware/rate-limit.ts:72-87`, `render.yaml:37` (`TRUST_PROXY=true`), `server/src/index.ts:158`.

**What happens.** With `TRUST_PROXY` on, `callerKey` takes the **left-most** `X-Forwarded-For` value. Clients control that value; proxies *append* the real address on the right. The general limiter also runs before auth, so it keys *every* request (signed-in or not) by that spoofable IP.

**Impact.**
- **Bypass:** a random `X-Forwarded-For` per request gets a fresh bucket, so the 300/min pre-auth limit and all public endpoints are effectively unlimited. That includes `/v1/public/claims/:id` enumeration (EV-05), the `/x/:id` paywall and `/users/lookup` from many accounts.
- **Targeted lockout:** sending `X-Forwarded-For: <victim IP>` fills the victim's bucket, so their requests return 429.

**Fix.** Use the right-most untrusted hop (the number of trusted proxies is known on Render), or Render/Cloudflare's single client-IP header. Add a second, authenticated per-user limit after auth. The comment in `index.ts` says verified users are keyed by user id, which is not what happens for the general limiter.

---

### EV-05 — Medium — Email/wallet enumeration and wallet de-anonymisation

**Where:** `server/src/routes/api.ts:2737` (`GET /users/lookup?to=`), `api.ts:1449` (`GET /payees/check?to=`), `api.ts:912` (`GET /escrow/recipient-status?identifier=`), `api.ts:440` (`GET /v1/public/claims/:transferId`, **unauthenticated**).

**What happens.** The earlier audit's M-05 was fixed for chat only:

- `/users/lookup` maps **any email or any wallet address** to that person's `@handle` and display name.
- `/payees/check` returns the **wallet address**, handle, display name and avatar for any email. For a raw address it can return the person's email as `coolingOff.recipient`.
- `/escrow/recipient-status` says whether an email is registered.
- `/public/claims/:transferId` uses **sequential on-chain transfer ids**, so anyone can walk 1…N without signing in. For every held payment (claim links **and** job holds) it returns the sender's name, handle and avatar, and `readTransfer` exposes the sender's wallet. That publicly links wallet ↔ identity for every escrow sender.

**Impact.** Lists of breached emails can be checked for Evabob membership and turned into wallet addresses. Every on-chain escrow sender can be de-anonymised by anyone. Combined with EV-04, rate limits don't slow this down.

**Fix.** Return payee details only as part of a send the user has started, and log and throttle it per target. Require the chat-style "invite" model for email lookups. Key public claim pages on a random token (like receipts, `publicReceipts.ts:49`), not the on-chain id, and drop the sender identity (or show a first name only) until the recipient has proven the email.

---

### EV-06 — Medium — Account deletion strands funds and locks the person out forever

**Where:** `server/src/routes/api.ts:695-733` (`DELETE /users/me`), `server/src/store/db.ts:730-739` (`accountIdForSignIn` still finds the deleted record by `id === subject`), `server/src/middleware/auth.ts:150-160` (403 `ACCOUNT_DELETED`), `mobile/lib/features/profile/profile_screen.dart:243-330`.

**What happens.** Most accounts use the Dynamic subject as their id. After deletion, signing in with the same Dynamic account matches the deleted record and returns `403 ACCOUNT_DELETED` for good. The Circle wallet belongs to that id, so its balance, pending holds (as payer or payee) and circle commitments can no longer be reached through Evabob. The sheet says "*Money already in your wallet is not deleted*", which is literally true but misleading. Deletion also does not unlink on-chain identities (feeds EV-02), and the response claims `deepseek: "external AI processing is disabled"` even where it is enabled.

**Fix.** Block deletion (or require an explicit "send my balance to…" step) while there is any balance, pending hold, open circle or agent balance. Unlink on-chain identities. Allow the same person to sign up fresh after deletion. Only report processor states that are actually true.

---

### EV-07 — Medium — Account-recovery safety delay cannot be used by the victim

**Where:** `server/src/services/account-recovery.ts:57-64` (the alert links to `evabob://account-recovery/<id>`), `mobile/lib/core/navigation/app_link_service.dart:17-29` (`account-recovery` is not in the allowlist, so the link is dropped), and no mobile code calls `/v1/users/recovery/*`.

**What happens.** The recovery design is sound: explicit request, emailed code, 24-hour cooling-off, alert to the old account. But the account owner has **no screen to cancel it**, and tapping the alert does nothing. The person *requesting* recovery also has no UI, so legitimate recovery (for example after a Dynamic subject change) is impossible without API tooling.

**Impact.** Someone who compromises the email account can take the Evabob account over after 24 hours, and the victim cannot use the one safeguard that exists.

**Fix.** Build the "Someone is trying to recover your account — Cancel" screen and add `account-recovery` to `_routesWithId`. Also send the alert by **email** (and keep it within the app), and add a requester-side flow.

---

### EV-08 — Medium — Savings circles: allowance overwrite and no collateral

**Where:** `server/src/services/groupMoney.ts:293-308` (`joinCallsFor` → `approve(contract, commitment)`), `contracts/src/MoneyCircles.sol` (`join`, `collect`, `_tryPull`).

**What happens.**
1. **Allowance overwrite.** Every circle shares one `MoneyCircles` contract, and ERC-20 allowances are per spender. Joining circle B signs `approve(contract, commitmentB)`, which **replaces** whatever allowance was left for circle A. The member then silently runs short in one circle. They get marked "behind", moved to the end of the payout order, and put in debt, without having done anything wrong.
2. **No collateral.** A member paid out early can revoke the allowance or empty their wallet, and every later round just records a debt. The contract says "*nobody holds it … the classic failure of a savings circle is the collector*". The classic failure is actually early recipients defaulting, and nothing here stops it.

**Fix.** Approve `currentAllowance + commitment` (or use per-circle vault deposits). Offer a "collateralised" mode where each member deposits one or more contributions up front. Show a clear "this circle depends on everyone paying; early recipients could stop" warning before joining. Surface member track records.

---

### EV-09 — Medium — Privacy notice contradicts what the hosted testnet does

**Where:** `src/app/privacy/page.tsx:38-66`, `render.yaml` (`FEATURE_ONCHAIN_EMAIL_LINKS=true`, `FEATURE_ONCHAIN_MEMOS=true`, `MEMO_CONTRACT_ADDRESS`, `FEATURE_EXTERNAL_LLM=true`), `server/src/services/agentTools.ts:438-512`, `mobile/lib/features/send/send_screen.dart:852`, `server/src/services/memo.ts:21`.

**What happens.**
- The notice says "*Evabob does not put … free-text payment descriptions on-chain*". On the hosted testnet, memos **are** written on-chain by `EvabobMemo`, and the memo field says only "Add a memo (optional)". `memo.ts` says "*The app says so where the memo is typed*", but it doesn't.
- The notice says AI requests use "*short-lived aliases*". There is no aliasing code. `get_profile`, `get_receive_details` and `get_contacts` return raw email, wallet and contact addresses to DeepSeek once a user opts in.
- Email → wallet hashes (earlier finding H-06) are still being written to Arc for real testers' emails.

**Impact.** Testers' real emails and free text are permanently public on a public chain, while the notice tells them otherwise.

**Fix.** Turn off the two on-chain flags on testnet too, or change the notice and add an explicit "this memo is public forever" warning. Implement the aliasing layer, or remove the claim.

---

### EV-10 — Medium — Resource exhaustion: no per-user quotas, long-held requests

**Where:** `server/src/routes/api.ts:3876` (agents: each provisions a Circle developer-controlled wallet), `server/src/services/paywalls.ts:233-295` (10 MB of files per paywall into Mongo and disk), hold links, payment requests, `api.ts:3082` (chat text has no max length; the 512 KB body limit applies), `circle-wallets.ts:1610` (`/verify-challenges` holds a request open for up to 10 min 45 s), `circle-wallets.ts:970` (up to 6 min).

**Impact.** One account can fill the Atlas database (100 MB/min through paywalls within the `SENSITIVE` limit), create unlimited Circle wallets, or tie up the single 512 MB Render instance with long-held requests.

**Fix.** Add per-user caps (agents, paywalls, storage bytes, open links), a message length limit, and a server-side cap on long polling (return a job id and let the client poll).

---

### EV-11 — Low — Claim-link emails are a phishing channel

**Where:** `server/src/services/notify.ts:53-70` (subject `"${fromName} sent you ${amt} USDC — claim on Evabob"`, memo in the body), `server/src/routes/api.ts:974-1060`, `render.yaml` `SMTP_FROM="Evabob <evabobxyz@gmail.com>"`.

A sender controls `displayName` (48 characters) and `memo` (120 characters), and a hold can be for $0.000001, which the email shows as "0.00 USDC". That lets anyone send emails from Evabob's sender to any address saying "*Evabob Security sent you 0.00 USDC*" with a scam note. HTML is escaped (good), but clients auto-link plain-text URLs. Separately, sending as `@gmail.com` through Brevo fails DMARC alignment, so real claim emails and OTP codes are likely to land in spam.

**Fix.** Use a fixed subject. Show only the verified handle, never the display name. Put a minimum on claim-link amounts. Strip URLs from memos in emails. Send from an owned domain with SPF, DKIM and DMARC.

---

### EV-12 — Low — Family check and platform fee enforced on only some spend routes

**Where:** `requireFamilyPass` is called only at `circle-wallets.ts:375, 1215, 1317`. The fee is built only on `/circle/send`, `/send-batch`, `/escrow/hold*` and Gateway pay.

`/circle/transfer` (`circle-wallets.ts:299`), `/app-kit/ucw/send|spend|compose` and `/circle/cctp/burn` move user money without the family check or the fee. The family check is anti-scam friction rather than a hard control, since the user still enters their PIN. But `docs/STATUS.md` says it is "*enforced by the server on sends, holds and milestone payments, not only in the app*", and anyone scripting the API can skip the 0.05% fee. `/circle/transfer` also writes an activity row before the PIN.

**Fix.** Route every user send through one policy function (payee checks, family check, fee, activity). Retire `/circle/transfer`.

---

### EV-13 — Low — Public web: fake wallet at `/`, report-only CSP, Host echo

**Where:** `src/app/page.tsx` (redirects to `/home`), `src/lib/mock-data.ts`, `next.config.mjs:6-22`, `src/app/claim/page.tsx:68,99`.

- The public web service's root shows a **fully styled wallet with made-up balances** ("Victor En", €4,280.55, a Spotify payment). Anyone who opens the domain sees a fake financial account. That confuses users and hands phishers a ready-made template. `docs/STATUS.md` calls `src/` "dead", but it is deployed.
- The CSP is `Content-Security-Policy-Report-Only` with **no `report-uri`/`report-to`**, so it neither enforces nor reports anything. `script-src 'unsafe-inline'`, and `connect-src` is hard-coded to one Render host.
- The claim page prints the request's `Host` header as the "address bar" text.

**Fix.** Delete the `(app)` mock routes and the mock data, and serve a simple landing page. Enforce the CSP with nonces (Next 16 supports this) and add a report endpoint. Use `APP_PUBLIC_URL` instead of `Host`.

---

### EV-14 — Low — Default handle and display name expose the email address

**Where:** `server/src/store/db.ts:485-501`.

New users get `handle = email local part` and `displayName = Email local part`. Both are shown to everyone they chat with or pay (see `error/111.png`: header "ekumavictor97"), and the handle is written to the on-chain registry. For common providers the full email is easy to guess.

**Fix.** Default to a neutral handle suggestion and ask for a display name at onboarding. Don't pre-fill either from the email.

---

### EV-15 — Low — "Retry later" 503 after a state change may already have happened

**Where:** `server/src/index.ts:106-121`.

If the Mongo flush fails *after* a handler ran, the client gets `503 … Retry later`. By then a server-signed action (an escrow release, a refund, a Gateway send, an operator decision) may already be on-chain. Most of those paths check on-chain state before acting, but the message tells the client to retry an operation that may have succeeded.

**Fix.** Return a "pending reconciliation" status with the operation id. Reconcile from chain state on the next read.

---

### EV-16 — Info — Cron secret compared with `===`

**Where:** `server/src/index.ts:393-397`. Use `timingSafeEqual` and rate-limit `/internal/cron/*`. The risk is low given the 32-byte generated secret.

---

## 3. Status of the 19 September audit findings

| ID | Title (short) | Status | Evidence / what is left |
|----|---------------|--------|-------------------------|
| C-01 | Cleartext Android traffic | **Fixed** | `usesCleartextTraffic="false"` in main, debug-only override; release builds require an HTTPS origin (`env.dart:83-92`); `dart_defines.json` is HTTPS; old sessions cut off with `AUTH_SESSION_INVALID_BEFORE`. |
| H-01 | JWT claims / email merge | **Fixed** | Issuer, audience, `iat`/`exp`, `user:basic` and `verified_credentials` enforced (`dynamic-auth.ts:74-100`); email never selects an account (`db.ts:730`). The recovery flow that replaced it has no UI (EV-07). |
| H-02 | Tokens in device logs | **Fixed** | Token logging removed. Minor: `evabob_auth.dart:391` still prints exception and stack for `sendEmailCode` without a `kDebugMode` guard. |
| H-03 | Plaintext agent keys | **Fixed in code** | `start:prod` runs `remediate-credentials` and `primary-store.ts:112` rejects `apiKeyFull`. Rotation of the live data was not verifiable from source. |
| H-04 | Public chat/evidence photos | **Fixed** | Auth plus participant/role ACL, expiry and `private, no-store` (`index.ts:204-275`); the review route checks the role before storing. |
| H-05 | CDN JS in the PIN WebView | **Fixed** | SDK bundled with a SHA-256 check, CSP and a subframe allowlist. Note: the checksum ships in the same APK, so it catches corruption, not tampering. |
| H-06 | Email → wallet on-chain | **Partial** | Blocked for `production` by `production-safety.ts`, but **on** for the hosted testnet (EV-09). |
| H-07 | Memos on-chain | **Partial** | Escrow now uses a random reference (fixed). `EvabobMemo` is **on** for testnet with no UI warning (EV-09). |
| H-08 | Data to DeepSeek | **Partial** | Opt-in per user, no chat history sent. Tool results still contain raw email, wallet and contact addresses; the notice's "aliases" claim is not implemented. |
| H-09 | No deletion / privacy notice | **Mostly fixed** | Export + delete endpoints and UI, Terms and Privacy pages. Login consent text is not linked; deletion strands funds (EV-06). |
| M-01 | App-lock PIN | **Fixed** | 6–12 digits, Argon2id, attempt lockout, fails closed. |
| M-02 | Vulnerable dependencies | **Partial** | Android Circle SDK pinned (`1.0.1189`); web `npm audit` shows 0. Server `npm audit --omit=dev` still reports **27 (11 high)**, all through the Circle App Kit / Solana / `toml` graph. |
| M-03 | Custom-scheme deep links | **Partial** | HTTPS App Links (`autoVerify`) + Universal Links + strict route allowlist added. The `evabob://` scheme is still registered; `evabob.app` ownership and `assetlinks.json` were not checked (network blocked). |
| M-04 | Lock-screen previews | **Fixed** | Generic FCM body; Android `private` visibility. (UX trade-off: see UX-07.) |
| M-05 | Email enumeration | **Partial** | Chat no longer probes emails; other routes still do (EV-05). |
| M-06 | Irrevocable receipts | **Fixed** | Revoke, rotate and expiry, `noindex`, `no-store`. |
| M-07 | Instance-local rate limits | **Partial** | Shared Mongo buckets added; `X-Forwarded-For` is spoofable (EV-04). |
| M-08 | Missing web headers | **Partial** | HSTS, `nosniff`, frame denial and referrer policy added; CSP report-only with no reporting (EV-13). |
| L-01 | Excess permissions | **Fixed** | `WRITE_CONTACTS` removed; purpose strings rewritten. |
| L-02 | Identifiers in logs | **Fixed** | Route templates + pseudonymised user ids (`index.ts:122-150`). |
| I-01 | Contracts not run | **Improved** | CI runs `forge test` and Slither (Slither is `continue-on-error`). No external audit yet. |

---

## 4. Functional bugs and engineering issues

| ID | Issue | Where | Fix |
|----|-------|-------|-----|
| **F-01** | **Every agent-key POST to `/v1/agent-api/*` returns `401 verified_user_required`.** `api.use("*")` in the `/v1` sub-app requires a *user* principal for all non-GET requests. Hono mounts that middleware at `/v1/*`, so it also runs for the separately mounted `agentApiRoutes`. Only `/v1/x402/pay` is exempt. Agents cannot post tasks, accept deliveries, dispute or cancel. Confirmed with a minimal Hono repro (same structure, same Hono version). No test covers these routes. | `server/src/routes/api.ts:48-54`, `index.ts:322` | Add a `/v1/agent-api/` exemption in that middleware (or mount `agentApiRoutes` before `api`), and add route tests with an agent key. |
| F-02 | A worker who changes handle loses the "worker" role on holds addressed to the old handle, so they cannot mark delivered and the money refunds at expiry. | `heldPayments.ts:123-135` | Store the worker's account id and wallet on the hold at creation (see EV-02). |
| F-03 | The keypad always shows **"$0.10 fee · usually a few seconds"**, whatever the amount. The real platform fee is 0.05% (for example $0.0005 on $1). | `mobile/lib/features/send/amount_keypad.dart:64` | Use `PlatformFeeNote` / `features.platformFeeFor(amount)`; hide the line until an amount is entered. |
| F-04 | `GET /challenge` serves `challenge.html` without inserting the Circle SDK (`/*__CIRCLE_SDK_BUNDLE__*/` stays as-is), so the page cannot work. | `server/src/index.ts:384-390` | Remove the route, or inject the bundle the way the app does. |
| F-05 | Two server test files fail under `tsx` on Node 22.22.x: `@circle-fin/developer-controlled-wallets` resolves to its CJS build, which has no named `initiateDeveloperControlledWalletsClient` export. The compiled production build (plain Node ESM) is fine and CI (older 22.x) is green, so dev and CI will break when Node updates. | `server/src/services/agentWallet.ts:25` | Pin the Node minor in CI and `.nvmrc`, or use a default import / `createRequire`. |
| F-06 | New users whose default handle collides with an on-chain link keep the handle silently ("Not retrying"). Nobody is told and nothing is repaired. | `api.ts:86-103` | Raise an operator alert and ask the user to pick another handle (see EV-02). |
| F-07 | Documentation drift: the README says `PaymentEscrowV2 (used)`, "91 tests" and "13 pass"; `docs/STATUS.md` says 310, 378 and 424 in different places; the tester guide says the server runs on a laptop on the same Wi-Fi (the app now points at Render) and that chat works by email (the server refuses email). The redesign brief's green palette and SF Pro no longer match the blue Numans design that ships. | `README.md:82,321,329`, `docs/STATUS.md`, `user_test.pdf` §1, §7, §22 | Generate counts in CI; keep one "current state" doc; update the tester guide. |
| F-08 | `/verify-challenges` accepts `timeoutMs` up to 600 s and then waits another 45 s; `/cctp/finish` can take about 6 minutes. Mobile networks and proxies drop these, so the user sees a failure for a payment that went through. | `circle-wallets.ts:1610`, `:970` | Return right away with a job id; the client polls `GET /jobs/:id`. |

---

## 5. UI/UX errors and improvements

### Errors seen in the saved screenshots (`error/`)

| # | Screenshot | Problem | Status |
|---|------------|---------|--------|
| 1 | `111.png` (chat request card) | The **"Cancel"** button wraps to "Canc / el". The card is a fixed 270 px wide and leaves the right third of the screen empty. The header shows an email-derived name ("ekumavictor97"). | Wrap fixed in `request_card.dart:186`; fixed width and email-derived name remain (EV-14). |
| 2 | `222.png` (Send screen) | Quick-amount chips (`$20.00 $50.00 $100.00 All of it`) spill past the left margin and are inconsistently padded; the memo field is clipped on the right; a **$0.10 fee** shows while the amount is $0 (F-03). | Open. |

### UX issues found in review

| ID | Issue | Suggestion |
|----|-------|------------|
| UX-01 | **The claim flow dead-ends.** A person paid by email opens `/claim`, but `NEXT_PUBLIC_ANDROID_APP_URL`/`IOS_APP_URL` are empty in `render.yaml`, so "Get Evabob" falls back to an `evabob://` link that does nothing without the app. Installing means sideloading an APK past Play Protect warnings. The page says "**THIS LINK ONLY WORKS ONCE**", which is not true (anyone can open it). | Publish a store or TestFlight / internal-testing link, or a signed APK download page. Show a QR code on desktop. Fix the copy. Longer term, let people claim on the web (email OTP + embedded wallet). |
| UX-02 | **Too many features for the core promise.** The Home overflow menu has 9 entries: Request, Sell with a link, Get paid by agents, Work from agents, Circles and collections, Convert, Your GA, Move money, Agent wallets. Most are developer or crypto concepts. | Keep Send / Request / Scan / Activity as the consumer core. Move agents, paywalls, tasks, GA and "move money" into an opt-in **"For builders"** or **"Business"** area, or a separate app. |
| UX-03 | **Jargon left over,** against the brief's own copy rules: "Your GA (Gateway Account)", "Arc Testnet / Base Sepolia / Ethereum Sepolia", pasted `0x` addresses in core flows, "API key", "x402". | Name networks by what they do ("Your main balance", "Other networks"). Rename GA ("Spend anywhere balance"). Hide addresses behind "Advanced". |
| UX-04 | **Text is too small and layouts are fixed.** There are **104** text styles at `fontSize ≤ 10` in `mobile/lib`, and no handling of system font scaling. The fixed-width request card (270 px) and the chip row break at larger text sizes. Only 25 `Semantics` widgets exist in 40k lines, and there is no localisation (`intl` is used only for formatting). | Minimum 12 sp for secondary text. Test at 130% and 200% font scale. Use `Flexible`/`Wrap` instead of fixed widths. Add semantics labels to icon buttons, amounts and cards. Plan Pidgin and Yoruba/Hausa/Igbo strings for the Nigerian market. |
| UX-05 | **Deleting an account misleads** ("Money already in your wallet is not deleted"), and it requires a sign-in under 5 minutes old, with the only hint being "sign out and sign in again". | Show the balance and open holds, and require withdrawal first (EV-06). Do the re-authentication inline (a new OTP) instead of making the user sign out. |
| UX-06 | **Screenshots are blocked everywhere** (`FLAG_SECURE` in `MainActivity.kt:11`). In Nigeria, sharing a screenshot of the receipt is the normal way to prove payment. | Keep `FLAG_SECURE` on PIN, recovery and key screens; allow it on receipts and QR, or add a "Share receipt image" button. |
| UX-07 | **Every push says "You have a new private update."**, including money received, so users have to open the app to learn anything. | Add a privacy setting: generic (default), amount only, or full preview. At minimum, use kind-level text ("Money received", "New message"). |
| UX-08 | **The naira rate is fixed at ₦1,390** (`server/src/services/fx.ts:12`) and shown as if it were live everywhere naira is the main currency. | Label naira figures as approximate and show the rate's date, or use a real rate source. |
| UX-09 | **Handle and name locks are harsh:** 2 months between handle changes and 7 weeks for display names. A typo at onboarding is costly. | Allow free changes in the first 7 days, then apply the cooldowns. |
| UX-10 | **The 10-minute cooling-off is on by default for every first payment,** so a buyer paying a new trader at a market stall waits 10 minutes. Holds also depend on the payee's on-chain link, so they can stall (EV-02). | Keep it on for large first payments or ones flagged risky. Offer a "verified seller" path. Show the payee "arriving in 10 min" instead of nothing. |
| UX-11 | **Login consent is plain text:** "By continuing you agree to the Terms and the Privacy Notice" has no links (`login_screen.dart:226`). | Make "Terms" and "Privacy Notice" tappable. |
| UX-12 | **The memo field doesn't say it is public** on testnet (EV-09). | Add "Anyone can see this note, forever" while on-chain memos are on. |
| UX-13 | **The fee is described in several different ways:** "small Evabob fee", "0.05% on top", "less 0.05% and 2¢", and the keypad's "$0.10". | Use one fee component everywhere, showing the exact amount before the PIN (already exists as `PlatformFeeNote`). |
| UX-14 | **There is no way to report or block** someone in chat. Pending chat invitations exist, but a harasser who is accepted cannot be blocked. | Add Block and Report on the chat header, and on request cards from strangers. |

---

## 6. Feature inventory

What the product does today (from the code, `docs/STATUS.md` and the tester guide). "Built" means the code exists; STATUS says what has actually run end to end.

### People

| Area | Features |
|------|----------|
| **Account** | Email OTP sign-in (Dynamic); Circle user-controlled wallet with a payment PIN (SCA on Arc Testnet, Base Sepolia, Ethereum Sepolia); `@handle`; display name; profile photo or built-in avatar; naira or dollar as main currency; app lock (PIN or biometrics); light/dark theme; data export; account deletion; account recovery (server only, no UI). |
| **Send** | Send by `@handle`, email or `0x` address, or by scanning a QR code; dollars (USDC), euros (EURC), cirBTC; memo; saved contacts; payee check sheet (real name, photo, "paid before", address-poisoning warning); 10-minute cooling-off hold for first payments; family check (emailed code above a limit); "hold it for them" claim links for people without an account; pay several people at once (batch, off by default). |
| **Receive** | QR and address per network; money from outside Evabob detected on Arc, Base Sepolia and Ethereum Sepolia; "Money in" view with today's total; money-in and money-out sounds. |
| **Requests & invoices** | Multi-line invoices; due dates with automatic reminders; named payer; pay by milestone (2–10 holds, one PIN); public pay page `/pay/{id}`; request cards in chat (Pay / Cancel); pasted links become cards. |
| **Held payments** | Job holds (worker marks delivered; payer confirms or 7 days of silence releases); cancel before delivery; after-delivery disputes go to an operator review with a message thread, links and photo evidence; claim links (7 days); cooling-off (10 min). All backed by `PaymentEscrowV3`. |
| **Sell with a link** | One link per item with price and delivery window; the buyer's money is held until delivery; public page `/h/{id}` with the seller's track record. |
| **Circles & collections** | Rotating savings circles (ajo/esusu) on `MoneyCircles`; group collections with target, deadline and automatic refunds on `GroupPots`; public progress page `/g/{id}`; a keeper runs rounds and refunds. |
| **Chat** | 1:1 threads with invitation/accept; realtime over Pusher; photos; request and link cards; badges; push notifications. |
| **Evabob assistant** | Plain-language assistant (DeepSeek, opt-in) with 10 read tools, a knowledge base and "propose" tools that build a confirm card. It can never move money itself; falls back to a rule-based parser. |
| **Activity** | Full history with filters; receipts; downloadable receipt; public proof-of-payment link `/r/{id}` re-verified on-chain, revocable and rotatable. |
| **Convert** | USDC ↔ EURC on Arc (App Kit swap; Synthra fallback). |
| **Your GA** | Circle Gateway unified balance: top up from any network; pay out to any network; scheduled payments while approvals finalise. |
| **Move money** | CCTP bridge between Arc, Base Sepolia and Ethereum Sepolia; resume unfinished moves; server finishes abandoned bridges after 40 min. |
| **Notifications** | Pusher in-app and FCM push; money alerts; hold reminders; chat; review alerts to operators. |

### Agents and builders

| Area | Features |
|------|----------|
| **Agent wallets** | A dedicated Circle-held EOA per agent; API key shown once, rotate/revoke; funding verified on-chain then deposited to Gateway; allowance (amount, window, categories, ask-above threshold); approvals by push; loop breaker; pause and "Freeze all"; withdraw to owner; `@names` for agents; spend evidence bundles (hash-chained). |
| **x402 payments** | `POST /v1/x402/pay` for agents with an HTTPS allowlist, idempotency keys, reservation-before-sign, and an SSRF-safe client. |
| **Get paid by agents (paywalls)** | Sell files, text, your API or your time behind HTTP 402; "pay after proof" (settle only if the delivery checks out); bookings with accept/decline; batched payouts. |
| **Work from agents (tasks)** | Agents post paid tasks for people; the fee is held on-chain before work starts; delivery releases it. The agent-side API is broken: F-01. |

### Operations

- Operator review screen for disputed holds; operator allowlist.
- Scheduled tick (releases, refunds, reminders, circle keeper, Gateway tracker, inbound scan).
- `/v1/health` checks on-chain roles (Safe threshold, linker, attestor).
- 2-of-3 Safe owns contract admin roles; separate ops, identity-linker and escrow-attestor keys.
- CI: server typecheck/tests, `npm audit`, SBOMs, gitleaks, Flutter analyze/test, Foundry tests, Slither.

---

## 7. What to improve or change

### Product

1. **Narrow the product.** The core loop (sign up → get paid → send → prove it) is strong and different: chat-native requests, held payments for informal commerce, naira framing, proof links. The agent/x402/paywall/task suite is a separate product for a separate audience. Ship it as "Evabob for builders", or pause it, and put the effort into the consumer core.
2. **Solve getting money in and out before anything else.** STATUS lists "the ramp decision" as deferred. Without a naira on/off-ramp (a licensed partner under Nigeria's August 2026 framework), real users cannot fund or spend their balance, and every other feature waits on it.
3. **Make claim links a real acquisition channel.** The recipient who is not on Evabob yet is the growth loop. They need a store link, a web claim path, and an email that doesn't look like spam (EV-11, UX-01).
4. **Protect savings circles.** Offer collateral, track records and clear warnings (EV-08). Circles are a strong cultural fit, and one bad circle would badly hurt trust.
5. **Keep the trust features, tuned:** the payee check, poisoning warnings and proof links are excellent. The cooling-off hold needs thresholds (UX-10), and the family check should go through one policy function (EV-12).

### Architecture

1. **Move off the single-snapshot store.** All state lives in one in-memory object that is snapshotted to Mongo, behind one writer lease, on one 512 MB instance. That caps scale and availability, and a crash between action and flush can lose records (EV-15). Move money records (holds, jobs, activity) to per-record Mongo documents with unique indexes and transactions first.
2. **One identity source of truth.** Handles, emails and wallets must resolve the same way off-chain and on-chain (EV-02). Treat the registry as authoritative for anything that pays on-chain, or stop using on-chain identity keys for handles and store a wallet (or a random recipient id) in escrow instead.
3. **Custody boundaries.** Nothing server-side should be able to move user funds without the user's signature (EV-01). Put the ops, linker and attestor keys in a KMS/HSM with per-key spend limits and on-chain monitoring.
4. **Split the 4,400-line `routes/api.ts` and 2,600-line `appKitMoney.ts`.** Route-level policies (auth, rate limits, fee/family checks) should be declared per route group, not by path lists in `index.ts`. That drift is what produced F-01 and EV-12.
5. **Test the route matrix.** Add automated tests that call every route as anonymous, user A, user B, operator and agent key. That would have caught F-01, EV-03 and EV-05.
6. **Dependency posture.** Work with Circle on the App Kit dependency graph (27 advisories). Drop unused Solana adapters if App Kit allows it. Pin Node minor versions (F-05).
7. **Remove dead code.** Delete the Next.js mock wallet, `/challenge`, the retired 410 routes once no old builds remain, and the legacy Gateway/CCTP routes (`APP_KIT_KEEP_LEGACY`).

### Before real money (release gate)

- [ ] EV-01, EV-02, EV-03, EV-06 fixed and re-tested.
- [ ] External smart-contract audit of `PaymentEscrowV3`, `IdentityRegistryV3`, `MoneyCircles` and `GroupPots`, plus Foundry invariants for fund conservation.
- [ ] Privacy notice matches the production config; on-chain email/memo flags off; AI minimisation implemented (EV-09).
- [ ] Licensed ramp partner, KYC/AML and transaction monitoring decided.
- [ ] Per-record persistence, backups, and a multi-instance-safe writer.
- [ ] Owned sending domain with SPF, DKIM and DMARC; store listings; verified App Links / Universal Links on an owned domain.

---

## 8. Repository hygiene

These files are tracked in git and should be removed and ignored:

| Path | Why |
|------|-----|
| `%SystemDrive%/ProgramData/Microsoft/Windows/Caches/*.db` | Windows system cache files, committed by accident. |
| `.idea/` (including `workspace.xml`) | IDE state; `workspace.xml` contains a local path with the developer's Windows username. |
| `.vscode/settings.json` | Personal editor settings (keep only if intentionally shared). |
| `create-wallet.ts`, `register-entity-secret.ts` (root) | One-off Circle setup scripts; move them to `server/src/scripts/` with docs. |
| `user_test.pdf`, `evabob-payments-research-2026-09.pdf`, `error/*.png` | Binary documents in the code repo; move to `docs/` or a wiki. |
| `.railway/railway.ts`, `server/vercel.json` | Config for hosts not in use (Render is the target). |
| `mobile/dart_defines.json` | Contains the Firebase Android API key. That key is a public client identifier, but restrict it in Google Cloud (Android app + SHA-256 signing cert) so it cannot be used from elsewhere. |

No private keys, Mongo URIs or live API keys were found in the git history (a pattern scan across all commits, backed by gitleaks in CI).

---

## 9. What is done well

- **Money cannot be faked by the client.** Every "completed" payment is checked against the on-chain receipt (sender, recipient, token, amount, no reuse) before it is recorded (`confirm-payment.ts`). Retired ledger routes return 410.
- **Escrow design.** `PaymentEscrowV3` resolves the recipient itself, refunds only ever go to the original sender, expiry extension is capped, and admin roles belong to a 2-of-3 Safe. There are 60+ Foundry tests, including fuzzing.
- **SSRF protection** for agent and paywall fetches: exact HTTPS origins, DNS pinned at connect time, public IPv4 only, no redirects, size and time caps (`safe-agent-http.ts`).
- **The AI assistant cannot move money.** Proposals are validated server-side, and the confirm card is rebuilt from validated data, not model output.
- **Auth hardening**: strict Dynamic claim validation, no email-based account merging, and step-up for export and deletion.
- **Production fail-safes**: `assertProductionSafety` refuses to start a hosted build with header auth, wildcard CORS, missing Mongo, non-HTTPS origins, shared hot keys, or privacy-sensitive flags on in production.
- **Honest documentation.** `docs/STATUS.md` records failures, recoveries and open gaps plainly, which made this audit much faster.
- **Thoughtful copy.** Error messages are plain and carry a reference code that matches the server log; the product avoids crypto jargon in most places.

---

## 10. Limits of this audit

- **No live testing.** The sandbox network blocked `evabob.app`, `evabob.me` and the Render hosts, so the deployed services, TLS, App Link verification and `assetlinks.json` were not checked. No transactions were sent.
- **Flutter and Foundry were not run.** Their toolchains are not installed here. CI runs both, and the latest `main` run is green.
- **Server tests:** 420 of 422 pass locally. The 2 failures are the Node 22.22 import problem (F-05), not logic failures.
- **Coverage:** the review was deep on authentication, authorisation and every money-moving route, and lighter on less-used services (`gatewayTracker`, `inbound` scanning, `agentTasks` internals, `paywalls` settlement maths). A second pass there, and an external contract audit, are recommended.
- The earlier `SECURITY_AUDIT.md` is left unchanged as the historical record. §3 of this report gives the current status of each of its findings.
