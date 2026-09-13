# Evabob Contracts (Arc Testnet)

## Contracts

| Contract | Role |
|----------|------|
| `IdentityRegistryV2` | Hash(phone/email/handle) → smart account; separate Safe admin and hot linker |
| `PaymentEscrowV2` | Identity-bound protected transfer hold, claim, and refund |

USDC (ERC-20, 6 decimals): `0x3600000000000000000000000000000000000000`  
Chain ID: `5042002` · RPC: `https://rpc.testnet.arc.network`

## Build

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
cd contracts
forge build
```

`forge-std` is vendored under `lib/forge-std`.

## Deploy role-separated contracts to Arc Testnet

1. Choose three Safe owner addresses and separate ops, linker, and attestor EOAs.
2. Fund the deployer with Arc Testnet USDC: https://faucet.circle.com
3. Set the required variables and deploy:

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
$env:PRIVATE_KEY = "0xYOUR_KEY"
$env:SAFE_OWNER_1 = "0x..."
$env:SAFE_OWNER_2 = "0x..."
$env:SAFE_OWNER_3 = "0x..."
$env:IDENTITY_LINKER_ADDRESS = "0x..."
$env:ESCROW_ATTESTOR_ADDRESS = "0x..."
$env:SAFE_SALT_NONCE = "1"
cd contracts
forge script script/DeployRoleSeparated.s.sol:DeployRoleSeparated `
  --rpc-url https://rpc.testnet.arc.network --broadcast --slow
```

4. Verify owners, threshold, linker, attestor, and both admin roles before
   changing the server configuration. The current deployment is recorded in
   `deployments/arc-testnet.json`.

## UI language

On-chain “escrow” = product **protected transfer**. Never surface contract names in the app.
