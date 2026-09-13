import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

async function main() {
  // 1. Create a Wallet Set (container for your DC wallets)
  const walletSetResponse = await client.createWalletSet({
    name: "Ops / Fee / Forwarder Wallet Set",   // any name you like
  });

  const walletSet = walletSetResponse.data?.walletSet;
  if (!walletSet?.id) {
    throw new Error("Wallet set creation failed");
  }

  console.log("Wallet Set ID:", walletSet.id);

  // 2. Create one Developer-Controlled wallet on Arc Testnet
  const walletResponse = await client.createWallets({
    walletSetId: walletSet.id,
    blockchains: ["ARC-TESTNET"],   // change if you need another chain
    count: 1,
    accountType: "EOA",             // or "SCA" if you want smart-contract account
  });

  const wallet = walletResponse.data?.wallets?.[0];
  if (!wallet) {
    throw new Error("Wallet creation failed");
  }

  console.log("\n=== Your Developer-Controlled Wallet ===");
  console.log("Wallet ID     :", wallet.id);
  console.log("Address       :", wallet.address);
  console.log("Blockchain    :", wallet.blockchain);
  console.log("Account Type  :", wallet.accountType);
  console.log("Custody Type  :", wallet.custodyType); // should be DEVELOPER
}

main().catch(console.error);