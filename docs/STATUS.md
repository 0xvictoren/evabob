# Evabob — build status

**Single source of truth for what is built.** If another document disagrees with
this file, this file is right. Supersedes the former `new.md` and the progress
tables that used to live in the README.

Last verified: 2026-09-25 (cirBTC, flat fee, web terms; testing feedback, second pass; App Kit only, payment reliability); 2026-09-24 (testing version stable 1); 2026-09-19 (testing feedback batch); 2026-09-18 ("For people" and fix-first batches); earlier sections 2026-09-13.

---

## What this project is

A **testnet integration showcase** for the Circle stack — App Kit, User-Controlled
Wallets, CCTP, Gateway and x402 — wrapped in a consumer payments product shell
(Flutter app + Hono API + two Solidity contracts).

It has **never held real value and has no users**. Everything runs on Arc Testnet
and other public testnets. Do not read "live" below as "in production" — it means
"implemented and exercised by hand on testnet".

---

## Legend

| Mark | Meaning |
|------|---------|
| **Works** | Implemented and manually exercised end to end on testnet |
| **Partial** | Implemented but a known step is blocked, paused, or unverified |
| **Stub** | Route or UI exists, does nothing real |
| **Not built** | Referenced somewhere but absent from the code |

---

## cirBTC, flat fee, web terms — 2026-09-25

Server 456 tests, Flutter 69 tests, typecheck and analyze clean. Not yet run
on a phone; the iOS change is unverified (no Mac build here).

| Area | What changed |
|------|--------------|
| cirBTC | Converts to and from dollars and euros through App Kit (quotes checked live). Shown only in the wallet: a "Bitcoin" line under Currencies on Assets, like Euros, never added to the dollar total. Uses the new `cirbtc.png` icon everywhere assets are shown. |
| Platform fee | A flat ~$0.02 per transaction replaces 0.05%: 0.02 USDC, 0.02 EURC, or $0.02 of cirBTC at App Kit's price (refreshed hourly). `PLATFORM_FEE_FLAT_USD`. App Kit takes a swap fee only as whole basis points, so a swap pays the nearest whole-bp rate — exactly $0.02 at $2, a little more above ~$200. Money circles and group pots keep their contract-fixed 0.05%. |
| Terms and Privacy | Profile opens https://www.evabob.xyz/terms.html and https://www.evabob.xyz/privacy.html inside the app (the existing WebView; only evabob.xyz pages load). |
| iOS | Screen recording and mirroring no longer blank the app (the capture cover is gone), matching Android's allowed screenshots. The app-switcher cover stays. |

---

## Testing feedback, second pass — 2026-09-25

Server 450 tests, Flutter 69 tests, typecheck and analyze clean. Not yet run
on a phone.

| Area | What changed |
|------|--------------|
| Swap quote missing; bridge "Simulation failed on Arc Testnet: Request exceeds defined limit" | Both came from App Kit's adapters calling the public Arc RPC, which rate-limits this server (the message is viem's wording for JSON-RPC -32005). The user-wallet adapter now uses `ARC_APP_KIT_RPC_URL` (default QuickNode) and the ops adapter the retrying fallback transport. Quotes checked live. |
| Synthra | Back for swaps, as the user asked. App Kit first; Synthra runs only when App Kit's attempt ended before any PIN, so a swap can never run twice. Quotes fall back to Synthra too. A Synthra swap can now be confirmed (conversions used to be refused, so they stayed "On the way") and stale ones are settled from the chain. Bridges stay App Kit only. |
| Balance checks | Every money route checks the balance on the chain the money leaves from — amount plus the Evabob fee — before any PIN (`services/balanceGuard.ts`). |
| Live balances | The balance drops on screen the moment a payment goes through; the server sends a silent `balance` signal when it confirms a send or swap, records a hold or finishes an App Kit job, and the app re-reads balances and activity on that and on every money alert. `/wallet/balances` answers faster: Arc reads fail over quickly instead of waiting out a rate limit, and the other networks get a 2 s grace with their last reading, like the Gateway. |
| Gateway Account top-up stuck "on the way" | Gateway had credited it (no pending batch); the App Kit job's runner never returned, so the job stayed "running". Single-transaction jobs (swap, send, top-up, spend) now stop waiting after 13 minutes and the chain decides how they ended. Jobs stuck before this deploy close on the restart. |
| Sell links | The seller no longer sees "Pay safely" on their own link, in chat or when opening it. When a buyer sets money aside, the seller's Home "Your money" shows it first — "The money is there" — and opens to **Delivered** or **Return the money**, as for invoices. |
| Naming and menu | "Your GA" is "Gateway Account" everywhere people read it. Menu: Request, Sell with a link, Circles and collections, Get paid by agents, Work for agents, Convert, Gateway Account, Move money, Agent wallets. |
| Screenshots | Allowed in the app (`FLAG_SECURE` removed), for receipts and presentations. |

---

## App Kit only, and payment reliability — 2026-09-25

Synthra was retired in this batch and brought back for swaps in the next one (above).

From hands-on testing on 2026-09-24/25. Each cause below was confirmed
against Arc Testnet itself, not inferred from the code. Server 450 tests,
Flutter 69 tests, typecheck and analyze clean. Branch
`fix/app-kit-only-and-payment-reliability`. The APK
`evabob-testing-app-kit-only.apk` at the repo root is signed with the testers'
key (`1ae17ab3…`), so it installs over the current app. Not yet run on a phone.

### Swaps and bridges: Circle App Kit only

| Area | What changed |
|------|--------------|
| Swap | App Kit is the only rail. The app used to fall back to Synthra whenever App Kit's swap had not finished reporting, even after its PIN — so one conversion asked for a second PIN and swapped twice (seen on chain: 2 USDC swapped at 23:43 and again at 23:44 UTC). |
| Swap quotes | From App Kit's own `estimateSwap` (`POST /v1/app-kit/swap/quote`), priced with the server's adapter — no PIN, nothing moves. Checked live for USDC↔EURC, USDC→cirBTC and a pasted token address. The "decimal places" box on Convert is gone; App Kit knows each token's decimals. |
| Swap jobs | A token address is passed to App Kit as typed (upper-casing turned `0x` into `0X`). A swap job with no answer after 13 minutes stops waiting and the chain decides whether it landed, instead of staying "running" until a restart. A swap is never shown as on hold. |
| Bridge | App Kit only. If App Kit cannot start a bridge, the app says so — no PIN was asked and nothing moved. Arc, Base Sepolia and Ethereum Sepolia are all App Kit chains, so no route was lost. |
| Legacy rails | `APP_KIT_KEEP_LEGACY` now defaults to `false`. With it off, `/v1/cctp` and `/v1/gateway` are not mounted, and `/v1/circle/swap` and `/v1/circle/cctp/burn` answer 410 `LEGACY_RAIL_RETIRED` before any PIN, so an older APK cannot run a second swap or burn. `/v1/circle/cctp/finish` stays, to finish burns already made. |

### Payments

