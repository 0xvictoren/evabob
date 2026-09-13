# Evabob — a Circle integration showcase

**Send money like a message.** A mobile-first payments prototype where users think
in local currency (e.g. Naira) while settlement runs on **USDC on Arc Testnet**,
built on **Circle App Kit** (Send, Bridge/CCTP, Swap, Unified Balance/Gateway)
with Circle UCW PIN signing and chat-native money commands.

> **What this is.** A testnet integration showcase — an end-to-end exercise of the
> Circle stack inside a real product shell (Flutter + Hono + Solidity). It has
> **never held real value and has no users.** Some flows are complete, some are
> blocked on external gas or credentials, and a few endpoints referenced in
> earlier drafts of this file were never built. **[docs/STATUS.md](./docs/STATUS.md)
> is the single source of truth** for what actually works.

> **Not production software.** There is no independent audit, and
> several known security gaps are still open — they are listed plainly in
> STATUS.md rather than hidden. Do not point this at real money.

---

## What it does

| | |
|--|--|
| **Problem** | Cross-border and onchain money feels hard; wallets and chains block normal users. |
| **Product** | Chat-style P2P payments, Gateway top-up, Buy (swap on Arc), Bridge (CCTP), activity receipts, agent spend wallets. |
| **Settlement** | **Arc Testnet** (chain `5042002`) — USDC primary, EURC for the euro leg. Wallets are created on **Arc Testnet, Ethereum Sepolia and Base Sepolia**. |
| **Identity** | On-chain **IdentityRegistry** (hashed email / handle → wallet). Funds are received by **email, `@handle`, or a raw `0x` address** — nothing else. |
| **Auth** | **Dynamic Labs** email OTP; every `/v1` route requires the verified JWT. |
| **Custody** | **Circle User-Controlled Wallets** — all user spends go through PIN challenges. |
| **Liquidity** | **Circle App Kit**; legacy CCTP / Gateway / Synthra behind flags. |
| **Chat** | Threads + `@.` money commands; invoice pay (100% now / 50+50 / 100% escrow); **Pusher** realtime. |
| **Agents** | Dedicated Circle-held EOA per new agent, Gateway funding, spending limits, x402 batching, withdrawal and reconciliation records. Legacy shared-custody agents require migration. |

Product language stays human — *account, balance, send, buy, bridge, activity* —
not seed phrases or chain jargon.

---

## Status at a glance

Full detail, including every known gap, is in **[docs/STATUS.md](./docs/STATUS.md)**.

| Area | State |
|------|-------|
| Circle UCW onboarding + PIN challenges | Works |
| App Kit send / swap / deposit / spend / compose | Works |
| Chat, invoice pay, on-chain protected escrow | Works |
| Activity history + receipts | Works |
| Auth, rate limiting, atomic store writes | Works |
| **Bridge (CCTP)** | **Partial** — mint on Base Sepolia blocked on ops-wallet ETH |
| **Gateway unified balance** | **Partial** — server routes work, product UI paused |
| **Swap (Synthra)** | **Partial** — needs `SYNTHRA_API_KEY`; without it, quotes are approximate FX, not market prices |
| `POST /v1/transfers/send`, `/v1/exchange` | **Retired (410)** — cannot fabricate payment or swap history |
| `PaymentEscrowV2` contract | **Deployed and wired** — protected and invoice escrow settle on chain |
| Agent x402 paid execution | **Built, opt-in** — requires a new dedicated agent EOA, finalized Gateway deposit and an exact `AGENT_RESOURCE_ORIGINS` allowlist |
| Phone as payee / identity type | **Removed** — payees are email, `@handle` or `0x` |
| WhatsApp invites | **Stub** |
| CI | **Built** — GitHub Actions runs server typecheck/tests and Foundry tests |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Flutter mobile (Dart) — Android + iOS   ← the product           │
│  Home · Chat · Send · Buy · Bridge · Assets · Activity · Agents  │
│  Profile · Circle PIN WebView · App Kit UCW jobs                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP (emulator → 10.0.2.2:8787)
┌──────────────────────────────▼───────────────────────────────────┐
│  TypeScript API (Node + Hono) — server/                          │
│  Auth middleware · App Kit · UCW challenges · Identity           │
│  Escrow evidence · Chat · Agents · Pusher · Mongo/JSON          │
│  Legacy: Gateway · CCTP · Synthra (feature-flagged)              │
└───────────┬──────────────────────────────┬───────────────────────┘
            │                              │
            ▼                              ▼
   Arc Testnet (Solidity)           Circle App Kit / UCW / Dynamic
   IdentityRegistry (used)          CCTP · Gateway · Swap · Pusher
   PaymentEscrowV2 (used)
