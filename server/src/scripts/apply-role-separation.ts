import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Role = { address: Address; privateKey: Hex };
type RoleSecrets = {
  ops: Role;
  identityLinker: Role;
  escrowAttestor: Role;
};

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function checkedAddress(name: string): Address {
  const value = argument(name);
  if (!isAddress(value)) throw new Error(`Invalid --${name} address`);
  return getAddress(value);
}

function verifyRole(name: string, role: Role): void {
  if (!isAddress(role.address) || !/^0x[0-9a-fA-F]{64}$/.test(role.privateKey)) {
    throw new Error(`Invalid ${name} secret record`);
  }
  const derived = privateKeyToAccount(role.privateKey).address;
  if (derived.toLowerCase() !== role.address.toLowerCase()) {
    throw new Error(`${name} private key does not match its stored address`);
  }
}

function setEnv(source: string, name: string, value: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

const serverRoot = resolve(process.cwd());
const envPath = resolve(serverRoot, ".env");
const secretPath = resolve(serverRoot, "data", "role-separation-secrets.json");
const backupPath = resolve(serverRoot, "data", "pre-role-separation.env");
const temporaryPath = resolve(serverRoot, ".env.role-separation.tmp");

if (!existsSync(envPath)) throw new Error("server/.env does not exist");
if (!existsSync(secretPath)) throw new Error("Role-separation secret file does not exist");
if (existsSync(backupPath)) {
  throw new Error("Pre-rotation environment backup already exists; refusing to overwrite it");
}

const roles = JSON.parse(readFileSync(secretPath, "utf8")) as RoleSecrets;
verifyRole("ops", roles.ops);
verifyRole("identityLinker", roles.identityLinker);
verifyRole("escrowAttestor", roles.escrowAttestor);

const distinct = new Set([
  roles.ops.address.toLowerCase(),
  roles.identityLinker.address.toLowerCase(),
  roles.escrowAttestor.address.toLowerCase(),
]);
if (distinct.size !== 3) throw new Error("All three hot roles must use different wallets");

const safe = checkedAddress("safe");
const registry = checkedAddress("registry");
const escrow = checkedAddress("escrow");

copyFileSync(envPath, backupPath);
chmodSync(backupPath, 0o600);

let next = readFileSync(envPath, "utf8");
next = setEnv(next, "PRIVATE_KEY", roles.ops.privateKey);
next = setEnv(next, "IDENTITY_LINKER_PRIVATE_KEY", roles.identityLinker.privateKey);
next = setEnv(next, "ESCROW_ATTESTOR_PRIVATE_KEY", roles.escrowAttestor.privateKey);
next = setEnv(next, "ADMIN_SAFE_ADDRESS", safe);
next = setEnv(next, "IDENTITY_REGISTRY", registry);
next = setEnv(next, "PAYMENT_ESCROW", escrow);

writeFileSync(temporaryPath, next, { mode: 0o600 });
renameSync(temporaryPath, envPath);
chmodSync(envPath, 0o600);

// Deliberately print only public addresses and paths.
console.log(JSON.stringify({
  updated: envPath,
  backup: backupPath,
  safe,
  registry,
  escrow,
  ops: roles.ops.address,
  identityLinker: roles.identityLinker.address,
  escrowAttestor: roles.escrowAttestor.address,
}, null, 2));
