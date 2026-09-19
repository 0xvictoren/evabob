import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dirname } from "node:path";
import { validateHandle } from "../utils/handles.js";
import { dataPath } from "../utils/data-path.js";
import {
  markPrimaryStoreDirty,
  registerPrimaryStoreReloader,
} from "../services/primary-store.js";

export type UserRecord = {
  id: string;
  email: string;
  /** Public @handle used for sends (unique, case-insensitive). */
  handle?: string;
  displayName: string;
  phone?: string;
  /**
   * When set, phone is permanently linked to this email/wallet and cannot change.
   * ISO timestamp of successful email-code verification.
   */
  phoneLinkedAt?: string | null;
  evmAddress: string;
  solanaAddress?: string;
  starknetAddress?: string;
  stellarAddress?: string;
  injectiveAddress?: string;
  /** Data URL or path for profile photo (optional). */
  avatarUrl?: string;
  /**
   * One of the app's built-in pictures, when the person chose one instead of
   * uploading a photo. Kept here so everyone they chat with sees it too — it
   * used to live only on their own phone.
   */
  avatarBundleIndex?: number | null;
  /** ISO time of last handle change (null/undefined = never changed after signup default). */
  handleChangedAt?: string | null;
  /** Number of successful handle changes after the free first edit. */
  handleChangeCount?: number;
  /**
   * New accounts use null until wallet + preferred-handle onboarding finishes.
   * Undefined is deliberately treated as complete for records created before
   * the onboarding gate was introduced.
   */
  onboardingCompletedAt?: string | null;
  /** ISO time of last display-name change. */
  displayNameChangedAt?: string | null;
  /**
   * Highest Arc block already scanned for inbound transfers to this wallet.
   * Absent means the wallet has never been scanned, and scanning starts from
   * a recent window rather than genesis.
   */
  inboundScannedBlock?: number;
  /** The same, for the other networks the wallet exists on, by chain id. */
  inboundScannedBlocks?: Record<string, number>;
  /** One-time look back for native Arc sends missed before they were watched. */
  inboundNativeBackfill?: { next: string; floor: string; done: boolean };
  /**
   * Payments to contacts marked as family above this many dollars need a code
   * from the account email first (services/familyCheck.ts). Unset: the default.
   */
  familyCheckAbove?: number;
  createdAt: string;
};

export const HANDLE_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000; // 2 months
export const DISPLAY_NAME_COOLDOWN_MS = 49 * 24 * 60 * 60 * 1000; // 7 weeks

export type ActivityItem = {
  settlementVerified?: boolean;
  id: string;
  userId: string;
  kind:
    | "send"
    | "receive"
    | "exchange"
    | "fund"
    | "withdraw"
    | "agent"
    | "system"
    | "bridge"
    | "escrow";
  title: string;
  description: string;
  amountUsdc: number;
  amountNgnHint?: number;
  counterparty?: string;
  txHash?: string;
  /** instant | escrow | refunded | claimed | direct */
  mode?: string;
  /** Receipt fields for end-user shareable receipts */
  sender?: string;
  receiver?: string;
  /** USDC | EURC | … */
  token?: string;
  /** Absolute token amount (always positive); amountUsdc keeps signed USDC ledger. */
  amountToken?: number;
  /** Evabob platform fee charged on top of amountToken, in platformFeeToken. */
  platformFee?: number;
  platformFeeToken?: string;
  /** Note the sender attached. Shown on both receipts; kept apart from description. */
  memo?: string;
  /** keccak256 id of this row's Memo event (services/memo.ts memoIdFor). */
  memoId?: string;
  /** True when the memo was written on chain with the payment, not just stored. */
  memoOnchain?: boolean;
  /** Shared by every row of one multi-recipient payment (one transaction). */
  batchId?: string;
  /**
   * Receipt lifecycle: `completed` and `pending` appear in history so the
   * user can resume an unfinished bridge/swap. Cancelled stays hidden.
   */
  status?: "pending" | "completed" | "failed" | "cancelled";
  /** App Kit UCW job id — used to Continue an incomplete bridge/swap. */
  jobId?: string;
  /**
   * Position of the Transfer event within its transaction, for rows created
   * by inbound scanning. One transaction can carry several transfers to the
   * same wallet, so the hash alone does not identify a credit.
   */
  logIndex?: number;
  /**
   * Set when the payer shares this payment. The only way anyone outside the
   * payer's account can see it (services/publicReceipts.ts).
   */
  publicId?: string;
  createdAt: string;
};

export type ChatThread = {
  id: string;
  members: string[]; // user ids or handles
  title: string;
  subtitle: string;
  handle?: string;
  /** Pinned system agent conversation. */
  kind?: "agent" | "dm";
  /** Last incomplete agent money intent (follow-up answers merge into this). */
  pendingIntent?: Record<string, unknown> | null;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  threadId: string;
  senderId: string;
  kind: "text" | "receipt" | "system";
  text: string;
  meta?: Record<string, unknown>;
  createdAt: string;
};

export type TransferRecord = {
  id: string;
  fromUserId: string;
  toHandle: string;
  amountUsdc: number;
  amountNgn: number;
  memo?: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
};

