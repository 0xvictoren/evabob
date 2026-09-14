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
| `GROQ_API_KEY` | Server-only LLM for the evabob Agent |
| `GROQ_MODEL` | default `openai/gpt-oss-120b` |
| `DYNAMIC_ENVIRONMENT_ID` | Dynamic Labs login |
| `DYNAMIC_API_TOKEN` | Server JWT verify (optional for some paths) |
| `CIRCLE_WALLETS_APP_ID` | Circle UCW app |
| `CIRCLE_API_KEY` | Circle server API |
| `PRIVATE_KEY` | Ops EOA for gas and working capital; holds no contract admin role |
| `IDENTITY_LINKER_PRIVATE_KEY` | Dedicated hot signer for verified identity links and same-owner unlinks |
| `ESCROW_ATTESTOR_PRIVATE_KEY` | Dedicated hot signer that releases verified protected transfers |
| `ADMIN_SAFE_ADDRESS` | Expected 2-of-3 Safe address used by health and startup checks |
| `IDENTITY_REGISTRY` | Arc IdentityRegistry address |
| `PAYMENT_ESCROW` | Arc PaymentEscrow address |
| `OPERATOR_USER_IDS` | Comma-separated Dynamic user ids allowed to use treasury and maintenance routes; empty fails closed |
| `AGENT_RESOURCE_ORIGINS` | Exact HTTPS origins permitted for agent resource discovery; empty blocks outbound resource calls |
| `API_PUBLIC_URL` | Exact external HTTPS API origin; required when `NODE_ENV=production` |
| `CRON_SECRET` | Render-generated bearer secret shared only with the hourly refund cron |
| `RUN_INTERNAL_REFUND_JOB` | Set `false` on Render so only the external cron runs refunds; local Node defaults to its timer |

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

## ExchangeRate-API (USDC/USD → Naira display)

| Variable | Purpose |
|----------|---------|
| `EXCHANGE_RATE_API_KEY` | Server-only key for [ExchangeRate-API](https://www.exchangerate-api.com/) |

- Endpoint used: `GET https://v6.exchangerate-api.com/v6/{KEY}/latest/USD`
- App exposes rates at `GET /v1/fx/rates` (mobile never sees the key)
- USDC display treats **1 USDC = 1 USD**, then multiplies by live `NGN`
- Without the key, server falls back to a static ~₦1628 rate; mobile may also try the free open endpoint

## Circle App Kit (primary money movement)

| Variable | Purpose |
|----------|---------|
| `USE_APP_KIT` | Master switch (default `true`). Set `false` to force legacy paths only |
| `CIRCLE_ENTITY_SECRET` | 64-char entity secret — required for developer-controlled Circle Wallets adapter |
| `KIT_KEY` / `CIRCLE_KIT_KEY` | Optional Circle Console kit key for Swap (avoids rate limits) |
| `APP_KIT_ADAPTER` | `circle-wallets` (default) or `viem-ops` (server `PRIVATE_KEY`) |
| `APP_KIT_DC_WALLET` / `CIRCLE_DC_WALLET` | Default developer-controlled wallet `0x…` (used when `fromAddress` omitted) |
| `APP_KIT_KEEP_LEGACY` | Keep `/v1/cctp` + `/v1/gateway` mounted (default `true`) |

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

## Evabob Agent (Groq LLM fallback)

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Server-only Groq key (`gsk_…`). Used only when the deterministic parser is unsure |
| `GROQ_MODEL` | Default `openai/gpt-oss-120b` |

The agent thread is auto-created per user (`GET /v1/chat/threads`). Money intents never execute on the server — the app shows Confirm, then Circle PIN.

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
- Circle app id is public; PIN runs via WebView against the API `/challenge` page
