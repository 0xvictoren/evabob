import { config as loadEnv } from "dotenv";

loadEnv();

const required = [
  "MONGODB_URI",
  "DYNAMIC_ENVIRONMENT_ID",
  "DYNAMIC_API_TOKEN",
  "CIRCLE_WALLETS_APP_ID",
  "CIRCLE_API_KEY",
  "CIRCLE_ENTITY_SECRET",
  "PRIVATE_KEY",
  "IDENTITY_LINKER_PRIVATE_KEY",
  "ESCROW_ATTESTOR_PRIVATE_KEY",
];

const recommended = [
  "OPERATOR_USER_IDS",
  "APP_KIT_DC_WALLET",
  "KIT_KEY",
  "GROQ_API_KEY",
  "EXCHANGE_RATE_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
];

const value = (name) => process.env[name]?.trim() ?? "";
const missing = required.filter((name) => !value(name));
const missingRecommended = recommended.filter((name) => !value(name));
const errors = [];

if (value("MONGODB_URI") && !/^mongodb(?:\+srv)?:\/\//.test(value("MONGODB_URI"))) {
  errors.push("MONGODB_URI is not a MongoDB connection URI");
}

const signerNames = [
  "PRIVATE_KEY",
  "IDENTITY_LINKER_PRIVATE_KEY",
  "ESCROW_ATTESTOR_PRIVATE_KEY",
];
const signers = signerNames.map((name) => value(name));
for (const [index, signer] of signers.entries()) {
  if (signer && !/^(?:0x)?[0-9a-fA-F]{64}$/.test(signer)) {
    errors.push(`${signerNames[index]} must be a 32-byte hex private key`);
  }
}
if (signers.every(Boolean) && new Set(signers.map((key) => key.toLowerCase().replace(/^0x/, ""))).size !== signers.length) {
  errors.push("The three hosted signer keys must be distinct");
}

if (missing.length || errors.length) {
  console.error("Render environment is not ready.");
  if (missing.length) console.error(`Missing required names: ${missing.join(", ")}`);
  for (const error of errors) console.error(`Invalid: ${error}`);
  process.exitCode = 1;
} else {
  console.log("All required Render secret names are present and structurally valid.");
}

if (missingRecommended.length) {
  console.log(`Still recommended before live flow testing: ${missingRecommended.join(", ")}`);
}

console.log("No secret values were printed.");
