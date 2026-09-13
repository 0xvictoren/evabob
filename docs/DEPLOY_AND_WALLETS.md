# Deploy contracts + Circle user-controlled wallets

## 1. Fix `PRIVATE_KEY` (required for deploy)

Your current `.env` `PRIVATE_KEY` is **not** a valid EOA key (non-hex / wrong length).

A valid key is:

```text
PRIVATE_KEY=0x + exactly 64 hexadecimal characters
```

### Create and fund a deploy key

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
cast wallet new
# Copy Address + Private key
```

1. Put only the private key in monorepo `.env` as `PRIVATE_KEY=0x...`
2. Fund the **address** on Arc Testnet: https://faucet.circle.com → network **Arc Testnet** → USDC  
3. Deploy:

```powershell
cd C:\Users\victoren\Desktop\Projects\evabob\contracts
.\script\deploy-and-save.ps1
```

This writes `contracts/deployments/arc-testnet.json` and prints:

```text
IDENTITY_REGISTRY=0x...
PAYMENT_ESCROW=0x...
```

Add those lines to `.env`, restart the API.

---

## 2. Circle user-controlled wallets (wired)

### Backend (`@circle-fin/user-controlled-wallets`)

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/circle/config` | App ID + status |
| `POST /v1/circle/create-user` | Create Circle user |
| `POST /v1/circle/session` | `userToken` + `encryptionKey` |
| `POST /v1/circle/initialize` | PIN+wallet challenge on **ARC-TESTNET** SCA (or list if already init) |
| `POST /v1/circle/wallets` | List wallets, bind address to user |
| `POST /v1/circle/balances` | Token balances |
| `POST /v1/circle/transfer` | Create transfer challenge |
| `GET /challenge` | WebView host page for Circle Web SDK PIN UI |

Env:

```text
CIRCLE_API_KEY=TEST_API_KEY:...
CIRCLE_WALLETS_APP_ID=9aed57be-b4be-52a2-a9ce-610af36e6055
```

### Mobile (Flutter)

1. Profile → **Circle wallet (PIN)**
2. Server creates session + challenge
3. WebView opens `/challenge?...` → Circle PIN UI
4. On success, address is bound and balances refresh

---

## 3. Run stack

```powershell
# Terminal 1
cd C:\Users\victoren\Desktop\Projects\evabob\server
npm run dev

# Terminal 2
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
flutter run -d emulator-5554
```