| Area | Cause | What changed |
|------|-------|--------------|
| Sends stuck "pending" | Both ₦1,000 sends to @maxxi landed on chain, but a send becomes a receipt only when the app reports its hash once, right after the PIN. That call failed and nothing retried. | Opening Activity now checks the chain for stale pending sends (`services/sendReconcile.ts`): a transfer found is confirmed through the usual verification and the payee's receipt is written; a draft with no transfer after an hour is marked as not gone through. A pending send reads "Confirming", not "Waiting for X to join". |
| Receipt sender | The inbound scan stored the payer's raw wallet address as the receipt's Sender. | Evabob payers are named by @handle, and rows already saved are shown with the handle. |
| "Has not finished signing up" on an invoice | @ekuma's handle resolves on chain. The hold (#8) had already been paid to @ekuma on 24 Sep 10:05 UTC, but the server's record still said pending; the contract answers "not claimable" for a paid hold, and the server read that as "no wallet". | Before a release, and when a hold is opened, the chain decides: a hold already paid out is marked paid, not paid again. A registered recipient whose identity link is missing is relinked, and the message no longer says they have not signed up. |
| Money locked twice | Every hold was created twice on chain (#7/#8, #9/#10, #11/#12). After the PIN, a lock whose hash was slow was reported as "Didn't land. Nothing left your wallet", with Try again. | The app waits longer for the hash, then says "Still confirming — check Activity before trying again". The server records each on-chain hold once. |
| "The network is busy right now" | Every chain call went through one rate-limited public Arc RPC, with nothing behind it. | Calls retry and fail over to QuickNode, Blockdaemon and dRPC (`ARC_RPC_FALLBACK_URLS`). |

The duplicate holds are not lost. #7 (12 USDC, from @maxxi), #9 and #10
(2 USDC each) and #11 and #12 (3.597 USDC each) are untracked, so nobody can
release them, and the refund sweep returns each to its payer when it expires
(30 Sep – 1 Oct).

### App

| Area | What changed |
|------|--------------|
| Home | Request on the left, Send on the right. |
| Send | Amounts are typed with the phone's number keyboard; the in-app keypad is gone. |

---

## Security updates — 2026-09-24

Follow-up to `PRODUCT_AUDIT.md`; full detail in `SECURITY_UPDATES.md`. Server
448 tests (446 pass; the 2 failures predate these changes, see F-05), Flutter
69 tests, typecheck, analyze and web build clean. Not yet run on a phone.

| Area | State |
|------|-------|
| Agent API (`/v1/agent-api/*` POSTs) | **Fixed** — were all refused with `verified_user_required` |
| @handles | **Permanent** after signup; a deleted account's handle stays reserved; new handles cannot contain "evabob" |
| GA payments | Alert on every send; per-user rate limit. PIN per payment built behind `GATEWAY_PAY_REQUIRE_PIN` (**off** until tested on a phone) |
| Held payments | Receipt goes to the owner of the wallet actually paid; deletion retires on-chain identities |
| Bridges | `/cctp/finish` only relays burns from the caller's own wallet; per-user rate limit |
| Rate limits | `CLIENT_IP_HEADER` read ahead of a forgeable `X-Forwarded-For` |
| Lookups / claims | Per-person lookup allowance; public claims name the sender only for claim links |
| Account recovery | "Was this you? Stop it" from the alert |
| Circles | Joining adds to the existing approval instead of replacing it |
| Privacy | Notice corrected; memo field warns when notes go on-chain |
| Web | Landing page at `/`; mock-up is 404 in production |

---

## Testing version stable 1 — 2026-09-24

Fixes from the second round of hands-on testing, then the 14 screens of the
Figma redesign. Server 424 tests, Flutter 66 tests, typecheck, web build and
Flutter analyze clean; the whole suite also passes on a fresh clone with no
`.env` (CI). Commits `15f8efd` and `1bc59fe`. Not yet run end to end on a
phone — the APK `evabob-testing-stable-1.apk` at the repo root is for that.

### Fixes

| Area | What changed |
|------|--------------|
| Balances | Arc and Gateway balances are read in parallel; Gateway gets a 1.5 s grace and its last reading is cached, so a slow Gateway no longer holds up Home. The last balances are kept on the phone and shown at once on launch. |
| Evabob Agent | Balance answers give two figures: spendable (Arc) and the Gateway unified balance. |
| Main currency | Naira or dollar, chosen in Profile (saved on the server too). Amounts are typed and shown in it everywhere, with the other currency underneath; token screens (bridge, Gateway, convert, assets, agent wallets) still show the token itself. A request carries the currency it was asked in and is converted for the person paying. |
| Holds | Swaps are never held. A bridge is held only once its first PIN is entered (`firstPinAt`, `POST /v1/app-kit/jobs/:id/pin`); the 40-minute server completion counts from that PIN. Leaving before any PIN forgets the job: "No PIN was entered, so nothing moved." |
| Home | "View all" opens the full list in place (and "Show less"). Amounts are rounded to 2 decimals. |
| Addresses | Wallet-address fields (Move money, Gateway, every form except Send) sit behind "Change address". |
| Chat | Pusher reconnects and resubscribes on resume and on a new session token, so threads update live. Paying or declining a request updates the card for both people. |
| Scan to pay | Scanning an Evabob QR opens Send with the @handle filled in and no network choice; a request QR opens that request. |
| Handles | Case-insensitive, `@` optional everywhere (`core/utils/handles.dart`). |
| Profile pictures | Shown everywhere (default picture chosen from the user id when none is set); a change reaches everyone who has a chat or activity with that person. |
| Invoices | Show the @handle of the other person. |
| Android back | Steps back through screens; on Home a second back within two seconds exits. |
| Money from outside | Recorded with the sender's @handle when the address is an Evabob user, otherwise "Unknown". |
| "Something went wrong" | Uncaught errors are now classified: an expired Circle session asks to sign in again, a Circle funds error says so, other Circle refusals and network trouble get plain messages, and anything else returns a short reference code that matches the Render log line. Amounts in stored messages read "$1.44", not "1.438849 USDC". |
| App lock | Locks after 10 s in the background; the PIN checks itself when the last digit is typed; too many wrong PINs shows "Locked for now" with a countdown and a way back in by email. |
| Notifications | The "Allow notifications" card is shown only while the phone's permission is really off. |
| Chat images | Captions wrap properly beside the button. |

### Figma redesign — all 14 screens

Splash, Chat list, Activity (with the filter sheet), Notifications, Send ·
Sent and Send · On the way, Request history, Request · Detail (Pay, or
"Decline this request"), Request · Pay receipt, Convert · Done receipt,
Locked out, Claim held money (in the app) and the evabob.me claim page
(`src/app/claim/page.tsx`). The two receipts share
`core/widgets/done_receipt.dart`. `GET /v1/payment-requests/:id` now returns
the asker's name, handle and picture; `GET /v1/public/claims/:id` returns the
sender's name and picture (never their wallet) and when it was sent.

### Email (SMTP) — fixed 2026-09-24

Every email had been failing on Render: Brevo refused the login with
`525 5.7.1 Unauthorized IP address`, so claim-link emails, family-check codes
and recovery codes never went out (the payments themselves still went
through). Brevo's IP restriction was lifted; `/v1/health` now reports
`SMTP ready (smtp-relay.brevo.com)`. See `docs/ENV.md`.

### CI

Five `protectedEscrow` tests needed `PAYMENT_ESCROW`, which only existed in
the local `server/.env`, so the GitHub "Security release gate" failed. The
tests now use a stand-in address when none is configured.

## "For agents" batch — 2026-09-19 (research report §8.2)

Agent **wallets** (not the Evabob Agent assistant). Full guide, rules and the
agent API: `docs/AGENTS.md`. Server 378 tests (41 new), contracts 6 new,
typecheck and Flutter analyze clean.

| # | Feature | Status |
|---|---------|--------|
| 7 | **Allowance** — amount, window, categories; silent / push approval / refused; live meter; loop breaker (6th call to one endpoint in a minute pauses it); one-tap Freeze all | **Partial** — tested in code and wired end to end in the app; not yet exercised by a real agent |
| 8 | **Pay after proof** — Evabob paywalls are verified, delivered, checked, then settled; failures cost nothing; outside sellers that return nothing usable are marked disputed. Evidence bundle per payment, hash-chained, shared as JSON | **Works** for Evabob paywalls — a real agent paid a $0.01 paywall on testnet: verified, delivered, checked, settled by Circle, evidence recorded. Found and fixed two bugs in the existing payment path on the way: BigInt serialisation in the signer (every paid call failed) and the missing `resource` Circle requires. Outside sellers: none on Arc testnet to try |
| 9 | **Names and reputations** — agent handles share the people namespace; pay by handle ("Research agent · owned by @ada"); `Agent` identity type in IdentityRegistryV3; income swept into the agent's balance; record of hires and calls; seller list seeded from Evabob paywalls and Circle's catalog | **Partial** — registry deployed and migrated on testnet; naming, payee resolution and records tested; no agent named on chain yet |
| 10 | **Agent hires a person** — fee reserved on posting, locked on chain in a job hold before the person starts; delivery releases, nothing delivered returns it to the agent | **Works** (release path) — a real $0.05 hire: locked on chain for @nzubechi_ before starting, marked delivered, accepted, released to their wallet. The "nothing delivered" return path has not run with real money |
| 11 | **Get paid by agents** — paywalls for files, text, a person's API or time; one link for people and software; payouts in batches less 0.05% and $0.02 | **Works** (sale) — a real $0.01 sale settled on testnet. Payouts from the treasury and bookings of time not yet run with real money |

### IdentityRegistryV3 — deployed 2026-09-19

V2 plus one appended identity type, `Agent` (3). Existing ordinals and keys are
unchanged; V2 rejects ordinal 3, so a new registry was required. Admin: the
Safe; linker: the identity linker. The 8 identities V2 resolves were copied
(no conflicts). PaymentEscrowV3 still reads V2, so people are linked in both
(`ESCROW_IDENTITY_REGISTRY`), agents in V3 only. `/v1/health` role map OK.

## Testing feedback batch — 2026-09-19

Fixes from the first round of hands-on testing. Server 337 tests, Flutter 51
tests, typecheck and analyze clean. None run end to end with real wallets yet.

| Area | What was wrong | What changed |
|------|----------------|--------------|
| GA payments | Every GA payment to another network failed: "Signer is not authorized to spend funds from sourceDepositor". The person's approval of Evabob (the delegate) was read from the latest block and the payment sent seconds later, but Circle only honours it once it is *final* — about 15 minutes on Ethereum and Base Sepolia. Checked on chain: the approvals were fine, just not final yet. | The server reads approvals at the finalized block, prefers networks that are ready, and when one is still confirming it **schedules** the payment: the tracker sends it by itself once the approval is final (up to 3 hours), and the person is told. The app no longer asks for the same approval twice, and Circle's raw error never reaches the screen. Euros removed from the GA card; the per-network amounts are readable. |
| Money from outside | A MetaMask send was not recorded. Arc reports a plain native USDC send only as a Transfer event from the system address `0xfff…fffe` (18 decimals), which was never watched; a token transfer emits both. Base and Ethereum Sepolia were never watched at all. | Arc: both are read and paired so each movement counts once, and cirBTC is watched. Base and Ethereum Sepolia are scanned too, with their own progress marks. A sweep on the tick scans wallets even while the app is closed, and a one-time look-back over the last four days recovers missed native sends (it found and recorded the 20 USDC MetaMask send to @nzubechi_). Also found: the public Arc RPC answers "Request exceeds defined limit" once its request quota is used — the scanner's 9,000-block queries were being refused outright, so Arc scanning had been failing too. Queries are now 1,000 blocks, two wallets per pass, backing off when the RPC pushes back; anything the scan finds that is already one of the person's own records (their bridge landing, a GA payment, a released hold) is skipped. |
| Chat requests | The receiver never saw a request card: the app posted it as a "receipt", the server refuses those from clients, and the sender saw only a local copy. | The server posts the card, built from the request itself: every line, total, due date and live status. A pasted pay link becomes the same card. The receiver has **Pay** and **Cancel** (decline: the card closes for both and the sender is told); the sender can cancel their own. The Agent opens pasted pay links. The raw timestamp and the request id mislabelled "Hash" are gone. |
| Chat | No badge on the Chat tab; stale names; no pictures; text not copyable. | The server tells the other person about each message (live, and by push); the tab badges, the open conversation stays quiet. Name, handle and picture changes reach everyone the person chats with at once. The picture chosen on Home is saved on the server and shown in chat. Messages are selectable. |
| Sounds | `money_in.mp3` was silent with the app in the background. | A "Money received" Android channel plays it for pushes; money-arrived alerts are flagged `moneyIn` by the server; in the foreground the app plays it and the notification is silent. A payment spotted in Activity without its alert still chimes once. |
| Home | "All clear" ignored held and 10-minute payments. | "Your money" lists bridges, swaps, top-ups, the 10-minute wait, money set aside, claim links and GA payments in flight; "All clear" only when none. "Messages" removed; "Money in" moved below "Recent activity". Menu: "Money in" and "Profile" removed (the picture opens Profile). |
| Keyboard | The keyboard covered the amount keypad and the PIN. | Tapping outside a text field on Send (the amount included) closes the keyboard; every PIN screen opens with it closed. |
| Fingerprint / Face ID | Not possible with the web PIN screen. | Circle's native SDK, with a Profile switch. Needs a GitHub token to build on Android and a Mac for iOS — see `docs/BIOMETRICS.md`. |

## "For people" batch — 2026-09-18 (research report §8.1)

All six built, typechecked and unit-tested. **None has run end to end on
testnet with real wallets yet.** The public links (`/r`, `/h`, `/g`) only open
on the development PC until the web app is hosted.

| # | Item | State | What was done / what remains |
|---|------|-------|------------------------------|
| 1 | "Paid ✓" receipts | **Built** | Any payment you made can be shared as a link and a QR code (`POST /v1/activity/:id/share` → `/r/{publicId}`). The page shows who paid, how much and when, and re-checks the payment on the Arc network each time it is opened (same-network sends: payer, recipient, token and exact amount in one Transfer event; cached 60 s), with a "check it yourself on Arcscan" link. Nothing is public until the payer shares it; the memo is never shown. Receipt sheet copy: "Show this to the seller — they can check it themselves." Sellers get **Money in** (Home ⋯ menu): payments as they land, with a chime (`assets/sounds/money_in.wav`), today's dollar total (euros shown apart), live from alerts with a 6-second poll behind it. Payments between two Evabob users now alert the payee — they previously never did, because the inbound scan skipped transfers the sender's receipt already covered. |
| 2 | Hold-until-delivered links | **Built** | Home ⋯ → Sell with a link. A link per item (title, price, delivery window, 14 days by default); public page `/h/{id}` with the seller's track record; `evabob://hold/{id}` opens the pay screen. Orders are job holds tied to the link (`holdLinkId`) and follow the job rules exactly (docs/HELD_PAYMENTS.md). "Escrow" appears nowhere. |
| 3 | Safe send additions | **Built** | The review sheet shows the payee's photo. **Family check**: mark contacts as family (Profile → Family check) and choose an amount (default $100); a payment to them above it needs a 6-digit code emailed to the sender's own address, entered before the PIN. Enforced by the server on sends, holds and milestone payments, not only in the app; 5 wrong tries lock a code, codes last 10 minutes, one code covers a payment made in parts. The 10-minute cooling-off hold and raw-address warnings were already built. |
| 4 | Work that pays itself out | **Built** | Invoices can be **paid by milestone** (one hold per line, one PIN, each released as it is delivered), carry a **due date** and a named payer with **automatic reminders** (day before, on the day, 3 days late; the sender told when overdue). Reviews now have a **conversation with evidence** (links and photos) between both people and the reviewer, on both held-payment screens. Delivered → release in 7 days was already built. |
| 5 | Money circles and group pots | **Built; contracts deployed** | `MoneyCircles` `0x482497289a4F5197f67f98B2535cd23D6238d256` and `GroupPots` `0x3CBDdab2398e06d5FB496a9DbF9424abD449D795` (deploy txs `0x19584dd3…`, `0x0214e964…`), 13 Foundry tests. Neither has an admin; the 0.05% fee goes to the platform fee wallet, taken from payouts and releases. **Circles**: members approve their whole commitment and join (one PIN); each round the server (or anyone) collects and pays the next person in the same transaction. Missed contributions follow the product owner's rules: the round pays out what came in, the member is behind and owes whoever they shorted, their turn moves to the end, and the keeper catches them up as soon as their balance can cover it. **Collections**: a target and a deadline; released the moment the target is reached; if the deadline passes short, the keeper refunds everyone automatically. Public progress page `/g/{id}` (collections only; circles are private). Home ⋯ → Circles and collections. The keeper's transactions are paid by the ops wallet. |
| 6 | Where the money is | **Built** | The same `/r/{publicId}` link shows Sending → On the way → Done while a payment moves (App Kit job stage for bridges; hold state for holds) and refreshes itself. The review sheet now says what arrives before the PIN: "They receive" for sends, and for bridges the amount after Circle's Fast Transfer fee, read live from Circle's fee table (`/v1/app-kit/bridge/quote` — it used to subtract the Evabob fee, which is charged on top, and ignore Circle's fee, which is not). |

**Money sounds** (product owner's choice, 2026-09-18): `assets/sounds/money_in.mp3`
plays whenever money reaches the person while the app is open (received,
released or returned to them, a circle payout, a refund — the server marks
those alerts `moneyIn`); `assets/sounds/money_out.wav` plays when a payment
they make goes through (send, hold, milestones, collection, GA payment). One
payment reported twice chimes once; the switch on Money in turns both off.

The scheduled work now runs from one place, `services/tick.ts`, for both the
local minute timer and `/internal/cron/tick`: held payments, abandoned
bridges, Gateway tracking, invoice reminders and the circles/collections
keeper. Checked 2026-09-18 by booting against the real Atlas snapshot: public
routes answer without sign-in, `/v1/groups` requires it, and a tick runs all
five steps without errors.

## Fix-first batch — 2026-09-18

The eight "fix before anything new" items from the September 2026 payments
research report (`evabob-payments-research-2026-09.pdf`, §7.2).

| # | Item | State | What was done / what remains |
|---|------|-------|------------------------------|
| 1 | Notifications that reach a closed app | **Built; needs a Firebase project** | Every alert now goes out through FCM as well as Pusher, with a shared tag so a phone shows one notification (`services/push.ts`, `core/notifications/push_registration.dart`). Devices register on sign-in and unregister on sign-out; a token moves when someone else signs in on that phone. Off until `FIREBASE_SERVICE_ACCOUNT_JSON` (server) and the `FIREBASE_*` dart-defines (app) are set; iPhones also need an APNs key in Firebase and the Push Notifications capability in Xcode. New alerts: work delivered, releases tomorrow, hold expiring, cancelled after delivery, money returned, bridge finished for you, review needed (operators). |
| 2 | Two-sided job escrow | **Built; contract deployed; operator screen built** | Worker marks delivered → payer has 7 days → silence releases to the worker. Cancel before delivery refunds at once; cancel after delivery requires a reconciliation form and goes to manual review by an operator. Rules, including the reviewer criteria, in `docs/HELD_PAYMENTS.md` — confirmed 2026-09-18. Operators (`OPERATOR_USER_IDS`) decide reviews in the app: Profile → Held-payment reviews, or by tapping a "review needed" notification; the screen shows both sides, the delivered work, and the written criteria, and requires a note both people see. Needs **PaymentEscrowV3** (below). |
| 3 | No stranded money | **Built** | Bridges left for 40 minutes after their first PIN are finished by the server from the ops wallet, one attempt per pass (timed from the burn's block time until 2026-09-24; now from the first PIN, and a bridge with no PIN is never held). The 2× gas charge is recorded on the job and **not collected** (waived on testnet; collection method undecided). Bridge jobs are now in the Mongo snapshot — on Vercel they previously lived on one instance's temp disk. Gateway (the GA) is finished rather than hidden — see the money-movement table. Every configured bridge route stays offered — routes are never hidden over ops-wallet gas (product owner's decision). If the ops wallet cannot pay a destination mint, bridges still start, operators get an alert, and `/v1/health` shows it under `bridgeRelay`. The ops wallet (`0x164d01fD…A971`) was funded with 0.1 ETH on Base Sepolia and on Ethereum Sepolia on 2026-09-18. Gateway stays behind `FEATURE_GATEWAY`. |
| 4 | Safe-send guardrails | **Built** | `GET /v1/payees/check` resolves who a payee really is, whether this sender has paid them, and flags raw addresses that are not Evabob accounts and addresses that only resemble one already paid (address poisoning). The review sheet shows those cautions and, for USDC to an Evabob user, a "wait 10 minutes before it goes" switch, on by default for a first payment. That sends through a cooling-off hold the sender can cancel from a countdown screen; it releases after 10 minutes, or refunds after 24 hours if the server never acts. |
| 5 | Agent path | **Wired; honestly off on testnet** | `GET /v1/agents/services` lists what an agent wallet can pay: Circle catalog sellers that are GET, Gateway-batched and on this network. `AGENT_RESOURCE_ORIGINS` accepts `circle-marketplace` to allow them. The catalog (1,143 endpoints on 2026-09-18) has 323 payable endpoints, all on Arc mainnet, none on Arc Testnet, so the app now says nothing is payable here yet. `runParallelSources()` and the curated Polymarket/Reddit/X/YouTube list were deleted — unwired, and they invented costs. |
| 6 | Assistant capacity | **Done** | The Evabob Agent now uses DeepSeek (`DEEPSEEK_API_KEY`, default model `deepseek-flash`, thinking off) through one client, `services/llm.ts`. Groq and `GROQ_*` are removed. DeepSeek caches the repeated system prompts automatically. |
| 7 | Production hygiene | **Partly done** | Mongo snapshot split into chunks under an atomically switched head (no 16 MB ceiling), with generation-checked saves and per-request refresh so several instances cannot overwrite each other. Profile photos stored in Mongo. The refund sweep no longer marks a hold refunded when the refund failed. Flutter tests were not blocked (the `Inter.ttf` note below was stale): 36 pass. **Remaining:** per-record Mongo documents before real traffic, and an external contract audit. |
| 8 | The ramp decision | **Deferred (2026-09-18)** | Parked by the product owner for now. When it is taken up, the choice is: wallet-to-wallet only, or cash-in/out through a licensed partner under Nigeria's August 2026 framework (₦2bn / ₦300m capital tiers, 1.5% stamp duty on crypto-to-fiat). Record the choice and its dates here. |

### PaymentEscrowV3 — deployed 2026-09-18

`0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39` · deploy tx `0xb45652f0…` ·
admin is the 2-of-3 Safe from the first block, attestor is the existing
escrow attestor, recipients resolve through IdentityRegistryV2.

V2 plus two attestor-only functions: `refundWithAttestation` returns a
pending hold to its **original sender only**, before expiry; `extendExpiry`
moves expiry later, never past a year after creation. Neither can pay anyone
new. 17 new Foundry tests including a 256-run fuzz that money only ever
reaches the worker or the payer. V2 (`0xd6b5cbCD…`) had created no transfers
(`nextTransferId` was 1), so it was retired with nothing to migrate. Records
now store their contract address and are never acted on against a different
one, because transfer ids restart at 1 on every deployment.

**Running this batch:** the API is not hosted anywhere yet; it runs locally on
the development PC. `server/.env` already has `PAYMENT_ESCROW` (V3),
`CRON_SECRET` and `OPERATOR_USER_IDS`; restart the server to pick them up.
The in-process timer runs held-payment releases, abandoned-bridge completion
and reminders every minute, so no external cron is needed locally. The first
save converts the Mongo snapshot to the chunked format; it keeps an inline
copy for older builds, so an older checkout still reads it. Verified
2026-09-18: the server boots against the real Atlas snapshot, reports ready,
and offers all four bridge routes.

## Testnet foundation batch — 2026-09-13

| Item | State | Evidence / remaining work |
|------|-------|---------------------------|
| Flutter build recovery | **Built** | Bundled Numans/assets are registered, the application graph is injectable, `flutter analyze` reports no issues, and all 23 Flutter tests pass. iOS source is maintained but an iOS archive still requires Xcode/macOS. |
| Hosted testnet | **Prepared for Render, not deployed** | `render.yaml` defines a one-instance Hono API with persistent uploads, the Next.js public app and an hourly authenticated refund cron. Atlas, exact CORS, health checks and environment separation are documented in `docs/HOSTED_ENVIRONMENTS.md`. The Blueprint still has to be synced and verified in the Render Dashboard. |
| Authentication hardening | **Built; live validation remains** | Header impersonation defaults off, demo auth is compiled out of release builds, and public routes are narrowly limited. Dynamic origin/session renewal, logout, account switching and expiry still need the hosted acceptance run. |
| Public payment pages | **Built; live validation remains** | `/pay/{requestId}` and `/claim` render sanitized server state and hand off with `evabob://` deep links. The mobile invoice handoff verifies an on-chain receipt before settlement. App-store URLs and hosted-device testing remain. |
| Server feature flags | **Built** | `/v1/config/public` advertises capabilities and intersects money flags with provider prerequisites. Flutter fails closed and hides unavailable entry points. Every hosted testnet flag starts off and is enabled only after its acceptance run passes. |
| Optional send memo | **Partial** | The field is directly below the quick amount selectors and is carried into review/activity; protected sends store it in `PaymentEscrowV2`. Direct human sends do **not** emit Arc's standard `Memo` event because Evabob UCWs are SCAs and Arc's documented wrapper is EOA-only. |
| Evabob agent PFP + send | **Built** | Chat uses the application logo. A single-recipient send produces an exact confirmation card and moves money only after the existing PIN flow. |
| Arc atomic batch send | **Not enabled** | The documented `Multicall3From.aggregate3` route needs direct USDC in the Circle-controlled agent EOA, preflight simulation, bytecode validation, a successful receipt and one matching Transfer log per recipient. Agent funding currently deposits the credited amount into Gateway, leaving no direct balance for this contract call. The old non-atomic loop is blocked to prevent partial success. |

### Hosted testnet risks still open

- The API snapshot writer and financial-writer lease are process-global. Render is pinned to one instance with a persistent disk, so low-traffic testing is acceptable only while Mongo remains authoritative and finance writes are migrated to normalized, atomic Mongo operations.
- Profile photos use the API's Render persistent disk for testnet. Moving them to object storage is still required before horizontal scaling.
- Scheduled refund sweeping is wired to a Render hourly cron, but it is not proven until the deployed cron has run against a real expired hold.
- Gateway, conversion, bridge, agent-wallet, x402 and atomic-batch flags stay off until their respective acceptance runs pass.

---

## Money movement

| Flow | State | Detail |
|------|-------|--------|
| Circle UCW onboarding + PIN challenges | **Works** | SCA wallets on `ARC-TESTNET`, `ETH-SEPOLIA`, `BASE-SEPOLIA` — three chains, not six. Multi-challenge runner verifies COMPLETE and retries only still-PENDING ids. |
| App Kit send / swap / deposit / spend / compose | **Works** | Ops (server-signed) and UCW (PIN relay) paths, jobs persisted with expiry/recover. App Kit is the first swap rail (Synthra only before any PIN) and the only bridge rail; quotes come from App Kit `estimateSwap`, then Synthra. |
| Bridge (App Kit → CCTP) | **Partial** | Burn + attestation work. **Mint on Base Sepolia is blocked on ops-wallet ETH for gas.** This flow was re-declared "working" four times during August; treat any single success as anecdotal until it runs repeatedly. |
| Gateway unified balance (GA) | **Built — 2026-09-18; live run remains** | Top-up and Pay work from the GA screen (Home ⋯ menu, behind `FEATURE_GATEWAY`). Money in flight is now tracked (`services/gatewayTracker.ts`): a payment whose destination mint did not land in the request is recorded with its attestation and minted by the ops wallet while the attestation is valid (~10 min), otherwise its status is read from Circle; the person is told when it arrives or that it did not go through. A top-up's activity row is written only once it is signed and flips to "arrived" when Gateway credits it (seconds on Arc, ~40 min Base Sepolia, hours Ethereum Sepolia), with an alert. Fixed on the way: every successful GA payment used to overwrite the payer's email with `<id>@evabob.app` and their name with their id; and a cancelled top-up used to leave a "Gateway deposit" row. Not yet exercised end to end on testnet. The GA delegate that signs burn intents is the ops key — a separate delegate key would narrow what a leaked ops key could reach. |
| Swap via Synthra | **Fallback** | Used when App Kit's swap ends before any PIN, and for quotes App Kit cannot price. Needs `SYNTHRA_API_KEY`. |
| `POST /v1/transfers/send` and `/v1/exchange` | **Retired** | Return 410 so an old client cannot fabricate completed payment or swap history. |
| Chat invoice pay (100% / 50+50 / 100% escrow) | **Works** | Direct portions require verified ERC-20 receipts; held portions require a `TransferCreated` event from the deployed escrow contract. |

### Protected transfers — money recovered 2026-09-05

`PaymentEscrow` was described here as deployed dead code. That was wrong:
`nextTransferId` was 4, so three transfers had been created by the "send to
someone not on Evabob yet" claim-link path. All three were still `Pending`,
all had expired months earlier, and together they held 5.465986 USDC — exactly
the contract's whole balance.

| # | Sender | Amount | Expired | Recipient key |
|---|--------|--------|---------|---------------|
| 1 | `0x16c5B47B…` | 1.449301 | 2026-07-23 | `Handle` type holding an *email* — a type mismatch that could never resolve |
| 2 | `0x16c5B47B…` | 1.449301 | 2026-07-23 | unidentified |
| 3 | `0x743b34FF…` | 2.567384 | 2026-08-08 | `Email` `tigageorge1@gmail.com` |

Refunded on 2026-09-05 — `0xccdec56c…`, `0x99758e1f…`, `0xe0080c75…`. The
contract now holds 0 USDC and all three read `Refunded`.

**Why they were stranded.** `startEscrowRefundJob()` runs hourly from boot, but
it only refunded holds it remembered, and `localEscrows` was an in-memory `Map`
despite a comment promising a JSON fallback. Every restart forgot every pending
hold; with Mongo unavailable at creation time the record was gone for good
while the contract kept the money.

Both halves are fixed. Holds now persist to `data/protected-escrows.json`, and
the sweep no longer trusts local bookkeeping at all — it walks the contract's
own transfers and refunds anything expired and still pending. `refund` is
permissionless and always pays the original sender, so sweeping an untracked
transfer cannot misdirect funds. `escrow-jobs.test.ts` pins the restart case.

### Held payments on chain — one contract, two features

`PaymentEscrow.claimWithAttestation` is a generic "the server says pay this
address now" hook; the contract never asks why. So one contract backs both
held-money flows, differing only in what makes the server attest.

| Flow | Held when | Released when | Expiry |
|------|-----------|---------------|--------|
| Claim link | Paying an email with no account yet | They sign up, prove that email, and have a wallet | 7 days |
| Job | An invoice is settled into a hold | The payer says the work arrived | 90 days (ceiling 365) |

`services/protectedEscrow.ts` holds the shared logic; routes are
`GET /v1/escrow/recipient-status`, `POST /v1/escrow/protected/plan`, `/record`
and `/:transferId/release`. Claim links also release automatically on sign-in,
from the JWT-verified email — never the request body, since a caller who could
name their own email could claim anyone else's held money just by asking.

**The payer is the on-chain sender.** `refund` returns money to whoever funded
the transfer, so routing it through a platform wallet would mean every refund
depended on the server forwarding it. The cost is a second PIN, because the
contract pulls funds with `transferFrom`; the multi-step challenge runner
already handles that shape for Synthra swaps.

**Verified end to end on Arc, 2026-09-05.** Created a 0.10 USDC hold
(`0x1b1f7771…`, transfer id 4), read the id back out of the `TransferCreated`
event, confirmed the derived recipient key matched the stored one, saw a
release to the wrong identity refused, released to the right one
(`0xc2450a8b…`), and read the transfer back as `Claimed`.

#### PaymentEscrowV2 + IdentityRegistryV2 — role-separated 2026-09-12

`0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805` · deploy tx `0x34d0a91c…` ·
resolves recipients through `IdentityRegistryV2` at `0xb1435528…`.
Both admin roles belong to the 2-of-3 Safe at `0xe2Ef4603…`. The previous V2
held 0 USDC at migration. Six stored email/handle identities migrated with no
conflicts; future authenticated Circle UCW sessions retry missing links.

V1 (`0xFB89b95e…`) is retired and holds nothing. Three things were wrong with
it, each found by running it rather than reading it:

| V1 | V2 |
|----|----|
| `claimWithAttestation` paid whatever address the attestor passed and never looked at `recipientKey` | The claimer must be the address the registry resolves that key to. The attestor decides *when*; it can no longer decide *who*. |
| Claim reverted the instant a hold expired, while refund opened at the same moment — work delivered on the last day but released a day late became refundable | A claim is valid for as long as the hold is pending. Refund still opens at expiry, and since it only ever pays the sender, the worst case of the two racing is the payer getting their own money back. |
| `MAX_EXPIRY` 14 days, a `constant` | 365 days. `DEFAULT_EXPIRY` raised 3 → 7 days. |

`claimWithPassword` is gone rather than merely unused: it took the password as
plaintext calldata and paid `msg.sender`, so anyone watching the mempool could
read it and front-run the claim.

**The contracts now have tests** — `contracts/test/PaymentEscrowV2.t.sol`, 22
of them including a 256-run fuzz, the first this repository has ever had.
Weighted towards the three failures above, since those are the ones that cost
real money.

Because V2 will not release to an identity it cannot resolve, and the
registry link is written in the background at sign-in, the claim-on-sign-in
path now waits for the chain to catch up instead of racing it. If the link
never lands the money stays held and the next sign-in retries, which is the
safe direction to fail in.

#### What is still trusted, after V2

The contract now resolves recipients itself, so the attestor cannot choose who
is paid. IdentityRegistryV2 separates automatic linking from administration.
The hot linker cannot rotate itself and cannot recycle a previously owned
identity to a different account. Emergency corrections and role rotation need
two of the three Safe owners.

`refund` still becomes callable by anyone once a hold expires. That is
deliberate, so a keeper can sweep, and safe because the money can only return
to whoever funded it. A claim stays valid while the hold is pending, so expiry
now only decides when a refund becomes possible rather than cutting off
payment — which is why job holds run 90 days rather than being pinned to the
ceiling.

### Job escrow moved onto the contract — 2026-09-05

Chat invoice holds no longer touch the JSON ledger or the platform hold
wallet. Settling an invoice as "hold" or "half now, half held" runs the same
two-PIN contract lock the claim link uses, with `purpose: "job"`.

| | Before | Now |
|---|--------|-----|
| Where the money sits | Platform hold wallet, with a JSON row asserting it | The escrow contract, funded by the payer |
| Releasing | Ops wallet paid the recipient | Contract pays the identity it was locked for |
| Nobody releases | Nothing happens; the row sits "funded" forever | Refunds to the payer automatically at expiry — **superseded 2026-09-18:** once the worker marks delivered, silence releases to the worker after 7 days (see `docs/HELD_PAYMENTS.md`) |
| Hold length | 3 days | 90 days, ceiling 365 |

`POST /v1/escrow/job`, `/:id/complete` and `/:id/reject` are **410
tombstones**. They are the routes that recorded a hold in a file and then
released it with an ops-wallet transfer, so the platform paid out money it had
never received. `/submit` and the read route still work — marking a
deliverable is a note, not a payment.

One deliberate restriction: a job hold needs an `@handle` or an email, not a
raw `0x` address. The contract releases to whoever the registry resolves, and
a bare address has no identity key, so such a hold could never be claimed.

Ledger rows: **0**. The 252 that existed were fixtures from a test with no
working-directory isolation, none backed by anything on chain, and they were
purged after checking every one.

**Verified on Arc.** A 90-day hold created for a real identity
(transfer 4, expiring 2026-12-04), resolved by the contract to the right
wallet, released (`0x772228e8…`), and read back as `Claimed`.

---

## Agents / x402

**Target model.** A user funds an agent wallet, copies its API key, and hands that
key to an external agent. The agent calls `POST /v1/x402/pay` with
`Authorization: Bearer sk_evabob_…` and spends **only that wallet's balance** —
never the user's main wallet — bounded by a per-call and a daily cap. The owner
can withdraw the remainder, revoke the key, or rotate it.

| Item | State |
|------|-------|
| Agent wallet CRUD + ledger | **Implemented** — every new agent provisions a dedicated Circle-held Arc EOA; production credentials and testnet lifecycle validation remain |
| Deposit | **Implemented** — verifies the owner's UCW transfer, then performs Circle Wallets `approve` + Gateway `deposit`; credits only after Gateway finality; live end-to-end validation remains |
| Withdraw | **Implemented** — same-chain Gateway burn/mint pays only the owner's stored UCW address, reconciles saved transfer ids and corrects the ledger downward from Gateway; live end-to-end validation remains |
| Revoke / rotate key | **Works** (`POST /:id/revoke`, `/:id/rotate-key`) |
| `POST /v1/x402/pay` | **Built, opt-in** — exact HTTPS allowlist, GET only, dedicated funded EOA, per-call/agent/user caps, required idempotency key and pre-sign durable reservation |
| ~~`/:id/reveal-key`~~ | **Removed** — it returned a stored plaintext key gated on a client-supplied `pinVerified` boolean the server never checked. Keys are now shown once at issue time and rotated if lost. |

Agent API keys authenticate **only** on `/v1/x402/pay`. Every other `/v1` route
requires a user session, so a key that has been handed out cannot read activity,
withdraw, revoke, or reach anything else.

| `GET /v1/agents/services` | **Not built** |
| `POST /v1/agents/:id/run` (parallel research) | **Not built** |
| `PATCH /v1/agents/:id/services` | **Not built** |

`runParallelSources()` and `getMarketplaceServices()` exist in
`services/circle-x402.ts` but **no route calls them** — verified by grep.

**Funding is chain-verified.** `POST /v1/agents/:id/deposit` credits the ledger
only when the referenced transaction succeeded on Arc, moved USDC from the
depositing user's own wallet to that agent's custody address, covered the
claimed amount, and has not already been credited. It credits what arrived, not
what the request asked for. The former `allowLedgerOnly` and `fundActivityId`
shortcuts are gone. `dailyLimitUsdc` is clamped to `AGENT_MAX_DAILY_LIMIT_USDC`,
and `AGENT_MAX_USER_DAILY_SPEND_USDC` caps spend across all of one user's agents.

The former paid path sent a plain USDC transfer and invented proof headers. It
has been replaced with Circle Gateway batching. New agents use a dedicated
Circle MPC-held EOA; deposits are finalized in Gateway before the ledger is
credited. A debit is durably reserved before a signature is created. Once a
signature reaches a seller, an uncertain response is retained as `ambiguous`
and visible at `GET /v1/agents/:id/payments`; it is never refunded or retried
automatically. `AGENT_RESOURCE_ORIGINS` remains empty by default, so paid calls
stay disabled until exact seller origins are chosen. Existing shared-custody
agents are rejected with `AGENT_WALLET_MIGRATION_REQUIRED`.

`runParallelSources()` and `getMarketplaceServices()` were deleted on 2026-09-18; `GET /v1/agents/services` replaces them with the list of sellers an agent can actually pay.

---

## Evabob Agent (the in-app assistant)

Not to be confused with **agent wallets** above. The Evabob Agent is the chat
thread a user talks to in plain English; agent wallets are custody for external
software. The routes differ by one letter: `/v1/agent/*` versus `/v1/agents/*`.

| Item | State |
|------|-------|
| Tool-calling loop (`services/agentChat.ts`) | **Works** — the model (DeepSeek since 2026-09-18) decides which read tools to call, then answers from the results |
| Read tools (`services/agentTools.ts`) | **Works** — 10 tools: help search, balance, activity, one transaction, pending operations, invoices, receiving details, contacts, agent wallets, profile |
| Knowledge base (`knowledge/evabob-kb.ts`) | **Works** — 18 topics, keyword retrieval, exposed as the `search_help` tool |
| Propose tools | **Works** — `propose_send`, `propose_swap`, `propose_bridge`, `propose_topup`, `propose_request` |
| Confirm-card path for money | **Works** — a proposal builds the same card the deterministic parser always built |
| Escrow by conversation | **Degraded** — no `propose_escrow`, so while Groq is up the agent answers in text instead of raising an escrow card. The deterministic path still handles it when Groq is down. Left out deliberately: the chat-escrow flow has 174 stored rows and every one is a test fixture, so there is no proven path to wire a tool onto. |

**The model had been dead.** `GROQ_MODEL` was `llama-3.3-70b-versatile`, which
Groq has decommissioned; every agent call returned 404 and silently fell back
to the regex parser. That is why the assistant felt canned regardless of what
the prompt said. Now `openai/gpt-oss-120b`, verified answering with live data.

**The model cannot move money.** No tool writes — the propose tools validate
and resolve an action and hand back a description of it, and the user's tap plus
a PIN challenge is what executes. `agentTools.test.ts` asserts this behaviourally
rather than trusting the prompt: `propose_send` is called and the store is
checked to be unchanged. No tool returns a credential, and tool arguments carry
no user field, so identity comes only from the verified session. The worst
outcome of a confused or prompt-injected model is a wrong sentence or an
unwanted card, never a payment.

Proposals refuse rather than guess: an unresolvable payee, a self-send, a
non-positive amount, a swap between one currency and itself, and a bridge that
does not cross networks are all rejected before a card exists. Verified against
the live model — "send 10 to my brother" asks which handle instead of picking
one, "bridge 5 usdc" asks for both networks, and "send everything I have" checks
the balance and asks for confirmation rather than proposing a number.

One tense rule earned its own instruction. Asked to request money, the model
replied "I've created a request for $25" when nothing had been created; a user
who believes that stops waiting for the card and later wonders why nobody paid.
The tool result now carries a worked example of the right and wrong phrasing.

**It now has documentation.** Asked "how do I top up?", the model originally
invented a card-and-bank flow with a button that does not exist, because it had
been told nothing about the app and answered from generic knowledge of payment
apps. `knowledge/evabob-kb.ts` holds 18 topics written from the shipped screens
and routes, retrieved by keyword and reachable through `search_help`. The same
question now gets the true answer: Evabob has no card or bank top-up.

Entries are honest about what is slow or flaky — bridging is described as the
least reliable flow, with the retry step named — because a user told "this can
take an hour" waits, and a user told "instant" thinks the app ate their money.
Retrieval is keyword scoring, not embeddings: eighteen entries do not need a
vector database, and a keyword match is inspectable when an answer looks wrong.
`knowledge/evabob-kb.test.ts` pins twenty real user phrasings to the entry each
must return, since an entry the search never returns is one the model never
sees.

~~Rate limit is 8,000 tokens/minute on every tool-capable Groq model~~ — the
Groq limit (about three questions a minute across all users) is gone: the
assistant moved to DeepSeek on 2026-09-18. Any error or rate limit still
degrades to the pre-tool canned reply rather than failing.

Turns are capped at three tool rounds and identical tool calls are answered from
a per-turn cache; one diagnosis question had asked for the same activity lookup
twice and taken 62 seconds, which is now 7.

---

## Money alerts — 2026-09-06

Receiving was the one moment the app had nothing to say. Money arrived, a row
appeared in Activity, and the person found out whenever they next opened the
app and pulled to refresh. Chat had been real-time since the beginning; money
never was.

The server now emits a Pusher event on a channel named after the user
(`services/notifyUser.ts`), and the app turns it into a system notification
(`core/notifications/money_alerts.dart`). Two events so far: an inbound
transfer detected on chain, and a held payment released to someone who has
just signed up.

**What it does not do.** Pusher reaches the user while the app is running or
backgrounded, not while it is force-quit. Since 2026-09-18 the same alerts
also go through FCM, which does reach a closed app — once a Firebase project
is configured (see the fix-first batch above).

**Channel authorisation.** The channel name is the user's id, and the server
signs it only for the session that owns it — an exact match, not a prefix, so
`private-user-<me>-extra` is refused. That is tested directly rather than by
inspection (`routes/pusher-auth.test.ts`), because the failure mode is silent:
a wrongly signed channel does not error, it quietly streams someone else's
alerts to a stranger.

Alerts are fire-and-forget on the server. Every caller is in the middle of
something that matters more — recording a transfer, releasing a hold — and a
missed alert costs a refresh, while a thrown error would cost the operation.

---

## Copy pass — 2026-09-06

The redesign brief bans crypto jargon in user-facing text, and the strings
added while fixing the money paths broke that rule repeatedly. Corrected on
the top-up screen, the agent screen, and the activity rows.

| Was | Now |
|-----|-----|
| Top-up unified balance | Top up your GA |
| Move USDC from a source chain wallet into Circle Gateway unified balance | Move money you hold on another network into the balance you spend from |
| Deposit confirmed on Base Sepolia · 1.00 settling | On its way · 1.00 arriving |
| Ethereum Sepolia is slow and can take many hours | This one can take several hours. Your money is safe and will appear on its own |
| Need 5.00 confirmed unified USDC | Your GA has 3.00 ready — you need 5.00 |
| Pay submitted — destination mint in transit. Do not retry. | Sent — it is on its way. No need to send it again. |
| POST /v1/x402/pay with Authorization: Bearer <api key> | It can spend from this wallet only — never your main balance |
| Max 2.00 USDC per call · 10.00 per day | Up to 2.00 per payment · 10.00 a day |
| Received EURC / 7.084785 EURC from 0xBBD70b01… | Money received / 7.08 from 0xBBD7…d40b |

The endpoint was not simply deleted from the agent screen — whoever wires up
an agent still needs it. It is kept as a quiet line below the explanation
rather than as the headline.

Inbound receipts now name a known sender by handle: one of the three existing
rows reads "5 from @nzubechi" rather than a hex string. The full address and
transaction hash stay on the record for the details view; they are only kept
out of the sentence a person reads.

The three rows already in the database were rewritten, since new wording does
nothing for receipts that were written before it.

---

### Section 6 copy pass — 2026-09-06

| Screen | Was | Now |
|--------|-----|-----|
| Nav | Assets | Balances |
| Nav | Buy | Convert |
| Bridge | Bridge | Move money |
| Bridge | Bridge complete · 5 USDC on Base Sepolia | Done · 5 is on Base Sepolia |
| Bridge | Burn complete · mint pending | On the way to Base Sepolia |
| Bridge | Burned on Arc · mint not finished yet. Retry when attestation is ready. | It left Arc but has not landed yet. You can try again in a moment. |
| Bridge | Retrying attestation & mint… | Trying again… |
| Chat | Lock 100% in Escrow | Hold it all until delivered |
| Chat | Pay 50% now + lock 50% | Pay half now, hold half |
| Chat | Paid 50% + locked 50% in escrow | Half paid, half held until the work arrives |
| Chat | Escrow released | Sent to them |
| Send | Held safely — claim email sent to recipient | Waiting for them to join — we sent them an email |

The assistant's own answer to "what can you do?" was the worst of it. It read
"I can send, bridge, swap, invoice, escrow, and check balances" — the app's
internal verbs, three of them meaningless to a non-crypto user, and the first
thing a new person saw in their chat list. It now offers things a person might
actually want, phrased as they would say them.

Its test had asserted the reply contained the tagline "bob me". That pinned a
phrase the brief wants used sparingly rather than as permanent chrome, and said
nothing about whether the answer was useful. It now asserts the reply offers a
copyable example and contains none of bridge, escrow, USDC, EURC or chain.

---

### One payment, three rows — fixed 2026-09-06

A single 5 USDC send produced three entries in the sender's feed and two in the
recipient's. Three writers each recorded the same payment without knowing about
the others:

| Time | Writer | What it wrote |
|------|--------|---------------|
| 22:16:07 | `POST /v1/circle/send` | a pending row, `mode=direct_user` |
| 22:16:08 | the App Kit job it then started | a second row, `mode=app_kit_ucw_send` |
| 22:16:26 | `POST /chat/threads/:id/send-command` | two more, `mode=chat_ledger` |

Only the App Kit row ever received a status and a real hash, so the other two
sat pending for good.

Two of the three are now gone at the source. The send route passes its pending
row's id into the job, which fills that row in rather than opening another —
the mechanism already existed, since jobs thread an `activityId` through their
meta to update on completion; the route simply was not using it. And
`send-command` no longer writes ledger activity for a payment that already
moved on chain: it still creates the transfer record the chat receipt refers
to, but stops mirroring a real payment into a ledger that moves no money.

25 rows already in the database were folded into their originals. Marked
`superseded` rather than deleted, so they drop out of the feed and stay on the
record, and the surviving row inherits the better title — "nzubechi" rather
than "Send 5 USDC" — and any real hash its duplicates carried.

Deliberately conservative: only send and receive rows, only non-zero amounts,
only the modes known to duplicate each other. Agent rows can share an amount of
zero while describing genuinely different events, and five 0.05 releases in the
same second are five payments rather than one recorded five times, so groups
holding more than one real transaction hash are left alone.

### Alerts no longer arrive in bursts

The inbound scanner records history as well as news, and every transfer it
found raised its own notification — so a first scan, or one after the app had
been closed a while, arrived as a burst of alerts about money that landed hours
ago. Anything more than about fifteen minutes behind the chain head is still
recorded, it just no longer interrupts anyone.

---

## Identity

**Funds are received by email, `@handle`, or a raw `0x` address. Nothing else.**
Phone was dropped; a 10-digit account-number identifier was considered and
rejected. Both would have needed a fourth `IdType`, and therefore a contract
change, for no gain over a handle.

| Item | State |
|------|-------|
| `IdentityRegistry` resolve | **Works** — on-chain |
| `POST /v1/identity/link` | **Works** — requires a verified session, links only the caller's own wallet, and accepts only `email` or `handle`, each proven against data the user cannot choose (the JWT claim; the store-assigned handle) |
| Phone as a payee / identity type | **Removed** — `/v1/users/me/phone/start` and `/confirm` are 410 tombstones |
| Registry data | **Corrected 2026-09-05** — the owner's email resolved on-chain to a stale wallet (`0x16c5B47B…`) from an earlier onboarding while the handle was correct. Fixed with `adminUnlink` then `adminLink`; email and handle now both resolve to `0x4A212FDB…`. |

A stale link is worth catching early for two reasons beyond the obvious: it
misdirects anyone resolving that identity through the registry, and it quietly
misleads debugging — a bridge investigation on 2026-09-05 first looked at the
wrong wallet because of it. Note also that the superseded wallet still holds
12.10 USDC and 20 EURC on Arc.

`IdType.Phone` **stays reserved at ordinal 0**. Identity keys are
`keccak256(uint8(idType), identifier)`, so removing it would renumber `Email`
to 0 and `Handle` to 1 and silently break every link already written on chain.
Add new types at the end only.

Identifiers are stored as `keccak256(idType, identifier)` with **no salt**.
Email is low-entropy enough to be reversible by brute force, so the hash is not
a privacy guarantee. Handles are public by design, so nothing is lost there.
Salting is possible without a redeploy — the contract hashes whatever
identifier bytes it is given, so a server-held pepper could be folded in — at
the cost of making the registry resolvable only by this server, and requiring
every existing link to be rewritten.

---

## Auth & security

Authentication was added on 2026-09-03. Before that, `services/dynamic-auth.ts`
implemented JWKS verification but **nothing imported it**, and every route
identified the caller from a spoofable `x-user-id` header.

| Item | State |
|------|-------|
| Dynamic JWT required on `/v1/*` | **Works** — public: `/v1/health`, `/v1/config/public`, `/v1/fx/rates` |
| `ALLOW_HEADER_AUTH` dev fallback | Defaults **off**; warns loudly at boot when on. Demo mode needs it. |
| Pusher channel authorization | **Works** — thread membership checked before signing |
| Rate limiting | **Works** — 300/min general (mounted before auth), 10/min on spend-bearing routes |
| Error messages | Generic in production, detailed in development |
| Atomic JSON store writes | **Works** — process and Mongo leases prevent concurrent writers |
| Agent funding verified on-chain | **Works** — see the Agents section |
| Circle UCW session binding | **Works** — only token fingerprints are persisted, with expiry and Mongo cross-host lookup |
| Invoice/chat settlement evidence | **Works** — exact sender, recipient, token and amount are checked on chain; transaction replay is rejected |
| Mobile session storage | **Works** — the JWT, wallet address and email live in `flutter_secure_storage` (Android Keystore / iOS Keychain), migrated off plaintext `SharedPreferences` on first launch |

### Current multisig and signer separation (2026-09-12)

The 2-of-3 Safe `0xe2Ef4603…` owns both contract admin roles. Its owners are the
primary `0xd72d85f…`, secondary `0xF4Aa77A3…`, and recovery `0xf7527C99…`
wallets. Routine work uses separate ops (`0x164d01fD…`), identity linker
(`0xDCE03B19…`), and escrow attestor (`0x90447ca0…`) wallets. Live health
confirmed both role matches, Safe threshold 2, all three owners, and
`sharedKey: false`. See `docs/KEY_ROTATION.md` for the approval workflow.

### Historical key-separation record (superseded 2026-09-12)

> The entries below describe older deployments and are retained only as an
> audit trail. They are not the current role map. Current addresses and
> procedures are in `docs/KEY_ROTATION.md`.

| Role | Key | State |
|------|-----|-------|
| Escrow attestor (releases held payments) | `0xBAC515Ba…` | **Split** — `ESCROW_ATTESTOR_PRIVATE_KEY`, rotated on chain (`0xb4aeeb5d…`), funded with 2 USDC for gas |
| Registry admin (`adminLink` / `adminUnlink`) | `0x24755738…` | **Split** — handed over 2026-09-06 |
| Escrow admin (`setClaimAttestor` / `setAdmin`) | `0x8036910a…` | **Split, cold** — 2026-09-06 |
| Deployer / ops signer | `0xa354e21b…` | Ops only now — no contract role |

Verified both directions against the deployed contract: the old shared key is
now rejected by `claimWithAttestation`, and the new attestor key releases
normally. Attestor was the right role to split first because it is the only
one that is reversible — the escrow admin can always point
`setClaimAttestor` somewhere else.

Note that the attestor needs USDC, since Arc charges gas in it. An attestor
that runs dry cannot release anything, and holds would sit until they expire
and refund.

#### Escrow admin split off — 2026-09-06

`0x8036910ae4AB910a456b70570233469908d5e066`, handed over in `0x79e67949…`
and funded with 1 USDC so it is usable the day it is needed — which will be a
bad day, and not the moment to find it empty.

This one is **cold on purpose**. Nothing in the server calls `setAdmin` or
`setClaimAttestor`; they are only ever run by hand. The key was written to
`.env` solely so it could be copied somewhere safe, and that line is meant to
be deleted. Losing it costs only the ability to rotate the attestor — holds,
claims and refunds all keep working without it.

Verified: the ops key is now rejected when it tries to rotate escrow roles.

| Role | Key | Notes |
|------|-----|-------|
| Ops signer | `0xa354e21b…` | Spends the platform wallet. Hot, signs constantly. |
| Escrow attestor | `0xBAC515Ba…` | Decides *when* a hold releases. Cannot choose the destination. Hot. |
| Registry admin | `0x24755738…` | Writes the phone book. Hot, because `adminLink` runs on every signup. |
| Escrow admin | `0x8036910a…` | Rotates the two escrow roles. Cold. |

Four roles, four keys. The point is that no single leak is now enough to take
money: the ops key spends its own wallet but cannot touch holds; the attestor
can release a hold only to the person it was locked for; the registry admin
could redirect a hold but cannot spend; and the escrow admin can rotate roles
but not move a cent.

The pairing that would still hurt is registry admin plus attestor — one to
point an identity at an attacker wallet, the other to release into it. Those
are the two hot keys, so they are the ones worth watching.

#### Registry entries corrected 2026-09-06

Two active entries resolved to the wrong place. That matters more than it used
to: PaymentEscrowV2 pays whatever the registry says, so a wrong entry now
misdirects held money rather than merely a manual payment.

| Identifier | Was | Now | Why |
|------------|-----|-----|-----|
| `victor@sendit.app` | `0x…31f22618` | erased | A malformed address, and the account has no wallet, so there was nothing correct to point at. `0x6d2fe007…` |
| `ekumavictor97@gmail.com` | `0x801C78F2…` | `0xFF3fE061…` | Resolved to an address belonging to no user row. `0xce84cbbe…` then `0xa840b3be…` |

A third entry, handle `ekumanzubechi97`, was reported as wrong earlier and was
not. The check that found it printed the stored address without reading the
`active` flag, and the entry is inactive — it resolves to nothing and can
misdirect nothing.

Every active entry now resolves to the wallet its owner actually uses,
confirmed by a full sweep: four entries, zero mismatches. Where a person has
several user rows sharing an email, "actually uses" means the row carrying the
activity, not the most recent one.

#### IdentityRegistry admin — handed over 2026-09-06

`0x24755738d0461779179304bb7520078Af4Cde026`, handover tx `0x1fcb796c…`.
Funded with 3 USDC, because `adminLink` runs on every signup and Arc charges
gas in USDC. The key was generated on the server, written straight to
`server/.env`, and never printed; the operator holds the only backup.

Verified in both directions rather than assumed:

- The new key links and unlinks. A throwaway identity was linked
  (`0x7ec0110a…`), read back, and unlinked again (`0x7abf367b…`), so no real
  entry was touched to prove it.
- The old shared key is now rejected by `adminLink` with `NotAdmin`.
- The signer the server uses and the admin on chain match, so signups link
  normally.

Sequencing mattered here and is worth remembering for the next rotation. The
key was staged in `.env` under a name `config.ts` does not read, so the server
kept signing with the old key until the handover landed. Writing the live name
first would have meant every signup link failing in the gap between the two.

**What this closes.** V2 pays whoever the registry resolves a recipient to, so
registry admin is the role that can redirect held money. A leak of the ops
signer no longer reaches it.

**What it does not.** The escrow admin, deployer and ops signer remain one key
(`0xa354e21b…`). That key can still rotate the escrow attestor and spend the
ops wallet — it just can no longer rewrite identities.

#### The registry admin is now the crown jewel

Worth stating plainly because V2 changed where the risk lives. V2 no longer
lets the attestor pick who gets paid — it asks the IdentityRegistry. So
whoever controls `IdentityRegistry.adminLink` can point any email at their own
wallet and then claim every hold addressed to that identity. Trust moved from
the attestor to the registry admin; that key matters more now, not less.

`IDENTITY_ADMIN_PRIVATE_KEY` is supported in code and unset, so it currently
falls back to the shared key. Rotating it means calling
`IdentityRegistry.setAdmin`, which is **irreversible**: hand it to an address
whose key is lost and nobody can ever link or unlink an identity again. That
one wants a deliberate decision about where the key lives rather than a
generated one written into a `.env`.

### Known gaps still open

| Gap | Impact |
|-----|--------|
| Safe owners currently use soft wallets | 2-of-3 prevents a single-key takeover, but keeping enough owners on one device or in one backup account can collapse that protection. Move owners to separate hardware wallets when available. |
| Mongo primary store is one snapshot | Chunked since 2026-09-18, so the 16 MB document cap no longer applies, and saves are generation-checked across instances. Still one snapshot rather than per-record documents, so concurrent writes on different instances contend and the loser gets a 503. |
| Operator allowlist is empty locally | Treasury, test-email, and maintenance routes fail closed until the operator's Dynamic user id is added to `OPERATOR_USER_IDS`. |
| No x402 sellers on Arc Testnet | Circle's catalog has payable sellers only on Arc mainnet. `AGENT_RESOURCE_ORIGINS=circle-marketplace` will pick them up there; on testnet paid execution stays off and the app says so. |
| No deployed TLS endpoint | Production startup now requires exact HTTPS API/app origins, explicit HTTPS CORS and MongoDB; HSTS/security headers are set, but a TLS reverse proxy/host must still be deployed. |
| Circle SDK transitive dependency advisories | Direct Hono, Node adapter and Nodemailer advisories are patched. `npm audit` still reports advisories through Circle App Kit's Ethers/Solana dependency graph; npm offers only a breaking App Kit downgrade, so these need upstream Circle releases or a separately tested SDK upgrade. |
| No independent contract audit | Foundry regression and fuzz tests pass, but they are not an external audit. |

---

## Infrastructure

| Item | State |
|------|-------|
| MongoDB | **Primary** — atomic full-state snapshot plus users, protected escrows, UCW fingerprints and writer lease collections. Normalize the snapshot into collections before 16 MB/production scale. |
| WhatsApp invites | **Stub** — no Cloud API credentials wired |
| SMTP (claim / receive email) | **Works** when configured; OTP codes are printed to stdout when it is not |
| CI | **Built** — GitHub Actions runs server typecheck/tests and Foundry tests on pushes and pull requests |
| `src/` (Next.js) | **Dead** — a static mockup driven entirely by `src/lib/mock-data.ts`. No API calls, no auth. Predates the Flutter client and is not the product. |

---

## Tests

| Suite | Count |
|-------|-------|
| Server (`npm test` in `server/`) | 310 pass |
| Mobile (`flutter test --no-pub` in `mobile/`) | 38 pass (the `Inter.ttf` blocker was already fixed; this row was stale) |
| Contracts (`forge test`) | 60 pass |

`mobile/test/widget_test.dart` is skipped: it boots all 13 services and the
Dynamic SDK, so it cannot pass under the test binding. Enabling it requires
`EvabobApp` to accept injected services.

---

## Deployed contracts (Arc Testnet)

| Contract | Address |
|----------|---------|
| Admin Safe (2-of-3) | `0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2` |
| IdentityRegistryV3 (current; adds the Agent type) | `0x7a74c86b6fd0b0232d5d1eb0074547dfe1a4ffd0` |
| IdentityRegistryV2 (read by PaymentEscrowV3; people mirrored) | `0xb14355288fcE19811cccaF1589ea85e3791320a0` |
| PaymentEscrowV3 | `0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39` |
| PaymentEscrowV2 (retired 2026-09-18, never used) | `0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805` |

Ops signer, identity linker, and escrow attestor use separate EOAs and neither
hot service signer is an administrator. `/v1/health` verifies the complete role
map against chain state.

`contracts/deployments/arc-testnet.json` records the 2026-09-12 security
deployment and the superseded addresses.

---

## Running it

```powershell
cd server; npm install; npm run dev      # http://127.0.0.1:8787/v1/health
cd mobile; flutter pub get; .\run_prod.ps1 -d emulator-5554
```

For demo mode (no Dynamic login), add `ALLOW_HEADER_AUTH=true` to `server/.env`.
Never set it on a reachable host.
