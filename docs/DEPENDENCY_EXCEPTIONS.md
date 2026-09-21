# Production dependency exceptions

Owner: Wallet platform and security
Review deadline: 31 December 2026

`npm audit --omit=dev` currently reports advisories only through Circle's
supported App Kit, Circle Wallets and viem adapters. The affected transitive
packages implement Solana/Anchor or legacy ethers parsing paths; Evabob limits
the product to Arc Testnet, Ethereum Sepolia and Base Sepolia and does not
accept attacker-supplied TOML or Solana RPC structures. The adapters themselves
are used by send, swap, bridge, Gateway and developer-controlled wallet flows,
so deleting or force-downgrading them would break supported Circle flows.

The exception is narrow and temporary:

- `npm run security:audit` fails on any new package, any critical advisory, or
  after the review deadline.
- The root web production graph currently has no npm advisories.
- Circle-supported upgrades must be tested as they are published. Do not use
  `npm audit fix --force` to install an incompatible App Kit version.
- Product chain validation rejects every chain except Arc Testnet, Ethereum
  Sepolia and Base Sepolia.

The exception does not assert that the packages are safe in every context. It
records why the vulnerable paths are not currently reachable and who must
remove the exception.
