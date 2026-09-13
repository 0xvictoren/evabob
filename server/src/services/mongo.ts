/** MongoDB persistence for application records and distributed coordination. */

import dns from "node:dns";
import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../config.js";
import type { UserRecord } from "../store/db.js";

type WriterLease = {
  _id: "financial-json-writer";
  owner: string;
  expiresAt: Date;
  updatedAt: Date;
};

type UcwSessionFingerprint = {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
};

export type PrimaryStoreDatasets = {
  app: unknown;
  paymentRequests: unknown;
  protectedEscrows: unknown;
};

type PrimaryStoreDocument = {
  _id: "primary";
  schemaVersion: 1;
  checksum: string;
  datasets: PrimaryStoreDatasets;
  updatedAt: Date;
};

/** Some Windows / ISP resolvers refuse Atlas SRV (querySrv ECONNREFUSED). */
function preferPublicDns() {
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
  } catch {
    /* ignore */
  }
}

export type ProtectedEscrowRecord = {
  id: string;
  onChainTransferId?: string;
  fromUserId: string;
  recipientKind: "email" | "phone";
  recipientId: string;
  amountUsdc: number;
  memo?: string;
  status: "pending" | "claimed" | "refunded" | "failed";
  createdAt: string;
  expiresAt: string;
  claimTx?: string;
  refundTx?: string;
  createTx?: string;
};

let client: MongoClient | null = null;
let db: Db | null = null;
let ready = false;

export function mongoConfigured(): boolean {
  return Boolean(config.mongo.uri);
}

export function mongoReady(): boolean {
  return ready && db != null;
}

async function openAndPing(uri: string): Promise<void> {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
    // Atlas often fails behind broken local DNS / TLS middleboxes on Windows
    family: 4,
  });
  await client.connect();
  db = client.db(config.mongo.dbName);
  await db.command({ ping: 1 });
}

/**
 * Convert mongodb+srv:// to a standard multi-host URI when SRV lookup fails.
 * Requires MONGODB_STANDARD_URI env, or we try common Atlas hosts.
 */
function standardUriFallback(srvUri: string): string | null {
  if (process.env.MONGODB_STANDARD_URI?.trim()) {
    return process.env.MONGODB_STANDARD_URI.trim();
  }
  // If already non-SRV, nothing to do
  if (!srvUri.startsWith("mongodb+srv://")) return null;
  return null;
}

export async function connectMongo(): Promise<{ ok: boolean; detail: string }> {
  if (!config.mongo.uri) {
    return { ok: false, detail: "MONGODB_URI not set — using JSON file store" };
  }
  const uri = config.mongo.uri;
  preferPublicDns();
  try {
    try {
      await openAndPing(uri);
    } catch (first) {
      const msg = first instanceof Error ? first.message : String(first);
      // Retry with public DNS when local resolver can't answer MongoDB SRV
      if (/querySrv|ECONNREFUSED|ENOTFOUND|ETIMEOUT|SSL|tls|certificate/i.test(msg)) {
        console.warn("[mongo] first connect failed, retrying with public DNS:", msg);
        preferPublicDns();
        try {
          await (client as MongoClient | null)?.close();
        } catch {
          /* ignore */
        }
        client = null;
        db = null;
        try {
          await openAndPing(uri);
        } catch (second) {
          const alt = standardUriFallback(uri);
          if (alt) {
            console.warn("[mongo] retrying with MONGODB_STANDARD_URI");
            try {
              await (client as MongoClient | null)?.close();
            } catch {
              /* ignore */
            }
            client = null;
            db = null;
            await openAndPing(alt);
          } else {
            throw second;
          }
        }
      } else {
        throw first;
      }
    }
    await users().createIndex({ id: 1 }, { unique: true });
    await users().createIndex({ email: 1 });
    await users().createIndex({ handle: 1 }, { unique: true, sparse: true });
    await users().createIndex({ phone: 1 }, { sparse: true });
    await escrows().createIndex({ status: 1, expiresAt: 1 });
    await escrows().createIndex({ fromUserId: 1 });
    await writerLeases().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await ucwSessions().createIndex({ tokenHash: 1 }, { unique: true });
    await ucwSessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    ready = true;
    console.log(`[mongo] connected db=${config.mongo.dbName}`);
    return { ok: true, detail: `connected ${config.mongo.dbName}` };
  } catch (e) {
    ready = false;
    db = null;
    try {
      await (client as MongoClient | null)?.close();
    } catch {
      /* ignore */
    }
    client = null;
    const detail = e instanceof Error ? e.message : "mongo connect failed";
    console.warn("[mongo]", detail);
    return { ok: false, detail };
  }
}

function users(): Collection<UserRecord & { _id?: unknown }> {
  if (!db) throw new Error("mongo not ready");
  return db.collection("users");
}

function escrows(): Collection<ProtectedEscrowRecord & { _id?: unknown }> {
  if (!db) throw new Error("mongo not ready");
  return db.collection("protected_escrows");
}

function writerLeases(): Collection<WriterLease> {
  if (!db) throw new Error("mongo not ready");
  return db.collection<WriterLease>("writer_leases");
}

function ucwSessions(): Collection<UcwSessionFingerprint> {
  if (!db) throw new Error("mongo not ready");
  return db.collection<UcwSessionFingerprint>("ucw_session_fingerprints");
}

function primaryStore(): Collection<PrimaryStoreDocument> {
  if (!db) throw new Error("mongo not ready");
  return db.collection<PrimaryStoreDocument>("primary_store");
}

