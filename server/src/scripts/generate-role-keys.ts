import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const path = resolve(process.cwd(), "data", "role-separation-secrets.json");
if (existsSync(path)) {
  throw new Error("Role-separation secrets already exist; refusing to overwrite them.");
}

const make = () => {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
};

const roles = {
  generatedAt: new Date().toISOString(),
  ops: make(),
  identityLinker: make(),
  escrowAttestor: make(),
};

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(roles, null, 2)}\n`, { mode: 0o600 });

// Private keys are deliberately never written to stdout or shell history.
console.log(JSON.stringify({
  secretFile: path,
  ops: roles.ops.address,
  identityLinker: roles.identityLinker.address,
  escrowAttestor: roles.escrowAttestor.address,
}, null, 2));
