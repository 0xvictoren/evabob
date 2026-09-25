# evabob environment variables

Never commit real secrets. Put values in monorepo root `.env` and/or `server/.env`.

`EVABOB_ENV` separates `local`, `testnet`, and `production`. Hosted testnet
uses `NODE_ENV=production` with `EVABOB_ENV=testnet`; `NODE_ENV` controls the
Node runtime while `EVABOB_ENV` controls chain and deployment safety. Use
[`server/.env.testnet.example`](../server/.env.testnet.example) as the hosted
testnet checklist. Production is deliberately locked by
`ENABLE_PRODUCTION_LAUNCH=false` until mainnet values have been reviewed.

## Required for full stack

| Variable | Purpose |
|----------|---------|
| `APP_NAME` | Display name (default `evabob`) |
| `EVABOB_ENV` | `local`, `testnet`, or `production` deployment boundary |
| `DATA_DIR` | Writable local mirror; `/var/data/evabob` on the Render persistent disk (Mongo remains authoritative) |
| `DEEPSEEK_API_KEY` | Server-only LLM for the evabob Agent |
| `DEEPSEEK_MODEL` | default `deepseek-flash` |
| `DYNAMIC_ENVIRONMENT_ID` | Dynamic Labs login |
| `DYNAMIC_API_TOKEN` | Server JWT verify (optional for some paths) |
| `CIRCLE_WALLETS_APP_ID` | Circle UCW app |
| `CIRCLE_API_KEY` | Circle server API |
| `PRIVATE_KEY` | Ops EOA for gas and working capital; holds no contract admin role |
| `IDENTITY_LINKER_PRIVATE_KEY` | Dedicated hot signer for verified identity links and same-owner unlinks |
| `ESCROW_ATTESTOR_PRIVATE_KEY` | Dedicated hot signer that releases verified protected transfers |
| `ADMIN_SAFE_ADDRESS` | Expected 2-of-3 Safe address used by health and startup checks |
| `IDENTITY_REGISTRY` | Arc IdentityRegistry address |
| `ESCROW_IDENTITY_REGISTRY` | The registry PaymentEscrowV3 reads (V2) when `IDENTITY_REGISTRY` is V3. People are linked in both; agents only in V3. |
| `PAYMENT_ESCROW` | Arc PaymentEscrow address |
| `OPERATOR_USER_IDS` | Comma-separated Dynamic user ids allowed to use treasury and maintenance routes; empty fails closed |
| `AGENT_RESOURCE_ORIGINS` | Exact HTTPS origins permitted for agent resource discovery; empty blocks outbound resource calls |
| `API_PUBLIC_URL` | Exact external HTTPS API origin; required when `NODE_ENV=production` |
| `CRON_SECRET` | Render-generated bearer secret shared only with the hourly refund cron |
| `RUN_INTERNAL_REFUND_JOB` | Set `false` on Render so only the external cron runs refunds; local Node defaults to its timer |
| `TRUST_PROXY` | `true` behind Render's proxy, so rate limits key on the client address rather than the proxy's |
| `CLIENT_IP_HEADER` | Header the hosting edge sets to the real client address and overwrites if a client sends it (`true-client-ip` on Render). Read ahead of `X-Forwarded-For`, whose left-most entry a client can forge. When a request lacks it, `X-Forwarded-For` is used as before |
| `GATEWAY_PAY_REQUIRE_PIN` | `true` asks for the person's PIN on every GA payment (see `SECURITY_UPDATES.md`). Default `false` until checked on a phone |

Feature variables are server-authoritative: `FEATURE_DIRECT_SEND`,
`FEATURE_PROTECTED_SEND`, `FEATURE_REQUESTS`, `FEATURE_GATEWAY`,
`FEATURE_CONVERSION`, `FEATURE_BRIDGE_ROUTES`, `FEATURE_AGENT_WALLETS`,
`FEATURE_X402_EXECUTION`, and `FEATURE_AGENT_BATCH_SEND`. Leave an unproved
capability false/empty; Flutter hides it after loading `/v1/config/public`.

## MongoDB (authoritative application snapshot)

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | e.g. `mongodb://127.0.0.1:27017` or Atlas `mongodb+srv://…`; required in production |
| `MONGODB_DB` | Database name (default `evabob`) |
| `MONGODB_STANDARD_URI` | Optional non-SRV fallback if `mongodb+srv` fails on your network |

Mongo's `primary_store` document atomically covers users, activity, chats,
transfers, agent balances, invoices and protected escrows. It is restored before
stateful modules load, and request responses wait for its write. Local JSON is a
development fallback and mirror. A renewable lease prevents competing snapshot
writers. Production requires MongoDB and fails closed when it is unavailable.

### Why Atlas often fails on this Windows laptop

Common log: `querySrv ECONNREFUSED` or `tlsv1 alert internal error (SSL alert 80)`.