```

| Layer | Stack |
|-------|--------|
| **Frontend** | Dart / Flutter (Android + iOS) |
| **Backend** | TypeScript / Node.js / Hono / Zod / viem |
| **Money movement** | `@circle-fin/app-kit` + Circle Wallets / viem adapters |
| **Contracts** | Solidity / Foundry on Arc Testnet |
| **Auth** | Dynamic Labs (env id on device; JWT verified against JWKS on server) |
| **User wallets** | Circle UCW (PIN challenges in WebView) |
| **Ops wallets** | Circle developer-controlled (`APP_KIT_DC_WALLET`) or `PRIVATE_KEY` |
| **Store** | MongoDB atomic primary snapshot for users, activity, chat, agents, invoices and protected escrows; JSON is a development fallback/local mirror |
| **Realtime** | Pusher Channels |

---

## Repository layout

```
Evabob/
├── mobile/                 # Flutter app — the product
│   ├── lib/core/           # API client, auth, wallet, chat, FX, activity, theme
│   ├── lib/features/       # Home, chat, send, buy, bridge, assets, agents…
│   └── dart_defines.json   # Public compile-time defines
├── server/                 # TypeScript API — all money logic
│   ├── src/middleware/     # auth, rate limiting
│   ├── src/routes/         # api, app-kit, circle-wallets, gateway, cctp, identity, agent
│   ├── src/services/       # appKit, UCW, escrow ledger, x402, intent parser…
│   └── src/store/          # DB facade (Mongo + JSON)
├── contracts/              # Foundry: IdentityRegistry, PaymentEscrowV2 and regression tests
├── docs/                   # STATUS (source of truth), ARCHITECTURE, ENV, DEPLOY
├── src/                    # Dead Next.js mockup — not the product, mock data only
└── README.md
```

---

## Money movement

Core flows use **Circle App Kit** (`@circle-fin/app-kit`) over CCTP, Gateway and
swaps. **Circle UCW** signs end-user spends via PIN; ops and treasury use the
developer-controlled Circle Wallets adapter or a server `PRIVATE_KEY` (viem).

```
Send (same-chain)           →  App Kit send
Swaps (USDC ↔ EURC on Arc)  →  App Kit swap  (Synthra fallback)
Bridges (USDC cross-chain)  →  App Kit bridge → CCTP V2
Gateway (unified USDC)      →  App Kit unifiedBalance
Signing / user spend        →  Circle UCW PIN  (App Kit UCW adapter jobs)
Ops / treasury / agents     →  Circle Wallets adapter or viem PRIVATE_KEY
```

### Adapters

- **`circle-wallets`** (default) — developer-controlled wallet via API key + entity secret; set `APP_KIT_DC_WALLET`
- **`viem-ops`** — server `PRIVATE_KEY` fallback
- **UCW** — `createCircleUserWalletAdapter` + PIN challenges in the Flutter WebView

### Gas on testnet

| Chain role | Native gas needed? |
|------------|--------------------|
| Arc send / swap / burn | **No** — gas is paid in USDC |
| Source on other EVMs | Yes (ETH/AVAX/…) unless sponsored |
| Destination bridge mint | **No** by default — Circle Forwarder pays destination gas |

In practice the Base Sepolia mint path currently still needs ops-wallet ETH; see
STATUS.md.

Chat commands: `@. send …`, `@. buy …`, `@. bridge …`, `@. deposit …`

---

## API (`/v1`)

Base URL (local): `http://127.0.0.1:8787`

**Auth:** every route below requires `Authorization: Bearer <dynamic-jwt>` except
`/health`, `/config/public` and `/fx/rates`. Setting `ALLOW_HEADER_AUTH=true`
re-enables the legacy `x-user-id` header for local demo builds — see
[docs/ENV.md](./docs/ENV.md).

### System
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Service + integration flags |
| `GET` | `/config/public` | Arc addresses, Circle app id, Pusher public key |
| `GET` | `/fx/rates` | USD → NGN display rate |
| `GET` | `/challenge` *(not under `/v1`)* | Circle PIN WebView host page |

### App Kit (`/app-kit`)
| Method | Path |
|--------|------|
| `GET` | `/health` · `/events` · `/balances` · `/jobs` · `/jobs/:id` |
| `POST` | `/send` · `/bridge` · `/swap` · `/deposit` · `/spend` · `/compose` (ops) |
| `POST` | `/ucw/send` · `/ucw/bridge` · `/ucw/swap` · `/ucw/deposit` · `/ucw/spend` · `/ucw/compose` |
| `POST` | `/bridge/quote` · `/jobs/reconcile` · `/jobs/:id/recover` · `/jobs/:id/signature` |

