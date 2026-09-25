# Evabob architecture

Describes the **intended** Arc-native design. Where the code has not caught up —
`transfers/send` is still a ledger stub, `PaymentEscrow` is deployed but unwired,
Gateway is paused in the UI — **[STATUS.md](./STATUS.md) is authoritative.**

This file previously carried the subtitle "no mocks". That was aspirational: the
app has a demo login path, the store falls back to a JSON file, and WhatsApp
notification is a stub.

## Stack

| Layer | Language / tech | Role |
|-------|-----------------|------|
| **Mobile (Android + iOS)** | **Dart / Flutter** | UI, Dynamic login, local theme; calls backend + Arc RPC |
| **Backend API** | **TypeScript (Node / Hono)** | Secrets, **Circle App Kit**, UCW challenges, Pusher auth, agent payments |
| **Realtime chat** | **Pusher Channels** | Presence + message fan-out (Flutter client + Node auth endpoint) |
| **Chain** | **Solidity (Foundry) on Arc Testnet** | Identity registry, payment escrow / protected sends |
| **Settlement** | **USDC (native + ERC-20) on Arc** domain `26` | Primary cash balance |
| **EUR** | **EURC** `0x89B50855…` | Euro leg; not “native EUR” |
| **Money movement** | **Circle App Kit** (`@circle-fin/app-kit`) | **Send**, **Bridge** (CCTP), **Swap**, **Unified Balance** (Gateway) |
| **Unified USDC** | **App Kit Unified Balance** (Gateway under the hood) | Deposit / spend single chain-agnostic USDC |
| **Bridge** | **App Kit Bridge** → CCTP V2 | USDC cross-chain; the only bridge rail (legacy `/v1/cctp` off unless `APP_KIT_KEEP_LEGACY=true`) |
| **Wallets** | **Dynamic** + **Circle UCW** + App Kit adapters | User PIN (UCW); ops via Circle Wallets / viem |
| **Agent spend** | **Circle agent / nanopayments (x402)** | API wallet, limits, deposit/withdraw |

## Data flow (target)

1. User signs in with **Dynamic** (email OTP) → backend verifies JWT via JWKS.
2. Backend creates/links **Circle user-controlled wallet** on Arc (and deposit addresses on Gateway-supported chains).
3. **Balances**
   - **USDC**: prefer **Gateway unified balance** (query Gateway API + on-chain deposits).
   - **EURC / non-Gateway assets**: hold on **embedded / Circle wallet** on Arc.
4. **Fund**: App Kit `unifiedBalance.deposit` (or legacy Gateway) → single chain-agnostic USDC balance.
5. **Send**: App Kit `send` (same-chain) or UCW transfer / **PaymentEscrow** for unregistered email/phone.
6. **Swap / Bridge**: App Kit only — `swap` (USDC, EURC, cirBTC or a token address on Arc, quoted by `estimateSwap`) and `bridge` (CCTP). No fallback rail. Compose: spend → swap → bridge.
7. **Chat**: Flutter ↔ Pusher; money commands (`@. send`, `@. buy`, `@. bridge`) call App Kit / UCW.
8. **Agent payments**: backend creates spend-limited API wallet; agent uses nanopayment auth against dedicated funds.

## Security rules

- **Dynamic API token**, **Circle API keys**, **Pusher secret**, **deployer private keys** → server `.env` only.
- Mobile may hold: Dynamic **environment ID**, Pusher **key**, public contract addresses, API base URL.
- Never put mock balances in production builds. Demo mode is gated by the
  `AUTO_DEMO` define on the client and needs `ALLOW_HEADER_AUTH=true` on the
  server, since it has no Dynamic JWT. (An older rule here referenced
  `PRIVY_APP_CLIENT_ID`; Privy was replaced by Dynamic.)
- Every `/v1` route derives the caller from a JWKS-verified Dynamic JWT. The
  `x-user-id` header is not an identity claim unless `ALLOW_HEADER_AUTH` is on.

## Contracts (Foundry → Arc Testnet)

| Contract | Purpose |
|----------|---------|
| `IdentityRegistry` | Map phone/email/handle → Arc address |
| `PaymentEscrow` | Protected P2P USDC until claim |
| (optional) `AgentAllowance` | On-chain spend caps if not fully off-chain Circle agent APIs |

Deploy: `contracts/script/deploy-arc.ps1` with `PRIVATE_KEY`.

## Network constants (Arc Testnet)

- Chain ID `5042002`
- RPC `https://rpc.testnet.arc.network`
- Explorer `https://testnet.arcscan.app`
- USDC `0x3600000000000000000000000000000000000000`
- EURC `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
- Gateway Wallet / Minter (testnet shared EVM addresses)
- CCTP domain `26`
