/** MongoDB persistence for application records and distributed coordination. */

import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { Binary, MongoClient, type Collection, type Db } from "mongodb";
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
  /**
   * App Kit jobs (bridges, swaps, deposits in flight). Optional so a snapshot
   * written before they were included still loads.
   */
  appKitJobs?: unknown;
  /** Devices registered for push notifications. Optional for the same reason. */
  pushDevices?: unknown;
  /** Gateway payments and top-ups in flight. Optional for the same reason. */
  gatewayTracker?: unknown;
  /** Sellers' hold-until-delivered links. Optional for the same reason. */
  holdLinks?: unknown;
  /** Money circles and group pots. Optional for the same reason. */
  groupMoney?: unknown;
  /** Agent payment evidence bundles. Optional for the same reason. */
  agentEvidence?: unknown;
  /** Paywalls that charge software for access, and their sales. */
  paywalls?: unknown;
  /** Tasks agents hire people for. Optional for the same reason. */
  agentTasks?: unknown;
};

/**
 * The head of the primary store.
 *
 * Schema 1 kept every dataset inline in this one document, which is capped
 * at 16 MB by MongoDB — the whole app's state had to fit in it. Schema 2
 * keeps the serialized state in chunk documents and makes this document a
 * small pointer to the current set, with a generation number:
 *
 *   - no single document approaches the 16 MB cap, however large the state;
 *   - switching to a new snapshot is one atomic update of this document, so a
 *     reader sees the old snapshot or the new one, never half of each;
 *   - the update only succeeds if the generation is still the one the writer
 *     loaded, so two server instances cannot silently overwrite each other.
 */
type PrimaryStoreDocument = {
  _id: "primary";
  schemaVersion: 1 | 2;
  checksum: string;
  /** Schema 1 only. */
  datasets?: PrimaryStoreDatasets;
  /** Schema 2: increments on every successful save. */
  generation?: number;
  /** Schema 2: chunk ids of the current snapshot, in order. */
  chunkIds?: string[];
  bytes?: number;
  updatedAt: Date;
};

type PrimaryStoreChunk = {
  _id: string;
  generation: number;
  index: number;
  data: string;
};

/** Another instance saved first; this one must reload before writing. */
export class PrimaryStoreConflict extends Error {}

/**
 * Characters per chunk. UTF-8 needs at most 3 bytes for any character in a
 * JS string's basic plane (4 for a surrogate pair, which is two characters),
 * so 3 million characters stays well under the 16 MB document cap.
 */
const PRIMARY_CHUNK_CHARS = 3_000_000;

/**
 * Below this size the head also carries the snapshot inline, as schema 1 did.
 * That keeps a server still running the previous release able to read the
 * store while a new one writes it — during a rolling deploy, a rollback, or a
 * developer's local server sharing the database — and leaves the head well
 * under the 16 MB cap. Above it, only the chunks hold the data.
 */
const INLINE_COPY_MAX_BYTES = 12 * 1024 * 1024;

/** Some Windows / ISP resolvers refuse Atlas SRV (querySrv ECONNREFUSED). */
function preferPublicDns() {
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
  } catch {
    /* ignore */
  }
}

/**
 * Why money is being held. Decides what releases it:
 *   claim_link  — the recipient signs up and proves the email it was sent to
 *   job         — the worker marks delivered and the payer confirms, or 7 days
 *                 pass without an objection
 *   cooling_off — a first payment to someone new, released after a short
 *                 window unless the sender cancels
 */
export type HeldPurpose = "claim_link" | "job" | "cooling_off";

/** A payer's cancellation after delivery, waiting for a person to decide. */
export type HeldReview = {
  status: "under_review" | "released_to_worker" | "refunded_to_payer";
  openedAt: string;
  /** Why the payer no longer needs the job — the reconciliation form. */
  reason: string;
  details: string;
  payerLinks?: string[];
  workerStatement?: string;
  workerLinks?: string[];
  workerRespondedAt?: string;
  decidedAt?: string;
  /** Operator user id who decided. Never shown to the parties. */
  decidedBy?: string;
  decisionNote?: string;
  /**
   * The conversation while the review is open: both people and the reviewer,
   * each message with its own evidence. The reviewer is never named.
   */
  messages?: ReviewMessage[];
};

