import { config } from "dotenv";
import dns from "dns";
import { resolve } from "path";
import { MongoClient } from "mongodb";
import { existsSync } from "fs";

// Load server/.env or monorepo root .env
for (const p of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
]) {
  if (existsSync(p)) {
    config({ path: p });
    break;
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}

const safe = uri.replace(/:([^@/]+)@/, ":***@");
console.log("Connecting:", safe);

async function tryConnect(label) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 25000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "evabob");
    await db.command({ ping: 1 });
    console.log("OK ping database=", db.databaseName, `(${label})`);
    await db.collection("users").createIndex({ id: 1 }, { unique: true });
    await db
      .collection("users")
      .createIndex({ handle: 1 }, { unique: true, sparse: true });
    await db.collection("users").createIndex({ email: 1 });
    await db
      .collection("protected_escrows")
      .createIndex({ status: 1, expiresAt: 1 });
    console.log("indexes ready");
    await client.close();
    return true;
  } catch (e) {
    console.error(`FAIL (${label}):`, e instanceof Error ? e.message : e);
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return false;
  }
}

if (await tryConnect("default DNS")) {
  process.exit(0);
}

// Common on Windows: local resolver refuses MongoDB SRV
console.log("Retrying with public DNS (8.8.8.8 / 1.1.1.1)…");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
if (await tryConnect("public DNS")) {
  process.exit(0);
}

console.error(`
Could not connect to Atlas. Checklist:
1. Atlas → Network Access → allow your IP (or 0.0.0.0/0 for dev)
2. Atlas → Database Access → user/password match the URI
3. Atlas → Connect → Drivers → copy the full mongodb+srv:// string
4. URL-encode special chars in the password (@ # : / % etc.)
`);
process.exit(1);