export type AgentWallet = {
  withdrawal?: { key: string; amount: number; to: string; status: "reserved" | "complete"; txHash?: string; transferId?: string; rail?: "gateway" | "legacy" };
  /** Every idempotency key is retained so an old completed key cannot be replayed. */
  withdrawalHistory?: Array<{ key: string; amount: number; to: string; status: "reserved" | "complete"; txHash?: string; transferId?: string; rail?: "gateway" | "legacy" }>;
  id: string;
  userId: string;
  label: string;
  balanceUsdc: number;
  dailyLimitUsdc: number;
  spentTodayUsdc: number;
  /** UTC day key for spentTodayUsdc reset (YYYY-MM-DD). */
  spentDay?: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  /**
   * @deprecated Never written for new agents. Older rows may still hold a
   * readable key from when reveal-key existed; `rotateAgentKey` deletes it.
   * Keys are shown once at issue time and rotated if lost.
   */
  apiKeyFull?: string;
  /** Marketplace services this agent may use (polymarket, reddit, …). */
  services: string[];
  createdAt: string;
  /**
   * On-chain custody address (Circle DC / ops). Funds locked via UCW send here.
   * https://developers.circle.com/agent-stack/agent-wallets
   */
  custodyAddress?: string;
  custodyMode?: "circle-eoa" | "circle-dc" | "viem-ops";
  /** Circle MPC wallet id for the agent's dedicated x402-signing EOA. */
  circleWalletId?: string;
  gatewayDeposits?: Array<{
    fundTxHash: string;
    amountUsdc: number;
    status: "approving" | "depositing" | "ready" | "failed";
    approveTransactionId?: string;
    depositTransactionId?: string;
    approveIdempotencyKey?: string;
    depositIdempotencyKey?: string;
    depositTxHash?: string;
    error?: string;
  }>;
  paymentHistory?: Array<{
    key: string;
    url: string;
    amountUsdc: number;
    status: "reserved" | "authorized" | "settled" | "ambiguous" | "released";
    createdAt: string;
    updatedAt: string;
    httpStatus?: number;
    error?: string;
  }>;
  chain?: string;
  lastFundTxHash?: string;
  /** Every funding tx already credited, so none can be replayed. */
  fundTxHashes?: string[];
  /**
   * Set when the API key is killed. This key is handed to software the user
   * does not control, so being able to stop it is the primary safety control.
   * Revoking disables spending but keeps the row, so history and any
   * remaining balance stay withdrawable.
   */
  revokedAt?: string | null;
  /** Per-call ceiling. Without it one call can drain a whole day's budget. */
  perCallLimitUsdc?: number;
};

/** Named EVM addresses for quick send (per owner user). */
export type ContactRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  address: string;
  email?: string;
  /** Marked as family: large payments to them need the emailed code. */
  family?: boolean;
  createdAt: string;
};

type DbShape = {
  users: UserRecord[];
  activity: ActivityItem[];
  threads: ChatThread[];
  messages: ChatMessage[];
  transfers: TransferRecord[];
  agents: AgentWallet[];
  contacts: ContactRecord[];
};

const DATA_PATH = dataPath("evabob-db.json");

function empty(): DbShape {
  return {
    users: [],
    activity: [],
    threads: [],
    messages: [],
    transfers: [],
    agents: [],
    contacts: [],
  };
}

function load(): DbShape {
  try {
    if (!existsSync(DATA_PATH)) return empty();
    return JSON.parse(readFileSync(DATA_PATH, "utf8")) as DbShape;
  } catch {
    return empty();
  }
}

function save(db: DbShape) {
  writeJsonAtomic(DATA_PATH, db);
  markPrimaryStoreDirty();
}

let db = load();
// Another server instance saved: pick up its version before the next request.
registerPrimaryStoreReloader(() => {
  db = load();
});