### Circle UCW (`/circle`) — user funds
| Method | Path |
|--------|------|
| `GET` | `/config` · `/challenge-bootstrap` |
| `POST` | `/create-user` · `/session` · `/initialize` · `/prepare-pin` · `/wallets` · `/balances` |
| `POST` | `/verify-pin` · `/verify-challenges` · `/confirm-activity` |
| `POST` | `/transfer` · `/send` · `/swap` · `/identity/link` |
| `POST` | `/gateway/deposit` · `/gateway/pay` |
| `POST` | `/cctp/burn` · `/cctp/burn/continue` · `/cctp/finish` |

### Users, wallet, activity
| Method | Path |
|--------|------|
| `POST` | `/users/session` · `/users/me` · `/users/me/avatar` · `/users/handle` |
| `GET` | `/users/me` · `/users/handle/check` · `/activity` · `/contacts` |
| `PATCH` | `/users/me` · `/activity/:id` |
| `GET` | `/wallet/balances` · `/wallet/deposit-addresses` |
| `POST` | `/wallet/withdraw` · `/contacts` · `/contacts/:id/delete` |

`POST /users/me/phone/start` and `/confirm` still exist but return **HTTP 410** —
phone is no longer a payee or profile field.

### Chat, agent, payment requests
| Method | Path |
|--------|------|
| `GET` | `/chat/threads` · `/chat/threads/:id/messages` |
| `POST` | `/chat/threads` · `/chat/threads/:id/messages` · `/send-command` · `/money-command` |
| `POST` | `/agent/parse` · `/agent/message` · `/agent/confirm` — Groq-backed NLU, never moves money |
| `GET` | `/agent/thread` · `/payment-requests` · `/payment-requests/:id` |
| `POST` | `/payment-requests` · `/payment-requests/:id/mark` |
| `POST` | `/pusher/auth` · `/pusher/config` |

### Escrow
| Method | Path |
|--------|------|
| `GET` | `/escrow/hold-address` · `/escrow/pending` · `/escrow/job/:id` |
| `POST` | `/escrow/protected/plan` · `/record` · `/:transferId/release` · `/escrow/process-expired` (operator) |

The old `/escrow/job`, `/:id/complete`, and `/:id/reject` money paths return
410. Legacy read and deliverable routes are scoped to the payer or exact
recipient while old testnet records are retired.

### Agents
| Method | Path |
|--------|------|
| `GET` | `/agents` · `/agents/:id/custody` · `/agents/:id/payments` |
| `POST` | `/agents` · `/agents/:id/deposit` · `/agents/:id/withdraw` · `/agents/:id/revoke` · `/agents/:id/rotate-key` · `/x402/pay` |

`/agents/services` and `/agents/:id/run` are not built. Agent keys are shown
once and rotated if lost; the insecure reveal route was removed.
Paid calls require `Authorization: Bearer sk_evabob_…` and an
`Idempotency-Key` header between 16 and 100 characters.

### Legacy (mounted when `APP_KIT_KEEP_LEGACY=true`)
| Method | Path |
|--------|------|
| `GET` | `/gateway/balances` · `/gateway/deposit-addresses` · `/cctp/domains` · `/cctp/attestation` |
| `POST` | `/gateway/deposit` · `/deposit-calldata` · `/withdraw` |
| `POST` | `/cctp/burn` · `/burn-calldata` · `/receive` · `/complete` |
| `GET/POST` | `/synthra/health` · `/synthra/quote` · `/synthra/bridge/quote` · `/exchange` · `/transfers/send` |

---

## Deployed contracts (Arc Testnet)