export async function mongoLoadPrimaryStore(): Promise<{
  checksum: string;
  datasets: PrimaryStoreDatasets;
} | null> {
  if (!mongoReady()) return null;
  const row = await primaryStore().findOne({ _id: "primary" });
  return row ? { checksum: row.checksum, datasets: row.datasets } : null;
}

/** Atomically replaces the complete state while the writer lease is held. */
export async function mongoSavePrimaryStore(
  datasets: PrimaryStoreDatasets,
  checksum: string,
): Promise<void> {
  if (!mongoReady()) throw new Error("mongo not ready");
  await primaryStore().replaceOne(
    { _id: "primary" },
    {
      schemaVersion: 1,
      checksum,
      datasets,
      updatedAt: new Date(),
    },
    { upsert: true },
  );
}

export async function mongoRememberUcwSession(
  tokenHash: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  if (!mongoReady()) return;
  await ucwSessions().updateOne(
    { tokenHash },
    { $set: { tokenHash, userId, expiresAt } },
    { upsert: true },
  );
}

export async function mongoOwnsUcwSession(
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<boolean> {
  if (!mongoReady()) return false;
  return Boolean(await ucwSessions().findOne({
    tokenHash,
    userId,
    expiresAt: { $gt: now },
  }));
}

export async function mongoAcquireWriterLease(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  if (!mongoReady()) return false;
  const now = new Date();
  try {
    const result = await writerLeases().updateOne(
      {
        _id: "financial-json-writer",
        $or: [{ owner }, { expiresAt: { $lte: now } }],
      },
      {
        $set: {
          owner,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      },
      { upsert: true },
    );
    return result.matchedCount === 1 || result.upsertedCount === 1;
  } catch (error) {
    // An unexpired owner causes the upsert path to collide with the fixed id.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

export async function mongoRenewWriterLease(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  if (!mongoReady()) return false;
  const now = new Date();
  const result = await writerLeases().updateOne(
    { _id: "financial-json-writer", owner },
    { $set: { updatedAt: now, expiresAt: new Date(now.getTime() + ttlMs) } },
  );
  return result.matchedCount === 1;
}

export async function mongoReleaseWriterLease(owner: string): Promise<void> {
  if (!mongoReady()) return;
  await writerLeases().deleteOne({ _id: "financial-json-writer", owner });
}

export async function mongoUpsertUser(user: UserRecord): Promise<UserRecord> {
  if (!mongoReady()) return user;
  const { _id, ...doc } = user as UserRecord & { _id?: unknown };
  try {
    await users().updateOne({ id: user.id }, { $set: doc }, { upsert: true });
  } catch (e) {
    // Unique handle (or email) collision must never take down the API —
    // session sync runs on every balance refresh.
    const code = (e as { code?: number }).code;
    console.warn(
      "[mongo] upsert user failed",
      user.id,
      code ?? (e instanceof Error ? e.message : e),
    );
  }
  return user;
}

export async function mongoGetUser(id: string): Promise<UserRecord | null> {
  if (!mongoReady()) return null;
  const row = await users().findOne({ id });
  if (!row) return null;
  const { _id, ...user } = row;
  return user as UserRecord;
}

export async function mongoFindByEmail(email: string): Promise<UserRecord | null> {
  if (!mongoReady()) return null;
  const row = await users().findOne({ email: email.toLowerCase() });
  if (!row) return null;
  const { _id, ...user } = row;
  return user as UserRecord;
}

export async function mongoFindByHandle(handle: string): Promise<UserRecord | null> {
  if (!mongoReady()) return null;
  const h = handle.replace(/^@/, "").toLowerCase();
  const row = await users().findOne({ handle: h });
  if (!row) return null;
  const { _id, ...user } = row;
  return user as UserRecord;
}

export async function mongoFindByPhone(phone: string): Promise<UserRecord | null> {
  if (!mongoReady()) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  const all = await users().find({ phone: { $exists: true } }).toArray();
  const hit = all.find((u) => {
    const p = (u.phone || "").replace(/\D/g, "");
    return p.length >= 7 && (p === digits || p.endsWith(digits) || digits.endsWith(p));
  });
  if (!hit) return null;
  const { _id, ...user } = hit;
  return user as UserRecord;
}

export async function mongoIsHandleTaken(
  handle: string,
  exceptUserId?: string,
): Promise<boolean> {
  if (!mongoReady()) return false;
  const h = handle.replace(/^@/, "").toLowerCase();
  const row = await users().findOne({
    handle: h,
    ...(exceptUserId ? { id: { $ne: exceptUserId } } : {}),
  });
  return Boolean(row);
}

export async function mongoSaveEscrow(
  row: ProtectedEscrowRecord,
): Promise<void> {
  if (!mongoReady()) return;
  await escrows().updateOne({ id: row.id }, { $set: row }, { upsert: true });
}

export async function mongoListExpiredPending(): Promise<ProtectedEscrowRecord[]> {
  if (!mongoReady()) return [];
  const now = new Date().toISOString();
  const rows = await escrows()
    .find({ status: "pending", expiresAt: { $lte: now } })
    .toArray();
  return rows.map(({ _id, ...r }) => r as ProtectedEscrowRecord);
}

export async function mongoListPendingEscrows(
  userId?: string,
): Promise<ProtectedEscrowRecord[]> {
  if (!mongoReady()) return [];
  const q = userId
    ? { fromUserId: userId, status: "pending" as const }
    : { status: "pending" as const };
  const rows = await escrows().find(q).toArray();
  return rows.map(({ _id, ...r }) => r as ProtectedEscrowRecord);
}

export async function mongoUpdateEscrow(
  id: string,
  patch: Partial<ProtectedEscrowRecord>,
): Promise<void> {
  if (!mongoReady()) return;
  await escrows().updateOne({ id }, { $set: patch });
}
