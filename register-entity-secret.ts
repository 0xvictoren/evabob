import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const envFilePath = ".env";
const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  throw new Error("CIRCLE_API_KEY is required. Set it in .env first.");
}

const existingEnv = existsSync(envFilePath) ? readFileSync(envFilePath, "utf8") : "";
if (/^CIRCLE_ENTITY_SECRET=/m.test(existingEnv)) {
  console.log("ℹ️  CIRCLE_ENTITY_SECRET already exists in .env. Nothing to register.");
  process.exit(0);
}

const entitySecret = randomBytes(32).toString("hex");
const recoveryFilePath = "./recovery";

mkdirSync(recoveryFilePath, { recursive: true });

try {
  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryFilePath,
  });
} catch (error: any) {
  const message = error?.message ?? "";
  const status = error?.status ?? error?.response?.status;
  const code = error?.code;

  if (status === 409 || code === 156015 || /already been set/i.test(message)) {
    console.log("⚠️  This Circle entity already has an entity secret configured.");
    console.log("No new secret was registered. If you need the existing secret, recover it from the Circle dashboard or a prior backup.");
    process.exit(0);
  }

  throw error;
}

appendFileSync(envFilePath, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

console.log("✅ Entity secret registered successfully!");
console.log(`Recovery file saved in: ${recoveryFilePath}`);
console.log("CIRCLE_ENTITY_SECRET has been added to your .env");