| Contract | Address |
|----------|---------|
| **Admin Safe (2-of-3)** | [`0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2`](https://testnet.arcscan.app/address/0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2) |
| **IdentityRegistryV2** | [`0xb14355288fcE19811cccaF1589ea85e3791320a0`](https://testnet.arcscan.app/address/0xb14355288fcE19811cccaF1589ea85e3791320a0) |
| **PaymentEscrowV2** | [`0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805`](https://testnet.arcscan.app/address/0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805) |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| CCTP TokenMessenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP domain | **26** (Arc Testnet) |

The contracts have Foundry regression tests but no independent audit. The Safe
owns both admin roles; ops, identity linking, and escrow attestation use three
different hot wallets. See [the multisig runbook](./docs/KEY_ROTATION.md).

Security redeploy: `contracts/script/DeployRoleSeparated.s.sol`.

---

## Settlement rules

1. **USDC on the Arc wallet** — spendable for Send, Buy (as input), Bridge (CCTP burn), Gateway top-up.
2. **Gateway unified USDC** — only after `approve` + `deposit()`. A plain transfer to the Gateway address does **not** credit the unified balance.
3. **EURC** — Arc wallet only, not Gateway.
4. **Bridge** — burns wallet USDC on Arc; destination mint follows Circle Iris attestation.
5. **User signing** — every user fund move goes through a Circle PIN challenge; the server `PRIVATE_KEY` is ops only.

---

## Quick start

### 1. Environment

Root `.env` and/or `server/.env` — never commit secrets. Full list in
[docs/ENV.md](./docs/ENV.md); template in `server/.env.example`.

```env
# Auth — every /v1 route needs a verified Dynamic JWT
DYNAMIC_ENVIRONMENT_ID=...
DYNAMIC_API_TOKEN=...
ALLOW_HEADER_AUTH=false           # true only for local demo-mode builds
CORS_ORIGINS=*                    # restrict outside development
OPERATOR_USER_IDS=                # comma-separated allowlist for treasury/CCTP operations

# Circle UCW + App Kit
CIRCLE_API_KEY=TEST_API_KEY:...
CIRCLE_WALLETS_APP_ID=...
CIRCLE_ENTITY_SECRET=...          # 64 hex chars
APP_KIT_DC_WALLET=0x...
USE_APP_KIT=true
APP_KIT_ADAPTER=circle-wallets    # or viem-ops
APP_KIT_KEEP_LEGACY=true

# Arc ops + contracts
PRIVATE_KEY=0x...
IDENTITY_LINKER_PRIVATE_KEY=0x...
ESCROW_ATTESTOR_PRIVATE_KEY=0x...
ADMIN_SAFE_ADDRESS=0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2
IDENTITY_REGISTRY=0xb14355288fcE19811cccaF1589ea85e3791320a0
PAYMENT_ESCROW=0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805
ARC_RPC_URL=https://rpc.testnet.arc.network

# Optional — without SYNTHRA_API_KEY, Buy cannot execute on-chain
SYNTHRA_API_KEY=sk_test_...
MONGODB_URI=...
PUSHER_APP_ID=... / PUSHER_KEY=... / PUSHER_SECRET=...
```

### 2. API

```powershell
cd server
npm install
npm run dev      # → http://127.0.0.1:8787/v1/health
npm test         # 91 tests
```

### 3. Mobile

```powershell
cd mobile
flutter pub get
flutter test     # 13 pass, 1 skipped
flutter run -d emulator-5554 --dart-define=API_BASE_URL=http://10.0.2.2:8787 --dart-define=AUTO_DEMO=false
```

| Platform | API base |
|----------|----------|
| Android emulator | `http://10.0.2.2:8787` |
| iOS simulator / desktop | `http://127.0.0.1:8787` |

`dart_defines.json` now sets `API_BASE_URL` explicitly. `run_prod.ps1 install`
builds a shareable APK, so it asks for confirmation when the base URL is a
loopback address or plain HTTP — such a build only works on this machine's
emulator. Pass `--dart-define=API_BASE_URL=https://<host>` for a real one.

### 4. Contracts (optional redeploy)

```powershell
cd contracts
.\script\deploy-and-save.ps1
```

Fund the deployer with Arc Testnet USDC at [faucet.circle.com](https://faucet.circle.com).

---

## Local-dev pitfalls

| Symptom | Cause | Fix |
|---------|--------|-----|
| Every request returns `401 unauthorized` | No Dynamic session, or demo mode | Sign in, or set `ALLOW_HEADER_AUTH=true` in `server/.env` |
| `Connection refused … 10.0.2.2:8787` | API not running | `cd server && npm run dev` |
| Buy says "set SYNTHRA_API_KEY" | Missing or misparsed key | `SYNTHRA_API_KEY=sk_…` in `.env` (no spaces); restart |
| Gateway balance 0 after transfer | Sent without `deposit()` | Use in-app Top-up (approve + deposit) |
| Wallet "Not linked yet" | PIN onboarding never finished | Profile → Set up wallet, with the server running |
| `429 rate_limited` | Rate limit hit | 300/min general, 10/min on spend-bearing routes |

---

## Docs

| Doc | Contents |
|-----|----------|
| **[docs/STATUS.md](./docs/STATUS.md)** | **Source of truth** — what works, what is partial, what is not built, open gaps |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Data flow, security rules, network constants |
| [docs/ENV.md](./docs/ENV.md) | Environment variables |
| [docs/DEPLOY_AND_WALLETS.md](./docs/DEPLOY_AND_WALLETS.md) | Deploy + wallet setup |
| [docs/KEY_ROTATION.md](./docs/KEY_ROTATION.md) | Splitting the shared deployer / admin / attestor / ops key — **not yet executed** |

---

## Secrets

Keep `.env`, `PRIVATE_KEY`, `DYNAMIC_API_TOKEN`, `CIRCLE_API_KEY`,
`CIRCLE_ENTITY_SECRET`, `SYNTHRA_API_KEY`, `PUSHER_SECRET` and SMTP passwords out
of git. Rotate anything ever pasted into a chat or a ticket.

---

**Evabob** — local-currency feel, USDC settlement on Arc, Circle rails underneath.
Testnet only.
