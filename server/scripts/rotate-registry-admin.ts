/**
 * Hands IdentityRegistry admin to a new address.
 *
 * This is the one rotation with no undo. `setAdmin` is onlyAdmin, so once the
 * old key has handed over, only the new key can ever move it again — point it
 * somewhere you cannot sign for and the registry is frozen: no identity can be
 * linked, unlinked or corrected, ever. That is why this refuses to run on
 * anything it cannot sanity-check, and why the confirmation is explicit rather
 * than a prompt someone can hold enter through.
 *
 * Why the role matters more than it used to: PaymentEscrowV2 pays whoever the
 * registry resolves a recipient key to, so whoever holds registry admin can
 * bind any email to their own wallet and claim every held payment addressed to
 * it. Before V2 the attestor was the dangerous key; now it is this one.
 *
 * The new admin has to stay online and funded — `adminLink` is called on every
 * signup, and Arc charges gas in USDC. A cold key here would break signups.
 *
 *   npx tsx scripts/rotate-registry-admin.ts 0xNEW…            # dry run
 *   CONFIRM_ROTATE=yes npx tsx scripts/rotate-registry-admin.ts 0xNEW…
 */

import { formatUnits, type Address } from "viem";
import { config } from "../src/config.js";
import {
  arcTestnet,
  getIdentityAdminAccount,
  getIdentityAdminWalletClient,
  getPublicClient,
} from "../src/services/arc-wallet.js";

const registryAbi = [
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setAdmin",
    stateMutability: "nonpayable",
    inputs: [{ name: "newAdmin", type: "address" }],
    outputs: [],
  },
] as const;

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

function fail(message: string): never {
  console.error(`\n  REFUSING: ${message}\n`);
  process.exit(1);
}

const next = (process.argv[2] || "").trim() as Address;
if (!/^0x[a-fA-F0-9]{40}$/.test(next)) {
  fail("pass the new admin address as the first argument");
}

const registry = config.arc.identityRegistry as Address;
if (!registry) fail("IDENTITY_REGISTRY is not configured");

const client = getPublicClient();
const current = (await client.readContract({
  address: registry,
  abi: registryAbi,
  functionName: "admin",
})) as Address;

const signer = getIdentityAdminAccount();

console.log("IdentityRegistry :", registry);
console.log("current admin    :", current);
console.log("signing as       :", signer.address);
console.log("new admin        :", next);

if (current.toLowerCase() !== signer.address.toLowerCase()) {
  fail(
    `the configured key (${signer.address}) is not the current admin — it cannot hand over`,
  );
}
if (next.toLowerCase() === current.toLowerCase()) {
  fail("the new admin is the current admin; nothing to do");
}

// An address with contract code is almost certainly a mistake here: a contract
// cannot sign transactions, so admin would be unusable and unrecoverable.
const code = await client.getBytecode({ address: next });
if (code && code !== "0x") {
  fail(
    "the new admin has contract code — a contract cannot sign, so admin would be frozen",
  );
}

// adminLink runs on every signup and Arc charges gas in USDC, so an unfunded
// admin means identity linking silently stops working right after handover.
const balance = (await client.readContract({
  address: config.arc.usdc,
  abi: erc20BalanceAbi,
  functionName: "balanceOf",
  args: [next],
})) as bigint;
const usdc = Number(formatUnits(balance, 6));
console.log("new admin USDC   :", usdc, "(gas on Arc is paid in USDC)");
if (usdc < 1) {
  console.warn(
    "\n  WARNING: under 1 USDC. adminLink runs on every signup, so fund this\n" +
      "  address before or immediately after handing over, or identity linking\n" +
      "  will start failing.",
  );
}

await client.simulateContract({
  address: registry,
  abi: registryAbi,
  functionName: "setAdmin",
  args: [next],
  account: signer,
});
console.log("\nsimulation: ok");

if (process.env.CONFIRM_ROTATE !== "yes") {
  console.log(
    "\nDry run only. Nothing was sent.\n" +
      "To go ahead, re-run with CONFIRM_ROTATE=yes — and make sure the private\n" +
      "key for the new admin is backed up somewhere you can reach, because this\n" +
      "cannot be undone from the old key.",
  );
  process.exit(0);
}

const wallet = getIdentityAdminWalletClient();
const hash = await wallet.writeContract({
  address: registry,
  abi: registryAbi,
  functionName: "setAdmin",
  args: [next],
  account: signer,
  chain: arcTestnet,
});
console.log("sent:", hash);
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log("status:", receipt.status);

const after = (await client.readContract({
  address: registry,
  abi: registryAbi,
  functionName: "admin",
})) as Address;
console.log("admin now        :", after);
if (after.toLowerCase() !== next.toLowerCase()) {
  fail("handover did not take effect — check the transaction");
}
console.log(
  "\nDone. Put the new key in server/.env as IDENTITY_ADMIN_PRIVATE_KEY and\n" +
    "restart, or identity linking will keep signing with the old key and fail.",
);