export type ReviewMessage = {
  id: string;
  from: "payer" | "worker" | "reviewer";
  text: string;
  links: string[];
  /** Evidence photos, as /uploads/evidence_… paths. */
  photos: string[];
  at: string;
};

export type ProtectedEscrowRecord = {
  id: string;
  onChainTransferId?: string;
  /**
   * The escrow contract that holds this transfer. Transfer ids restart at 1
   * on every deployment, so an id alone is ambiguous; a record without this
   * predates PaymentEscrowV3 and is never acted on against the current one.
   */
  contractAddress?: string;
  purpose?: HeldPurpose;
  /** Paid through a seller's hold link (services/holdLinks.ts). */
  holdLinkId?: string;
  /**
   * Set when an agent wallet funded the hold (services/agentTasks.ts). The
   * owner is `fromUserId` and answers for it; the money came from, and goes
   * back to, the agent's own wallet.
   */
  payerAgentId?: string;
  agentTaskId?: string;
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
  /** How the money left the hold, for receipts and the activity row. */
  settledBy?:
    | "payer_confirmed"
    | "auto_release"
    | "cooling_off_elapsed"
    | "claimed_on_signup"
    | "payer_cancelled"
    | "worker_refunded"
    | "review_released"
    | "review_refunded"
    | "expired";
  settledAt?: string;

  // --- job ---
  deliveredAt?: string;
  deliveryNote?: string;
  deliveryLinks?: string[];
  /** When silence releases the money to the worker. */
  autoReleaseAt?: string;
  /** The one-day reminder has been sent to the payer. */
  reminderSentAt?: string;
  /** The "expires in a week, nothing delivered" nudge has been sent. */
  expiryNudgeSentAt?: string;
  review?: HeldReview;

  // --- cooling_off ---
  /** End of the window in which the sender may cancel. */
  releaseAt?: string;

  /** Last error from an automatic release, so it is visible, not silent. */
  lastAutoError?: string;
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

export async function disconnectMongo(): Promise<void> {
  ready = false;
  db = null;
  await client?.close();
  client = null;
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

type AvatarDocument = {
  _id: string;
  mime: string;
  data: Binary;
  updatedAt: Date;
};

function avatars(): Collection<AvatarDocument> {
  if (!db) throw new Error("mongo not ready");
  return db.collection<AvatarDocument>("avatars");
}

/**
 * Profile photos live in Mongo, not on the API's disk. A serverless host gives
 * every instance its own throwaway disk, so a photo written by one was missing
 * on the next; they are capped at 256 KB, well within a document.
 */
export async function mongoSaveAvatar(
  filename: string,
  mime: string,
  bytes: Buffer,
): Promise<void> {
  if (!mongoReady()) throw new Error("mongo not ready");
  await avatars().updateOne(
    { _id: filename },
    { $set: { mime, data: new Binary(bytes), updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function mongoLoadAvatar(
  filename: string,
): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!mongoReady()) return null;
  const row = await avatars().findOne({ _id: filename });
  return row ? { mime: row.mime, bytes: Buffer.from(row.data.buffer) } : null;
}

function primaryChunks(): Collection<PrimaryStoreChunk> {
  if (!db) throw new Error("mongo not ready");
  return db.collection<PrimaryStoreChunk>("primary_store_chunks");
}

/** Splits serialized state into chunk-sized strings. Exported for tests. */
export function splitIntoChunks(text: string, size = PRIMARY_CHUNK_CHARS): string[] {
  if (text.length === 0) return [""];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    // Never split a surrogate pair across two documents.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** The current generation, or null when nothing has been saved yet. Cheap. */
export async function mongoPrimaryStoreGeneration(): Promise<number | null> {
  if (!mongoReady()) return null;
  const head = await primaryStore().findOne(
    { _id: "primary" },
    { projection: { generation: 1 } },
  );
  return head ? (head.generation ?? 0) : null;
}

export async function mongoLoadPrimaryStore(): Promise<{
  checksum: string;
  datasets: PrimaryStoreDatasets;
  generation: number;
} | null> {
  if (!mongoReady()) return null;
  const head = await primaryStore().findOne({ _id: "primary" });
  if (!head) return null;
  if (head.chunkIds && head.chunkIds.length > 0) {
    const rows = await primaryChunks()
      .find({ _id: { $in: head.chunkIds } })
      .toArray();
    const byId = new Map(rows.map((r) => [r._id, r.data]));
    const parts = head.chunkIds.map((id) => byId.get(id));
    if (parts.some((p) => p == null)) {
      throw new Error("Mongo primary store is missing a chunk of the current snapshot");
    }
    return {
      checksum: head.checksum,
      datasets: JSON.parse(parts.join("")) as PrimaryStoreDatasets,
      generation: head.generation ?? 0,
    };
  }
  if (!head.datasets) throw new Error("Mongo primary store head has no data");
  return { checksum: head.checksum, datasets: head.datasets, generation: head.generation ?? 0 };
}

/**
 * Saves a complete snapshot as the next generation.
 *
 * `expectedGeneration` is the generation this process loaded (null when the
 * store was empty). The chunks are written first under ids nobody reads yet;
 * then the head is switched to them only if it is still at the expected
 * generation. If another instance saved in between, nothing becomes current,
 * the orphaned chunks are removed, and PrimaryStoreConflict is thrown so the
 * caller reloads instead of overwriting someone else's change.
 */
export async function mongoSavePrimaryStore(
  datasets: PrimaryStoreDatasets,
  checksum: string,
  expectedGeneration: number | null,
): Promise<number> {
  if (!mongoReady()) throw new Error("mongo not ready");
  const text = JSON.stringify(datasets);
  const next = (expectedGeneration ?? 0) + 1;
  const tag = randomUUID().slice(0, 8);
  const parts = splitIntoChunks(text);
  const chunkIds = parts.map((_, i) => `${next}:${tag}:${i}`);
  await primaryChunks().insertMany(
    parts.map((data, index) => ({ _id: chunkIds[index]!, generation: next, index, data })),
  );

  const inline = Buffer.byteLength(text, "utf8") <= INLINE_COPY_MAX_BYTES;
  const head = {
    schemaVersion: 2 as const,
    checksum,
    generation: next,
    chunkIds,
    bytes: text.length,
    updatedAt: new Date(),
    ...(inline ? { datasets } : {}),
  };
  let switched = false;
  try {
    if (expectedGeneration == null) {
      await primaryStore().insertOne({ _id: "primary", ...head });
      switched = true;
    } else {
      const res = await primaryStore().updateOne(
        expectedGeneration === 0
          ? { _id: "primary", $or: [{ generation: { $exists: false } }, { generation: 0 }] }
          : { _id: "primary", generation: expectedGeneration },
        inline ? { $set: head } : { $set: head, $unset: { datasets: "" } },
      );
      switched = res.matchedCount === 1;
    }
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) {
      await primaryChunks().deleteMany({ _id: { $in: chunkIds } }).catch(() => undefined);
      throw error;
    }
  }
  if (!switched) {
    await primaryChunks().deleteMany({ _id: { $in: chunkIds } }).catch(() => undefined);
    throw new PrimaryStoreConflict(
      "Another server instance saved first; reload before writing",
    );
  }
  // Keep the previous generation for a reader that fetched the old head a
  // moment ago; anything older is no longer reachable.
  await primaryChunks()
    .deleteMany({ generation: { $lt: next - 1 } })
    .catch(() => undefined);
  return next;
}

/**
 * Deletes every snapshot chunk except those referenced by the current head.
 * Used after secret remediation so the normally retained previous generation
 * cannot preserve a revoked plaintext credential.
 */
export async function mongoPurgePrimaryStoreHistory(): Promise<number> {
  if (!mongoReady()) return 0;
  const head = await primaryStore().findOne({ _id: "primary" });
  const keep = head?.chunkIds ?? [];
  const result = keep.length
    ? await primaryChunks().deleteMany({ _id: { $nin: keep } })
    : await primaryChunks().deleteMany({});
  return result.deletedCount;
}

/** Old Circle user-token fingerprints must not survive an HTTP incident. */
export async function mongoForgetAllUcwSessions(): Promise<number> {
  if (!mongoReady()) return 0;
  const result = await ucwSessions().deleteMany({});
  return result.deletedCount;
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