| Cause | Fix |
|-------|-----|
| Atlas Network Access IP not allowlisted | Atlas → Network Access → Add your public IP (or `0.0.0.0/0` for test only) |
| Local DNS can’t resolve SRV | Server already retries with `8.8.8.8` / `1.1.1.1` |
| TLS interception (antivirus / WARP / proxy) | Disable Cloudflare WARP / SSL inspection for Node, or use local Mongo |
| Corporate firewall blocking 27017 | Use Atlas private endpoint or local Mongo |

Until Atlas TLS succeeds, the JSON fallback is available only for development.

## Synthra (on-chain buy / swap quotes on Arc)

| Variable | Purpose |
|----------|---------|
| `SYNTHRA_API_KEY` | `sk_test_…` / `sk_live_…` (no spaces around `=`) |
| `SYNTHRA_API_BASE` | default `https://trading-api.synthra.org` |

- **Buy** (`POST /v1/circle/swap`) uses Synthra `POST /v1/quote` + `/v1/swap` with **raw 6-decimal amounts**, `approvalMode: erc20`, then Circle UCW PIN challenges (approve + swap calldata).
- **Bridge** uses Circle CCTP (`POST /v1/circle/cctp/burn`), not Synthra’s limited CCTP router.
- Without the key, quote falls back to approximate FX and buy cannot execute on-chain.

## WhatsApp (unregistered phone invites)

| Variable | Purpose |
|----------|---------|
| `WHATSAPP_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business phone number id |
| `WHATSAPP_API_BASE` | default `https://graph.facebook.com/v19.0` |

Without these, WhatsApp notify is stubbed (logged only). Email still uses SMTP.

## SMTP (claim / receive emails)

| Variable | Purpose |
|----------|---------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Mailtrap or production SMTP |

