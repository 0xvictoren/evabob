# Evabob API (TypeScript / Node / Hono)

Backend for the Flutter app (Android + iOS). Holds secrets, runs **Circle App Kit** (Send / Bridge / Swap / Unified Balance), Circle UCW PIN challenges, and Pusher auth.

## Languages

| Surface | Language |
|---------|----------|
| Frontend (mobile) | **Dart (Flutter)** |
| Backend | **TypeScript (Node + Hono)** |
| Contracts | **Solidity (Foundry)** |

## Setup

```powershell
cd server
copy .env.example .env
# Edit .env — put DYNAMIC_API_TOKEN, CIRCLE_API_KEY, PRIVATE_KEY, etc.
npm install
npm run dev
```

Health: `http://127.0.0.1:8787/v1/health`  
App Kit: `http://127.0.0.1:8787/v1/app-kit/health`

## Circle App Kit

Primary money movement surface (`USE_APP_KIT=true` by default).

| Endpoint | Role |
|----------|------|
| `POST /v1/app-kit/send` | Same-chain transfer (ops / viem / Circle Wallets) |
| `POST /v1/app-kit/bridge` | Cross-chain USDC (CCTP) |
| `POST /v1/app-kit/swap` | USDC ↔ EURC on Arc |
| `POST /v1/app-kit/deposit` / `spend` | Unified Balance (Gateway) |
| `POST /v1/app-kit/compose` | Multi-step spend → swap → bridge |
| `POST /v1/app-kit/ucw/*` | User-controlled jobs + PIN challenges |
| `GET /v1/app-kit/jobs/:id` | Poll job status / challenges / result |

Env: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` (dev-controlled adapter), `KIT_KEY` (swap), `APP_KIT_FEE_BPS` + `APP_KIT_FEE_RECIPIENT` (monetization). Legacy `/v1/cctp` + `/v1/gateway` stay mounted when `APP_KIT_KEEP_LEGACY=true`.

## Dynamic Labs (mobile + server)

1. Open [Dynamic Dashboard](https://app.dynamic.xyz/dashboard/api)
2. Copy **Environment ID** → mobile `DYNAMIC_ENVIRONMENT_ID` / `dart_defines.json`
3. Copy **API token** (`dyn_…`) → **server only** `DYNAMIC_API_TOKEN`
4. Run Flutter with:
   ```powershell
   flutter run --dart-define=DYNAMIC_ENVIRONMENT_ID=YOUR_ENV_ID --dart-define=AUTO_DEMO=false
   ```
5. Server verifies user JWTs via JWKS (no secret on device).

**Never** put `DYNAMIC_API_TOKEN` in Flutter.

## Deploy contracts (Arc Testnet)

```powershell
# In contracts/ — key only via env, never chat
$env:PRIVATE_KEY = "0x..."   # local session only
$env:CLAIM_ATTESTOR = "0x..." # optional backend signer
cd ..\contracts
.\script\deploy-arc.ps1
```

Then set `IDENTITY_REGISTRY` / `PAYMENT_ESCROW` in `server/.env` and rebuild mobile with dart-defines if needed.

## Pusher

When ready, add `PUSHER_*` to `.env`. Frontend uses public `PUSHER_KEY` + `PUSHER_CLUSTER` only.