export const store = {
  resetSeedIfEmpty() {
    if (db.threads.length > 0) return;
    const now = new Date().toISOString();
    const seeds: ChatThread[] = [
      {
        id: "t_adaobi",
        members: ["me", "adaobi"],
        title: "Adaobi",
        subtitle: "Say hi — real chat on Arc",
        handle: "adaobi",
        updatedAt: now,
      },
      {
        id: "t_chinedu",
        members: ["me", "chinedu"],
        title: "Chinedu",
        subtitle: "Protected sends supported",
        handle: "chinedu",
        updatedAt: now,
      },
      {
        id: "t_maya",
        members: ["me", "maya"],
        title: "Maya",
        subtitle: "Concert plans?",
        handle: "maya",
        updatedAt: now,
      },
    ];
    db.threads.push(...seeds);
    db.messages.push({
      id: randomUUID(),
      threadId: "t_adaobi",
      senderId: "adaobi",
      kind: "text",
      text: "Can you send food money when free?",
      createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    });
    save(db);
  },

  upsertUser(input: Partial<UserRecord> & { id: string; email: string }): UserRecord {
    const existing = db.users.find((u) => u.id === input.id);
    if (existing) {
      const { evmAddress, ...rest } = input;
      Object.assign(existing, rest);
      // Never clobber a real wallet with empty string from a half-synced session.
      if (evmAddress && /^0x[a-fA-F0-9]{40}$/i.test(evmAddress)) {
        existing.evmAddress = evmAddress;
      }
      if (!existing.handle) {
        const seed = (existing.email.split("@")[0] || existing.id)
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "");
        existing.handle = store.isHandleTaken(seed, existing.id)
          ? `u_${existing.id.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "user"}`
          : seed;
      }
      save(db);
      // Best-effort Mongo dual-write
      void import("../services/mongo.js").then((m) => m.mongoUpsertUser(existing));
      return existing;
    }
    const seedHandle = (
      input.handle ||
      input.email.split("@")[0] ||
      input.id
    )
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    const baseHandle = store.isHandleTaken(seedHandle)
      ? `u_${input.id.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "user"}`
      : seedHandle;
    const user: UserRecord = {
      id: input.id,
      email: input.email,
      handle: baseHandle,
      displayName:
        input.displayName ||
        input.email.split("@")[0].replace(/^\w/, (c) => c.toUpperCase()),
      phone: input.phone,
      // New users start with no wallet until Circle onboarding for THIS id.
      evmAddress:
        input.evmAddress && /^0x[a-fA-F0-9]{40}$/i.test(input.evmAddress)
          ? input.evmAddress
          : "",
      solanaAddress: input.solanaAddress,
      starknetAddress: input.starknetAddress,
      stellarAddress: input.stellarAddress,
      injectiveAddress: input.injectiveAddress,
      handleChangedAt: null,
      handleChangeCount: 0,
      onboardingCompletedAt: null,
      displayNameChangedAt: null,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return user;
  },

  getUser(id: string) {
    return db.users.find((u) => u.id === id);
  },

  /** Address must come from the authenticated user's Circle wallet listing. */
  bindVerifiedWallet(id: string, address: string) {
    const user = db.users.find(u => u.id === id);
    if (!user) throw new Error("User not found");
    user.evmAddress = address;
    save(db);
    return user;
  },

  listUsers() {
    return db.users;
  },

  findUserByEmail(email: string) {
    const e = email.trim().toLowerCase();
    const matches = db.users.filter((u) => u.email.toLowerCase() === e);
    return (
      matches.find((u) => u.evmAddress && /^0x[a-fA-F0-9]{40}$/i.test(u.evmAddress)) ??
      matches[0]
    );
  },

  findUserByPhone(phone: string) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) return undefined;
    return db.users.find((u) => {
      const p = (u.phone || "").replace(/\D/g, "");
      return p.length >= 7 && (p === digits || p.endsWith(digits) || digits.endsWith(p));
    });
  },

  findUserByHandle(handle: string) {
    const h = handle.trim().replace(/^@/, "").toLowerCase();
    // @sends resolve by canonical handle only (display name is independent).
    const byHandle = db.users.find(
      (u) => u.handle && u.handle.toLowerCase() === h,
    );
    if (byHandle) return byHandle;
    // Migration fallback: email local-part if handle not set yet
    return db.users.find(
      (u) =>
        !u.handle &&
        (u.email.split("@")[0].toLowerCase() === h || u.id.toLowerCase() === h),
    );
  },

  isHandleTaken(handle: string, exceptUserId?: string) {
    const h = handle.trim().replace(/^@/, "").toLowerCase();
    return db.users.some(
      (u) =>
        u.id !== exceptUserId &&
        ((u.handle && u.handle.toLowerCase() === h) ||
          (!u.handle && u.email.split("@")[0].toLowerCase() === h)),
    );
  },

  /**
   * First handle change is free (does not start cooldown).
   * Subsequent changes: 30-day lock from handleChangedAt.
   */
  updateHandle(
    userId: string,
    newHandle: string,
  ):
    | { ok: true; user: UserRecord; previousHandle?: string }
    | { ok: false; error: string; nextChangeAt?: string } {
    const user = this.getUser(userId);
    if (!user) return { ok: false, error: "user not found" };
    const valid = validateHandle(newHandle);
    if (!valid.ok) return { ok: false, error: valid.error };
    const h = valid.handle;
    if (this.isHandleTaken(h, userId)) {
      return { ok: false, error: "That @handle is already taken" };
    }
    const changes = user.handleChangeCount ?? 0;
    if (changes >= 1 && user.handleChangedAt) {
      const last = new Date(user.handleChangedAt).getTime();
      const unlock = last + HANDLE_COOLDOWN_MS;
      if (Date.now() < unlock) {
        return {
          ok: false,
          error:
            "Handle can only be changed every 2 months after the first change",
          nextChangeAt: new Date(unlock).toISOString(),
        };
      }
    }
    const previousHandle = user.handle;
    user.handle = h;
    user.handleChangeCount = changes + 1;
    user.handleChangedAt = new Date().toISOString();
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return { ok: true, user, previousHandle };
  },

  /** Restore the local identity fields after a deterministic on-chain reject. */
  restoreHandleState(
    userId: string,
    state: {
      handle?: string;
      handleChangedAt?: string | null;
      handleChangeCount?: number;
    },
  ) {
    const user = this.getUser(userId);
    if (!user) return null;
    user.handle = state.handle;
    user.handleChangedAt = state.handleChangedAt ?? null;
    user.handleChangeCount = state.handleChangeCount ?? 0;
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return user;
  },

  completeOnboarding(userId: string) {
    const user = this.getUser(userId);
    if (!user) return null;
    user.onboardingCompletedAt = new Date().toISOString();
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return user;
  },

  updateDisplayName(
    userId: string,
    displayName: string,
  ):
    | { ok: true; user: UserRecord }
    | { ok: false; error: string; nextChangeAt?: string } {
    const user = this.getUser(userId);
    if (!user) return { ok: false, error: "user not found" };
    const name = displayName.trim();
    if (!name || name.length > 48) {
      return { ok: false, error: "Display name must be 1–48 characters" };
    }
    if (user.displayNameChangedAt) {
      const last = new Date(user.displayNameChangedAt).getTime();
      const unlock = last + DISPLAY_NAME_COOLDOWN_MS;
      if (Date.now() < unlock) {
        return {
          ok: false,
          error: "Display name can only be changed every 7 weeks",
          nextChangeAt: new Date(unlock).toISOString(),
        };
      }
    }
    user.displayName = name;
    user.displayNameChangedAt = new Date().toISOString();
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return { ok: true, user };
  },

  updateProfile(
    userId: string,
    patch: { displayName?: string; avatarUrl?: string; avatarBundleIndex?: number | null },
  ) {
    const user = this.getUser(userId);
    if (!user) return null;
    if (patch.displayName != null && patch.displayName.trim()) {
      const r = this.updateDisplayName(userId, patch.displayName);
      if (!r.ok) return null;
    }
    if (patch.avatarUrl !== undefined) {
      user.avatarUrl = patch.avatarUrl || undefined;
      save(db);
      void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    }
    if (patch.avatarBundleIndex !== undefined) {
      user.avatarBundleIndex = patch.avatarBundleIndex;
      save(db);
      void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    }
    return this.getUser(userId);
  },

  /**
   * Permanently link phone after email verification code succeeds.
   * Fails if already linked or phone taken by another user.
   */
  linkPhonePermanent(
    userId: string,
    phone: string,
  ):
    | { ok: true; user: UserRecord }
    | { ok: false; error: string; code?: string } {
    const user = this.getUser(userId);
    if (!user) return { ok: false, error: "user not found", code: "NO_USER" };
    if (user.phoneLinkedAt) {
      return {
        ok: false,
        error: "Phone is permanently linked and cannot be changed",
        code: "PHONE_LOCKED",
      };
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      return { ok: false, error: "Invalid phone number", code: "INVALID_PHONE" };
    }
    const normalized = phone.trim().startsWith("+")
      ? phone.trim()
      : `+${digits}`;
    const other = this.findUserByPhone(normalized);
    if (other && other.id !== userId) {
      return {
        ok: false,
        error: "Phone already linked to another account",
        code: "PHONE_TAKEN",
      };
    }
    user.phone = normalized;
    user.phoneLinkedAt = new Date().toISOString();
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return { ok: true, user };
  },

  findUserByRecipient(to: string) {
    const t = to.trim();
    if (!t) return undefined;
    if (/^0x[a-fA-F0-9]{40}$/.test(t)) {
      return db.users.find(
        (u) => u.evmAddress && u.evmAddress.toLowerCase() === t.toLowerCase(),
      );
    }
    if (t.startsWith("@")) return this.findUserByHandle(t);
    if (t.includes("@")) return this.findUserByEmail(t);
    return this.findUserByHandle(t);
  },

  listActivity(userId: string, limit = 50) {
    return db.activity
      .filter(
        (a) =>
          a.userId === userId &&
          (a.status == null ||
            a.status === "completed" ||
            a.status === "pending" ||
            a.status === "failed"),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  },

  addActivity(item: Omit<ActivityItem, "id" | "createdAt"> & { createdAt?: string }) {
    const row: ActivityItem = {
      id: randomUUID(),
      createdAt: item.createdAt || new Date().toISOString(),
      ...item,
    };
    db.activity.unshift(row);
    save(db);
    return row;
  },

  /**
   * True when an inbound transfer has already been recorded.
   *
   * Scans overlap by design — the watermark is rewound slightly on every run
   * so a reorg near the tip cannot drop a credit — so the same transfer will
   * be seen more than once and must only ever produce one activity row.
   */
  hasInboundActivity(txHash: string, logIndex: number): boolean {
    const hash = txHash.toLowerCase();
    return db.activity.some(
      (a) => a.logIndex === logIndex && (a.txHash ?? "").toLowerCase() === hash,
    );
  },

  /**
   * True when a payment between two Evabob users was already written into the
   * payee's history when the sender's payment was verified.
   *
   * That receipt carries the transaction hash but no log index, so
   * `hasInboundActivity` never matched it and the inbound scan recorded the
   * same money a second time — the payee saw it arrive twice, and the copy
   * from the scan had no memo. Token and amount are matched as well, because
   * one transaction can pay the same person in more than one currency.
   */
  hasReceiptForTransfer(input: {
    userId: string;
    txHash: string;
    token: string;
    amount: number;
  }): boolean {
    const hash = input.txHash.toLowerCase();
    return db.activity.some(
      (a) =>
        a.userId === input.userId &&
        a.kind === "receive" &&
        a.logIndex == null &&
        (a.txHash ?? "").toLowerCase() === hash &&
        (a.token || "USDC") === input.token &&
        Math.abs((a.amountToken ?? Math.abs(a.amountUsdc)) - input.amount) < 1e-9,
    );
  },

  /**
   * The inbound-scan row for a transfer, if the scan got there first.
   * The counterpart of `hasReceiptForTransfer`, for the opposite order.
   */
  findInboundReceipt(input: {
    userId: string;
    txHash: string;
    token: string;
    amount: number;
  }) {
    const hash = input.txHash.toLowerCase();
    return (
      db.activity.find(
        (a) =>
          a.userId === input.userId &&
          a.kind === "receive" &&
          a.logIndex != null &&
          (a.txHash ?? "").toLowerCase() === hash &&
          (a.token || "USDC") === input.token &&
          Math.abs((a.amountToken ?? Math.abs(a.amountUsdc)) - input.amount) < 1e-9,
      ) ?? null
    );
  },

  /**
   * True when this person's activity already has a row for this transaction
   * — their own bridge landing, a GA payment minting, a hold released to
   * them. The chain scan must not record those again as money from outside.
   */
  hasActivityWithTx(userId: string, txHash: string): boolean {
    const hash = txHash.toLowerCase();
    return db.activity.some(
      (a) =>
        a.userId === userId &&
        a.status !== "cancelled" &&
        !(a.mode ?? "").startsWith("onchain_inbound") &&
        (a.txHash ?? "").toLowerCase() === hash,
    );
  },

  /**
   * Hides chain-scan rows that duplicate one of the person's own records of
   * the same transaction (recorded before the scan learned to check). Returns
   * how many were hidden.
   */
  hideDuplicateInbound(userId: string): number {
    let hidden = 0;
    for (const a of db.activity) {
      if (a.userId !== userId || a.status === "cancelled") continue;
      if (!(a.mode ?? "").startsWith("onchain_inbound") || !a.txHash) continue;
      if (this.hasActivityWithTx(userId, a.txHash)) {
        a.status = "cancelled";
        hidden += 1;
      }
    }
    if (hidden) save(db);
    return hidden;
  },

  /** Every row of one multi-recipient payment, oldest first. */
  listBatchActivity(userId: string, batchId: string) {
    return db.activity
      .filter((a) => a.userId === userId && a.batchId === batchId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  /** Patch receipt fields (e.g. txHash / status after PIN challenge confirms). */
  updateActivity(
    id: string,
    patch: Partial<
      Pick<
        ActivityItem,
        | "txHash"
        | "description"
        | "mode"
        | "sender"
        | "receiver"
        | "token"
        | "amountToken"
        | "counterparty"
        | "status"
        | "jobId"
        | "settlementVerified"
        | "memo"
        | "memoId"
        | "memoOnchain"
        | "publicId"
      >
    >,
  ) {
    const row = db.activity.find((a) => a.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    save(db);
    return row;
  },

  getActivity(id: string) {
    return db.activity.find((a) => a.id === id) ?? null;
  },

  /** A shared payment, by the id in its public link. */
  findActivityByPublicId(publicId: string) {
    return db.activity.find((a) => a.publicId === publicId && a.status !== "cancelled") ?? null;
  },

  /** Soft-remove cancelled / failed pre-PIN drafts so they never show. */
  discardActivity(id: string, userId: string) {
    const row = db.activity.find((a) => a.id === id && a.userId === userId);
    if (!row) return false;
    row.status = "cancelled";
    save(db);
    return true;
  },

  listThreads() {
    return [...db.threads].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  },

  /** Threads where user is a member (stable identity for chat). */
  listThreadsForUser(userId: string) {
    return this.listThreads().filter((t) => t.members.includes(userId));
  },

  /**
   * View of a thread for a specific user: title/handle are always the *other* party.
   * Fixes both users seeing the same @handle and @. sends going one way.
   */
  threadForViewer(thread: ChatThread, viewerId: string) {
    const otherId =
      thread.members.find((m) => m && m !== viewerId) ||
      thread.members.find((m) => m) ||
      "";
    const other = otherId ? this.getUser(otherId) : null;
    // Fallback: stored handle when peer not registered yet
    const peerHandle =
      other?.handle ||
      (thread.handle && thread.handle.toLowerCase() !==
      (this.getUser(viewerId)?.handle || "").toLowerCase()
        ? thread.handle
        : undefined) ||
      (otherId.startsWith("peer_") ? otherId.slice(5) : undefined) ||
      thread.handle ||
      "user";
    const title =
      other?.displayName ||
      other?.handle ||
      peerHandle ||
      thread.title ||
      "Chat";
    const isAgent =
      thread.kind === "agent" ||
      thread.handle === "evabob" ||
      thread.handle === "sendit" ||
      thread.members.includes("evabob-agent") ||
      thread.members.includes("sendit-agent") ||
      otherId === "evabob-agent" ||
      otherId === "sendit-agent";
    return {
      ...thread,
      title: isAgent ? "evabob Agent" : title,
      handle: isAgent ? "evabob" : peerHandle.replace(/^@/, "").toLowerCase(),
      peerUserId: otherId || null,
      // The other person's picture, as they chose it: an uploaded photo, or
      // one of the built-in ones.
      peerAvatarUrl: isAgent ? null : other?.avatarUrl ?? null,
      peerAvatarBundle: isAgent ? null : other?.avatarBundleIndex ?? null,
      subtitle: thread.subtitle,
      kind: isAgent ? "agent" : thread.kind || "dm",
      isAgent,
    };
  },

  findThreadByHandle(handle: string) {
    const h = handle.replace(/^@/, "").toLowerCase();
    return (
      db.threads.find((t) => t.handle?.toLowerCase() === h) ||
      db.threads.find((t) => t.title.toLowerCase() === h) ||
      null
    );
  },

  /** Find DM thread between two member ids (order-independent). */
  findThreadBetween(a: string, b: string) {
    const set = new Set([a, b]);
    return (
      db.threads.find((t) => {
        if (t.members.length < 2) return false;
        const m = new Set(t.members);
        return set.size === 2 && [...set].every((id) => m.has(id));
      }) || null
    );
  },

  addThread(input: {
    members: string[];
    title: string;
    subtitle?: string;
    handle?: string;
    kind?: "agent" | "dm";
  }) {
    const handle = input.handle?.replace(/^@/, "").toLowerCase();
    const [m0, m1] = input.members;
    if (m0 && m1) {
      const existingPair = this.findThreadBetween(m0, m1);
      if (existingPair) return existingPair;
    }
    const row: ChatThread = {
      id: `t_${handle || randomUUID().slice(0, 8)}_${Date.now().toString(36)}`,
      members: input.members,
      title: input.title,
      subtitle: input.subtitle || "New conversation",
      handle,
      kind: input.kind,
      updatedAt: new Date().toISOString(),
    };
    db.threads.unshift(row);
    save(db);
    return row;
  },

  messagesFor(threadId: string) {
    return db.messages
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  addMessage(msg: Omit<ChatMessage, "id" | "createdAt"> & { createdAt?: string }) {
    const row: ChatMessage = {
      id: randomUUID(),
      createdAt: msg.createdAt || new Date().toISOString(),
      ...msg,
    };
    db.messages.push(row);
    const t = db.threads.find((x) => x.id === msg.threadId);
    if (t) {
      t.subtitle = msg.text.slice(0, 80);
      t.updatedAt = row.createdAt;
    }
    save(db);
    return row;
  },

  setThreadPendingIntent(
    threadId: string,
    intent: Record<string, unknown> | null,
  ): ChatThread | null {
    const t = db.threads.find((x) => x.id === threadId);
    if (!t) return null;
    t.pendingIntent = intent;
    save(db);
    return t;
  },

  /**
   * Patch message meta (e.g. payment request → paid/escrow) so both peers
   * stop seeing Pay after reload.
   */
  updateMessageMeta(
    messageId: string,
    metaPatch: Record<string, unknown>,
    opts?: { text?: string },
  ): ChatMessage | null {
    const i = db.messages.findIndex((m) => m.id === messageId);
    if (i < 0) return null;
    const prev = db.messages[i];
    const nextMeta = {
      ...(prev.meta && typeof prev.meta === "object"
        ? (prev.meta as Record<string, unknown>)
        : {}),
      ...metaPatch,
    };
    db.messages[i] = {
      ...prev,
      meta: nextMeta,
      ...(opts?.text != null ? { text: opts.text } : {}),
    };
    save(db);
    return db.messages[i];
  },

  /** Find payment_request messages by requestId (optionally scoped to thread). */
  findMessagesByRequestId(requestId: string, threadId?: string): ChatMessage[] {
    return db.messages.filter((m) => {
      if (threadId && m.threadId !== threadId) return false;
      const meta = m.meta as Record<string, unknown> | undefined;
      if (!meta) return false;
      return (
        meta.requestId === requestId ||
        meta.invoiceId === requestId ||
        meta.id === requestId ||
        (typeof meta.link === "string" && meta.link.includes(requestId))
      );
    });
  },

  addTransfer(t: Omit<TransferRecord, "id" | "createdAt">) {
    const row: TransferRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...t,
    };
    db.transfers.unshift(row);
    save(db);
    return row;
  },

  listAgents(userId: string) {
    return db.agents.filter((a) => a.userId === userId);
  },

  listContacts(ownerUserId: string) {
    if (!db.contacts) db.contacts = [];
    return db.contacts.filter((c) => c.ownerUserId === ownerUserId);
  },

  findContact(ownerUserId: string, nameOrAddress: string) {
    if (!db.contacts) db.contacts = [];
    const q = nameOrAddress.trim().toLowerCase().replace(/^@/, "");
    return db.contacts.find(
      (c) =>
        c.ownerUserId === ownerUserId &&
        (c.name.toLowerCase() === q || c.address.toLowerCase() === q),
    );
  },

  addContact(input: {
    ownerUserId: string;
    name: string;
    address: string;
    email?: string;
    family?: boolean;
  }) {
    if (!db.contacts) db.contacts = [];
    const row: ContactRecord = {
      id: `c_${randomUUID().slice(0, 8)}`,
      ownerUserId: input.ownerUserId,
      name: input.name.trim(),
      address: input.address.trim(),
      email: input.email?.trim(),
      ...(input.family ? { family: true } : {}),
      createdAt: new Date().toISOString(),
    };
    db.contacts.push(row);
    save(db);
    return row;
  },

  setContactFamily(ownerUserId: string, id: string, family: boolean) {
    if (!db.contacts) db.contacts = [];
    const row = db.contacts.find((c) => c.ownerUserId === ownerUserId && c.id === id);
    if (!row) return null;
    if (family) row.family = true;
    else delete row.family;
    save(db);
    return row;
  },

  setFamilyCheckAbove(userId: string, amount: number) {
    const user = this.getUser(userId);
    if (!user) return null;
    user.familyCheckAbove = amount;
    save(db);
    void import("../services/mongo.js").then((m) => m.mongoUpsertUser(user));
    return user;
  },

  deleteContact(ownerUserId: string, id: string) {
    if (!db.contacts) db.contacts = [];
    const before = db.contacts.length;
    db.contacts = db.contacts.filter(
      (c) => !(c.ownerUserId === ownerUserId && c.id === id),
    );
    if (db.contacts.length !== before) save(db);
    return db.contacts.length !== before;
  },

  createAgent(input: {
    userId: string;
    label: string;
    dailyLimitUsdc: number;
    perCallLimitUsdc?: number;
    apiKeyHash: string;
    apiKeyPrefix: string;
    apiKeyFull?: string;
    services?: string[];
    custodyAddress?: string;
    custodyMode?: "circle-eoa" | "circle-dc" | "viem-ops";
    circleWalletId?: string;
    chain?: string;
  }) {
    const row: AgentWallet = {
      id: `agent_${randomUUID().slice(0, 8)}`,
      balanceUsdc: 0,
      spentTodayUsdc: 0,
      spentDay: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      services: input.services ?? [],
      ...input,
    };
    db.agents.push(row);
    save(db);
    return row;
  },

  getAgent(userId: string, id: string) {
    return db.agents.find((a) => a.userId === userId && a.id === id);
  },

  /**
   * True when this funding transaction has already credited some agent.
   * Without it, one real on-chain transfer could be replayed to credit an
   * unlimited balance, since verification alone only proves the transfer
   * happened once.
   */
  isFundTxUsed(txHash: string): boolean {
    const needle = txHash.toLowerCase();
    return db.agents.some((a) =>
      (a.fundTxHashes ?? []).some((h) => h.toLowerCase() === needle),
    );
  },

  /**
   * Whether a transfer has already been counted as an escrow lock.
   *
   * Without this, one real deposit to the hold address could be replayed to
   * open any number of "funded" jobs, each of which pays out on release.
   * Escrow jobs live in their own file store, so the check reads the recorded
   * activity rows, which are written in the same request.
   */
  isEscrowFundTxUsed(txHash: string): boolean {
    const needle = txHash.toLowerCase();
    return db.activity.some(
      (a) =>
        a.mode === "arc_job_escrow" &&
        (a.txHash ?? "").toLowerCase() === needle,
    );
  },

  recordAgentFunding(agent: AgentWallet, txHash: string, amountUsdc: number) {
    if (this.isFundTxUsed(txHash)) throw new Error("Funding transaction already credited");
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) throw new Error("Invalid funding amount");
    agent.fundTxHashes = [...(agent.fundTxHashes ?? []), txHash];
    agent.lastFundTxHash = txHash;
    agent.balanceUsdc = Number((agent.balanceUsdc + amountUsdc).toFixed(6));
    save(db);
    return agent;
  },

  findAgentByApiKeyHash(hash: string): AgentWallet | undefined {
    return db.agents.find((a) => a.apiKeyHash === hash);
  },

  /** Kill an agent's key. Spending stops; the balance stays withdrawable. */
  revokeAgentKey(agent: AgentWallet): AgentWallet {
    agent.revokedAt = new Date().toISOString();
    save(db);
    return agent;
  },

  /**
   * Issue a replacement key. The old hash is overwritten, so the previous
   * key stops resolving immediately — rotation is also the recovery path for
   * a leaked key that still has a balance behind it.
   */
  rotateAgentKey(
    agent: AgentWallet,
    next: { apiKeyHash: string; apiKeyPrefix: string },
  ): AgentWallet {
    agent.apiKeyHash = next.apiKeyHash;
    agent.apiKeyPrefix = next.apiKeyPrefix;
    // The full key is never persisted — it is shown once, at issue time.
    delete agent.apiKeyFull;
    agent.revokedAt = null;
    save(db);
    return agent;
  },

  debitAgent(agent: AgentWallet, amountUsdc: number): AgentWallet {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0 || amountUsdc > agent.balanceUsdc) throw new Error("Insufficient agent balance");
    agent.balanceUsdc = Number((agent.balanceUsdc - amountUsdc).toFixed(6));
    save(db);
    return agent;
  },

  reserveAgentPayment(
    agent: AgentWallet,
    input: { key: string; url: string; amountUsdc: number },
  ) {
    const history = agent.paymentHistory ?? (agent.paymentHistory = []);
    const previous = history.find((row) => row.key === input.key);
    if (previous) {
      if (previous.url !== input.url || previous.amountUsdc !== input.amountUsdc) {
        throw new Error("Idempotency key reused for a different agent payment");
      }
      return { fresh: false, payment: previous };
    }
    const amount = input.amountUsdc;
    if (!Number.isFinite(amount) || amount <= 0 ||
        !/^\d+(\.\d{1,6})?$/.test(String(amount))) {
      throw new Error("Invalid x402 amount");
    }
    const day = new Date().toISOString().slice(0, 10);
    if (agent.spentDay !== day) {
      agent.spentDay = day;
      agent.spentTodayUsdc = 0;
    }
    if (amount > agent.balanceUsdc) throw new Error("Insufficient agent balance");
    if (amount > (agent.perCallLimitUsdc ?? agent.dailyLimitUsdc)) {
      throw new Error("Payment exceeds this agent's per-call limit");
    }
    if (agent.spentTodayUsdc + amount > agent.dailyLimitUsdc) {
      throw new Error("Payment exceeds this agent's daily limit");
    }
    const now = new Date().toISOString();
    const payment = {
      key: input.key,
      url: input.url,
      amountUsdc: amount,
      status: "reserved" as const,
      createdAt: now,
      updatedAt: now,
    };
    agent.balanceUsdc = Number((agent.balanceUsdc - amount).toFixed(6));
    agent.spentTodayUsdc = Number((agent.spentTodayUsdc + amount).toFixed(6));
    history.push(payment);
    save(db);
    return { fresh: true, payment };
  },

  updateAgentPayment(
    agent: AgentWallet,
    key: string,
    patch: Partial<Pick<NonNullable<AgentWallet["paymentHistory"]>[number],
      "status" | "httpStatus" | "error">>,
  ) {
    const payment = agent.paymentHistory?.find((row) => row.key === key);
    if (!payment) throw new Error("Agent payment reservation not found");
    Object.assign(payment, patch, { updatedAt: new Date().toISOString() });
    save(db);
    return payment;
  },

  releaseAgentPayment(agent: AgentWallet, key: string, reason: string) {
    const payment = agent.paymentHistory?.find((row) => row.key === key);
    if (!payment) throw new Error("Agent payment reservation not found");
    if (payment.status === "released") return payment;
    if (payment.status !== "reserved") {
      throw new Error("A disclosed payment authorization cannot be released automatically");
    }
    agent.balanceUsdc = Number((agent.balanceUsdc + payment.amountUsdc).toFixed(6));
    if (agent.spentDay === new Date().toISOString().slice(0, 10)) {
      agent.spentTodayUsdc = Number(Math.max(0,
        agent.spentTodayUsdc - payment.amountUsdc).toFixed(6));
    }
    payment.status = "released";
    payment.error = reason;
    payment.updatedAt = new Date().toISOString();
    save(db);
    return payment;
  },

  /** Credits the agent and records its owner activity in one persisted state. */
  completeAgentGatewayFunding(
    agent: AgentWallet,
    txHash: string,
    amountUsdc: number,
  ): { fresh: boolean; activity?: ActivityItem } {
    if (this.isFundTxUsed(txHash)) return { fresh: false };
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error("Invalid funding amount");
    }
    agent.fundTxHashes = [...(agent.fundTxHashes ?? []), txHash];
    agent.lastFundTxHash = txHash;
    agent.balanceUsdc = Number((agent.balanceUsdc + amountUsdc).toFixed(6));
    const activity: ActivityItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      userId: agent.userId,
      kind: "agent",
      title: agent.label,
      description: `Deposited ${amountUsdc} USDC to agent Gateway balance`,
      amountUsdc: -amountUsdc,
      txHash,
      mode: "agent_gateway_fund",
      status: "completed",
    };
    db.activity.unshift(activity);
    save(db);
    return { fresh: true, activity };
  },

  findReceiptByTxHash(txHash: string) {
    const needle = txHash.toLowerCase();
    return db.messages.find((message) => {
      if (message.kind !== "receipt" || !message.meta) return false;
      const hash = message.meta.txHash ?? message.meta.hash;
      return typeof hash === "string" && hash.toLowerCase() === needle;
    });
  },

  reserveAgentWithdrawal(agent: AgentWallet, key: string, amount: number, to: string) {
    const history = agent.withdrawalHistory ?? (agent.withdrawal ? [agent.withdrawal] : []);
    const previous = history.find((entry) => entry.key === key) ?? agent.withdrawal;
    if (previous?.key === key) {
      if (previous.amount !== amount || previous.to !== to) throw new Error("Idempotency key reused with different payment");
      return { fresh: false, withdrawal: previous };
    }
    if (previous?.status === "reserved") throw new Error("Previous withdrawal awaits reconciliation");
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(\.\d{1,6})?$/.test(String(amount)) || amount > agent.balanceUsdc) throw new Error("Invalid amount or insufficient balance");
    agent.balanceUsdc = Number((agent.balanceUsdc - amount).toFixed(6));
    agent.withdrawal = { key, amount, to, status: "reserved" };
    agent.withdrawalHistory = [...history, agent.withdrawal];
    save(db);
    return { fresh: true, withdrawal: agent.withdrawal };
  },

  /**
   * True when another verified send already claims this transaction.
   *
   * Rows of one multi-recipient payment share a transaction by design, so a
   * row's own batch is exempt. Each of those rows is still verified against
   * its own recipient and amount, and a batch never pays one address twice.
   */
  isPaymentEvidenceUsed(userId: string, hash: string, exceptId: string, batchId?: string) {
    return db.activity.some(a => a.userId === userId && a.id !== exceptId && a.kind === "send"
      && !(batchId && a.batchId === batchId)
      && a.settlementVerified && a.txHash?.toLowerCase() === hash.toLowerCase());
  },

  hasActivityTxHash(userId: string, hash: string, mode?: string) {
    const needle = hash.toLowerCase();
    return db.activity.some(a => a.userId === userId
      && (!mode || a.mode === mode)
      && a.txHash?.toLowerCase() === needle);
  },

  getAgentById(id: string): AgentWallet | undefined {
    return db.agents.find((a) => a.id === id);
  },

  /** Records how far inbound scanning has got for one user. */
  setInboundNativeBackfill(userId: string, state: { next: string; floor: string; done: boolean }) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return;
    u.inboundNativeBackfill = state;
    save(db);
  },

  setInboundScannedBlockFor(userId: string, chainId: number, block: number) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return;
    const blocks = (u.inboundScannedBlocks ??= {});
    if ((blocks[String(chainId)] ?? 0) >= block) return;
    blocks[String(chainId)] = block;
    save(db);
  },

  setInboundScannedBlock(userId: string, block: number) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return;
    // Only ever move forward, so a slow scan cannot rewind a faster one.
    if ((u.inboundScannedBlock ?? 0) >= block) return;
    u.inboundScannedBlock = block;
    save(db);
  },

  save() {
    save(db);
  },
};