Testnet uses Brevo (`smtp-relay.brevo.com`, port 2525). Brevo's **Authorized
IPs** restriction must stay off (or include the host's outgoing addresses):
with it on, Render's changing IPs are refused with `525 5.7.1 Unauthorized IP
address` and no email goes out — claim links, family-check codes and account
recovery all depend on it. Check with `GET /v1/health` → `smtp.ok`. Many home
and office networks block outgoing SMTP ports, so a local login test can hang
even when the credentials are fine.

`PAYMENT_ESCROW` is needed at runtime, but the server tests no longer need it:
CI runs without a `.env`.

## Display exchange rate

- The app uses the fixed product rate **1 USD / 1 USDC = ₦1,390**.
- `GET /v1/fx/rates` exposes that value to clients; no exchange-rate API key is required.

## Circle App Kit (primary money movement)

| Variable | Purpose |
|----------|---------|
| `USE_APP_KIT` | Master switch (default `true`). Set `false` to force legacy paths only |
| `CIRCLE_ENTITY_SECRET` | 64-char entity secret — required for developer-controlled Circle Wallets adapter |
| `KIT_KEY` / `CIRCLE_KIT_KEY` | Optional Circle Console kit key for Swap (avoids rate limits) |
| `APP_KIT_ADAPTER` | `circle-wallets` (default) or `viem-ops` (server `PRIVATE_KEY`) |
| `APP_KIT_DC_WALLET` / `CIRCLE_DC_WALLET` | Default developer-controlled wallet `0x…` (used when `fromAddress` omitted) |
| `APP_KIT_KEEP_LEGACY` | Keep the pre-App Kit rails — `/v1/cctp`, `/v1/gateway`, the Synthra swap (`/v1/circle/swap`) and direct CCTP burns (`/v1/circle/cctp/burn`). Default `false`: swaps and bridges use App Kit only. `/v1/circle/cctp/finish` always stays, to finish burns already made |

## Platform fee

Evabob charges 0.05% on top of every send, protected send, request payment,
bridge, convert, GA top-up, GA payment and agent-wallet funding. Gas is not
included. There is no minimum: a fee that rounds below one token unit is zero.

| Variable | Purpose |
|----------|---------|
| `PLATFORM_FEE_ADDRESS` | `0x…` wallet that receives the fee. Empty or malformed turns the fee off everywhere |
| `PLATFORM_FEE_BPS` | Basis points, default `5` (0.05%) |

`APP_KIT_FEE_RECIPIENT` / `APP_KIT_FEE_BPS` are still read as a fallback when
the `PLATFORM_FEE_*` names are unset.

How it is collected, without a second PIN:

- **Sends, protected sends, GA top-ups, legacy bridge burns and legacy Synthra
  swaps**: the payment and the fee transfer are wrapped in the wallet's own
  `executeBatch` and approved as one Circle challenge. Both land or neither does.
- **Bridges and converts through App Kit**: App Kit's `customFee`. Circle keeps
  10% of every App Kit custom fee, so the fee wallet receives 90% on these.
- **GA payments**: an extra burn intent to the fee wallet inside the same
  Gateway transfer, signed by the platform delegate. It mints on the payment's
  destination chain, and Gateway charges its per-intent gas fee for it.
- App Kit `send`, unified-balance `deposit`/`spend` and composed spends cannot
  carry a fee, so those routes refuse while a fee is configured.

App Kit endpoints: `GET/POST /v1/app-kit/*` (send, bridge, swap, deposit, spend, compose, UCW jobs).

- **Ops / treasury**: server-signed via Circle Wallets adapter or viem `PRIVATE_KEY`
- **End-user UCW**: `POST /v1/app-kit/ucw/*` returns a `jobId` + PIN challenges; poll `GET /v1/app-kit/jobs/:id`
- **Chat**: `POST /v1/chat/threads/:id/money-command` routes buy/bridge/compose through App Kit

## Evabob Agent (DeepSeek LLM)

| Variable | Purpose |
|----------|---------|
| `DEEPSEEK_API_KEY` | Server-only DeepSeek key. Powers the assistant's tool-calling answers and the intent fallback when the deterministic parser is unsure |
| `DEEPSEEK_MODEL` | Default `deepseek-flash`. Must support tool calling |
| `DEEPSEEK_BASE_URL` | Default `https://api.deepseek.com` |
| `DEEPSEEK_THINKING` | Default `false`. Thinking mode is slower and ignores temperature; leave off for chat |

The agent thread is auto-created per user (`GET /v1/chat/threads`). Money intents never execute on the server — the app shows Confirm, then Circle PIN.

## Held payments, bridges and scheduled work

| Variable | Purpose |
|----------|---------|
| `PAYMENT_ESCROW` | PaymentEscrowV3, `0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39` on Arc Testnet. V3 is required: early refunds and review extensions use functions V2 does not have |
| `CRON_SECRET` | Bearer token for `/internal/cron/tick` and `/internal/cron/escrow-refunds`. Vercel Cron sends it automatically when set |
| `BRIDGE_ABANDON_WINDOW_MINUTES` | Default `40`. How long a person has to finish a burned bridge before the server finishes it. The 2× gas charge is recorded on the job and not collected (waived on testnet) |
| `OPERATOR_USER_IDS` | Also who may decide held-payment reviews (`/v1/operator/reviews`) and who is alerted when one opens |
| `MONEY_CIRCLES_ADDRESS` | MoneyCircles, `0x482497289a4F5197f67f98B2535cd23D6238d256` on Arc Testnet. Unset: circles are off. The tick collects due rounds and catches up behind members from the ops wallet (`PRIVATE_KEY`), which pays the gas |
| `GROUP_POTS_ADDRESS` | GroupPots, `0x3CBDdab2398e06d5FB496a9DbF9424abD449D795` on Arc Testnet. Unset: collections are off. The tick refunds collections that missed their target |
| `APP_PUBLIC_URL` | Also the base of every public link: receipts `/r/…`, hold links `/h/…`, collections `/g/…`. Until the web app is hosted these only open on the machine running it |

## Push notifications (FCM)

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Service-account key JSON from Firebase (Project settings → Service accounts), pasted as-is or base64-encoded. Unset = push off; in-app Pusher alerts still work. iPhones also need an APNs key uploaded in Firebase → Cloud Messaging |

## Agent wallets — paid calls

`AGENT_RESOURCE_ORIGINS` takes exact HTTPS origins, and may include the token
`circle-marketplace` to add every origin in Circle's x402 catalog that the
payer can settle with (GET, Gateway-batched, on this network). On Arc Testnet
that set is empty today — the catalog's payable sellers are all on Arc
mainnet — so paid calls stay off and the app says so.

## Optional

| Variable | Purpose |
|----------|---------|
| `PUSHER_*` | Real-time chat |
| `APP_PUBLIC_URL` | Claim links in emails |
| `GATEWAY_API_BASE` | Circle Gateway API |
| `PORT` | API port (default `8787`) |

## Mobile

Public defines only (no secrets):

- `DYNAMIC_ENVIRONMENT_ID`, `PUSHER_KEY`, `PUSHER_CLUSTER`, `API_BASE_URL`
- Push (optional, from the Firebase console's app settings):
  `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`,
  `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`, `FIREBASE_IOS_BUNDLE_ID`.
  No `google-services.json` is needed; leave them empty and push stays off.
- Circle app id is public; PIN runs via WebView against the API `/challenge` page

`API_BASE_URL` has two supported modes:

- Debug: local HTTP is permitted by `android/app/src/debug/AndroidManifest.xml`.
- Release/profile: the main Android manifest blocks cleartext. Android release
  builds fail unless the value is an exact HTTPS origin, and the app repeats
  the check at startup as defense in depth.

Use a host with a publicly trusted certificate. Do not include a path, query,
fragment, or credentials in the origin. Verify the deployed health endpoint
before generating a replacement APK/AAB; a valid certificate alone does not
mean the API is serving the application.
