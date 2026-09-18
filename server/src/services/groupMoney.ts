/**
 * Money circles and group pots: saving and collecting together without anyone
 * holding everyone else's money.
 *
 * A money circle (ajo, esusu, chama, tontine) is a group that puts in the same
 * amount every round while one member takes the whole pot, in turn. The
 * MoneyCircles contract runs it: members approve it once for their full
 * commitment and join, and each round the server — or anyone — triggers the
 * collection, which pays that round's member in the same transaction. The
 * rules for a missed contribution were chosen by the product owner (see
 * contracts/src/MoneyCircles.sol): the round pays out what came in, the member
 * who missed is behind and owes the member they shorted, and a behind member
 * whose turn comes is moved to the end. The keeper below retries a behind
 * member's catch-up whenever their wallet can cover it.
 *
 * A group pot is a one-off collection with a target and a deadline. The
 * GroupPots contract releases it to the beneficiary the moment the target is
 * reached, and refunds every contributor if the deadline passes short of it;
 * the keeper sends those refunds without anyone having to ask.
 *
 * This module keeps what the chain does not: names, who is who, and a cached
 * copy of each contract's state for the app. The chain is the truth; every
 * cached field is refreshed from it before anything is decided.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { groupPotsAbi, moneyCirclesAbi } from "../abis/groupMoney.js";
import { config } from "../config.js";
import { store, type UserRecord } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { getPublicClient, getWalletClient } from "./arc-wallet.js";
import { alertUser } from "./notifyUser.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";

// ─── Types ───────────────────────────────────────────────────────────────

/** How often a circle collects. Ten minutes exists for testnet demos only. */
export const ROUND_SECONDS = {
  ten_minutes: 10 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  two_weeks: 14 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
} as const;
export type RoundEvery = keyof typeof ROUND_SECONDS;

export type CircleRound = {
  round: number;
  recipient: string;
  amountUsdc: number;
  missed: string[];
  txHash?: string;
  at: string;
};

export type CircleRecord = {
  kind: "circle";
  id: string;
  contract: string;
  onChainId?: string;
  name: string;
  organizerId: string;
  /** Evabob user ids, in the payout order the circle was created with. */
  memberIds: string[];
  /** Their wallet addresses, same order, lower-case. */
  memberAddresses: string[];
  contributionUsdc: number;
  every: RoundEvery;
  roundSeconds: number;
  startAt: string;
  createdAt: string;
  createTx?: string;
  // Cached from the chain.
  state: "draft" | "forming" | "running" | "finished" | "cancelled";
  joined: string[];
  roundsCollected: number;
  nextCollectionAt?: string;
  /** Addresses still waiting for their payout, next first. */
  queue: string[];
  /** USDC each member is behind, by address. */
  arrears: Record<string, number>;
  history: CircleRound[];
  syncedAt?: string;
};

export type PotRecord = {
  kind: "pot";
  id: string;
  contract: string;
  onChainId?: string;
  title: string;
  description?: string;
  organizerId: string;
  beneficiaryId: string;
  beneficiaryAddress: string;
  targetUsdc: number;
  deadline: string;
  createdAt: string;
  createTx?: string;
  // Cached from the chain.
  state: "draft" | "open" | "released" | "refunding";
  raisedUsdc: number;
  /** Contributions still in the pot (or refunded to zero), by address. */
  contributors: Record<string, number>;
  releasedAt?: string;
  syncedAt?: string;
};

export type GroupRecord = CircleRecord | PotRecord;

export class GroupMoneyError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) {
    super(message);
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────

const DATA_PATH = dataPath("group-money.json");
let groups: GroupRecord[] = load();

function load(): GroupRecord[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as GroupRecord[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, groups);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  groups = load();
});

export function getGroup(id: string): GroupRecord | null {
  return groups.find((g) => g.id === id) ?? null;
}

function update<T extends GroupRecord>(record: T, patch: Partial<T>): T {
  Object.assign(record, patch);
  save();
  return record;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const units = (usdc: number) => BigInt(Math.round(usdc * 1e6));
const fromUnits = (v: bigint) => Number(v) / 1e6;

function circlesAddress(): Address {
  const a = config.arc.moneyCircles;
  if (!a) throw new GroupMoneyError("Money circles are not set up on this server", 503);
  return a as Address;
}

function potsAddress(): Address {
  const a = config.arc.groupPots;
  if (!a) throw new GroupMoneyError("Group pots are not set up on this server", 503);
  return a as Address;
}

function label(u: UserRecord | undefined | null): string {
  return u?.handle ? `@${u.handle}` : u?.displayName || "someone";
}

function userByAddress(address: string): UserRecord | undefined {
  const a = address.toLowerCase();
  return store.listUsers().find((u) => u.evmAddress?.toLowerCase() === a);
}

function labelFor(address: string): string {
  const u = userByAddress(address);
  return u ? label(u) : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function resolvePerson(identifier: string): UserRecord {
  const u = store.findUserByRecipient(identifier.trim());
  if (!u) throw new GroupMoneyError(`${identifier} is not on Evabob yet`, 404);
  if (!u.evmAddress) throw new GroupMoneyError(`${label(u)} has not set up their wallet yet`, 409);
  return u;
}

function newId(prefix: "c" | "p"): string {
  return `${prefix}_${randomBytes(8).toString("base64url")}`;
}

type Call = { to: Address; data: Hex };

// ─── Circles ─────────────────────────────────────────────────────────────

/**
 * A new circle, not yet on chain. Returns the calls for the organizer's
 * wallet: create it, and — when the organizer is a member — approve and join
 * in the same batch, so they confirm once.
 */
export async function prepareCircle(
  organizerId: string,
  input: {
    name: string;
    contributionUsdc: number;
    every: RoundEvery;
    members: string[];
    startAt?: string;
  },
): Promise<{ record: CircleRecord; calls: Call[] }> {
  const organizer = store.getUser(organizerId);
  if (!organizer?.evmAddress) throw new GroupMoneyError("Set up your wallet first", 409);
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new GroupMoneyError("Give the circle a name");
  if (!(input.contributionUsdc >= 1) || input.contributionUsdc > 10_000) {
    throw new GroupMoneyError("Each person puts in between $1 and $10,000 a round");
  }
  if (input.every === "ten_minutes" && config.deploymentEnv === "production") {
    throw new GroupMoneyError("Pick how often: daily, weekly, every two weeks or monthly");
  }
  const people = input.members.map(resolvePerson);
  const ids = new Set<string>();
  for (const p of people) {
    if (ids.has(p.id)) throw new GroupMoneyError(`${label(p)} is in the list twice`);
    ids.add(p.id);
  }
  if (people.length < 2 || people.length > 20) {
    throw new GroupMoneyError("A circle has 2 to 20 people, you included");
  }
  const roundSeconds = ROUND_SECONDS[input.every];
  const startMs = input.startAt ? Date.parse(input.startAt) : Date.now();
  if (!Number.isFinite(startMs)) throw new GroupMoneyError("That start date is not valid");

  const record: CircleRecord = {
    kind: "circle",
    id: newId("c"),
    contract: circlesAddress(),
    name,
    organizerId,
    memberIds: people.map((p) => p.id),
    memberAddresses: people.map((p) => p.evmAddress.toLowerCase()),
    contributionUsdc: Math.round(input.contributionUsdc * 1e6) / 1e6,
    every: input.every,
    roundSeconds,
    startAt: new Date(Math.max(startMs, Date.now())).toISOString(),
    createdAt: new Date().toISOString(),
    state: "draft",
    joined: [],
    roundsCollected: 0,
    queue: people.map((p) => p.evmAddress.toLowerCase()),
    arrears: {},
    history: [],
  };

  const calls: Call[] = [
    {
      to: circlesAddress(),
      data: encodeFunctionData({
        abi: moneyCirclesAbi,
        functionName: "createCircle",
        args: [
          units(record.contributionUsdc),
          BigInt(roundSeconds),
          BigInt(Math.floor(Date.parse(record.startAt) / 1000)),
          people.map((p) => p.evmAddress as Address),
        ],
      }),
    },
  ];
  if (ids.has(organizerId)) {
    // The id this circle will get. If another circle is created first the
    // join fails, the whole batch reverts, and nothing is lost.
    const nextId = (await getPublicClient().readContract({
      address: circlesAddress(),
      abi: moneyCirclesAbi,
      functionName: "nextCircleId",
    })) as bigint;
    calls.push(...joinCallsFor(record, nextId));
  }
  groups.push(record);
  save();
  return { record, calls };
}

function commitmentUnits(record: CircleRecord): bigint {
  return units(record.contributionUsdc) * BigInt(record.memberIds.length);
}

function joinCallsFor(record: CircleRecord, onChainId: bigint): Call[] {
  return [
    {
      to: config.arc.usdc as Address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [record.contract as Address, commitmentUnits(record)],
      }),
    },
    {
      to: record.contract as Address,
      data: encodeFunctionData({ abi: moneyCirclesAbi, functionName: "join", args: [onChainId] }),
    },
  ];
}

/** The calls a member signs to join: approve the whole commitment, then join. */
export function joinCircleCalls(userId: string, id: string): Call[] {
  const record = requireCircle(id);
  if (!record.memberIds.includes(userId)) throw new GroupMoneyError("You are not in this circle", 403);
  if (record.state !== "forming") throw new GroupMoneyError("This circle is not taking members", 409);
  const me = store.getUser(userId)!;
  if (record.joined.includes(me.evmAddress.toLowerCase())) {
    throw new GroupMoneyError("You have already joined", 409);
  }
  return joinCallsFor(record, BigInt(record.onChainId!));
}

function requireCircle(id: string): CircleRecord {
  const g = getGroup(id);
  if (!g || g.kind !== "circle") throw new GroupMoneyError("No such circle", 404);
  if (!g.onChainId) throw new GroupMoneyError("This circle was never created", 409);
  return g;
}

/** Records the circle's on-chain id from the transaction that created it. */
export async function confirmCircle(organizerId: string, id: string, txHash: Hex): Promise<CircleRecord> {
  const record = getGroup(id);
  if (!record || record.kind !== "circle" || record.organizerId !== organizerId) {
    throw new GroupMoneyError("No such circle", 404);
  }
  if (record.onChainId) return syncCircle(record);
  const organizer = store.getUser(organizerId)!;
  const receipt = await getPublicClient().getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new GroupMoneyError("That transaction did not succeed");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== record.contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: moneyCirclesAbi, data: log.data, topics: log.topics });
      if (ev.eventName !== "CircleCreated") continue;
      const args = ev.args as { circleId: bigint; organizer: Address; members: readonly Address[] };
      if (args.organizer.toLowerCase() !== organizer.evmAddress.toLowerCase()) continue;
      const sameMembers =
        args.members.length === record.memberAddresses.length &&
        args.members.every((m, i) => m.toLowerCase() === record.memberAddresses[i]);
      if (!sameMembers) continue;
      update(record, { onChainId: args.circleId.toString(), createTx: txHash, state: "forming" });
      for (const memberId of record.memberIds) {
        if (memberId === organizerId) continue;
        alertUser(memberId, {
          kind: "group_update",
          title: `${label(organizer)} invited you to a money circle`,
          body: `"${record.name}": ${record.memberIds.length} people put in $${record.contributionUsdc} ${everyWords(record.every)}, and each takes the pot in turn. Open it to join.`,
          link: `evabob://group/${record.id}`,
        });
      }
      return syncCircle(record);
    } catch {
      continue;
    }
  }
  throw new GroupMoneyError("That transaction did not create this circle");
}

export function everyWords(every: RoundEvery): string {
  return {
    ten_minutes: "every 10 minutes",
    day: "every day",
    week: "every week",
    two_weeks: "every two weeks",
    month: "every month",
  }[every];
}

const CIRCLE_STATES = ["none", "forming", "running", "finished", "cancelled"] as const;

/** Refreshes the cached copy from the contract and tells people what changed. */
export async function syncCircle(record: CircleRecord): Promise<CircleRecord> {
  if (!record.onChainId) return record;
  const client = getPublicClient();
  const id = BigInt(record.onChainId);
  const address = record.contract as Address;
  const [c, queue, next] = await Promise.all([
    client.readContract({ address, abi: moneyCirclesAbi, functionName: "circles", args: [id] }),
    client.readContract({ address, abi: moneyCirclesAbi, functionName: "payoutQueue", args: [id] }),
    client.readContract({ address, abi: moneyCirclesAbi, functionName: "nextCollectionAt", args: [id] }),
  ]);
  const [, , , startAt, , , roundsCollected, stateIndex] = c as readonly [
    Address, bigint, bigint, bigint, number, number, number, number,
  ];
  const perMember = await Promise.all(
    record.memberAddresses.map(async (m) => {
      const [joined, owed] = await Promise.all([
        client.readContract({ address, abi: moneyCirclesAbi, functionName: "hasJoined", args: [id, m as Address] }),
        client.readContract({ address, abi: moneyCirclesAbi, functionName: "arrears", args: [id, m as Address] }),
      ]);
      return { m, joined: joined as boolean, owed: fromUnits(owed as bigint) };
    }),
  );
  const before = record.state;
  const state = CIRCLE_STATES[Number(stateIndex)] ?? "forming";
  update(record, {
    state: state === "none" ? "forming" : state,
    startAt: new Date(Number(startAt) * 1000).toISOString(),
    roundsCollected: Number(roundsCollected),
    nextCollectionAt: new Date(Number(next as bigint) * 1000).toISOString(),
    queue: (queue as readonly Address[]).map((a) => a.toLowerCase()),
    joined: perMember.filter((p) => p.joined).map((p) => p.m),
    arrears: Object.fromEntries(perMember.filter((p) => p.owed > 0).map((p) => [p.m, p.owed])),
    syncedAt: new Date().toISOString(),
  });
  if (before === "forming" && record.state === "running") {
    for (const memberId of record.memberIds) {
      alertUser(memberId, {
        kind: "group_update",
        title: `"${record.name}" has started`,
        body: `Everyone joined. The first $${record.contributionUsdc} is collected ${new Date(record.nextCollectionAt!).toUTCString().slice(0, 16)}.`,
        link: `evabob://group/${record.id}`,
      });
    }
  }
  return record;
}

// ─── Pots ────────────────────────────────────────────────────────────────

export function preparePot(
  organizerId: string,
  input: { title: string; description?: string; targetUsdc: number; deadline: string; beneficiary?: string },
): { record: PotRecord; calls: Call[] } {
  const organizer = store.getUser(organizerId);
  if (!organizer?.evmAddress) throw new GroupMoneyError("Set up your wallet first", 409);
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) throw new GroupMoneyError("Say what the collection is for");
  if (!(input.targetUsdc >= 1) || input.targetUsdc > 1_000_000) {
    throw new GroupMoneyError("The target must be between $1 and $1,000,000");
  }
  const deadlineMs = Date.parse(input.deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now() + 5 * 60 * 1000) {
    throw new GroupMoneyError("The deadline must be in the future");
  }
  if (deadlineMs > Date.now() + 365 * 24 * 60 * 60 * 1000) {
    throw new GroupMoneyError("The deadline must be within a year");
  }
  const beneficiary = input.beneficiary ? resolvePerson(input.beneficiary) : organizer;
  const record: PotRecord = {
    kind: "pot",
    id: newId("p"),
    contract: potsAddress(),
    title,
    description: input.description?.replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
    organizerId,
    beneficiaryId: beneficiary.id,
    beneficiaryAddress: beneficiary.evmAddress.toLowerCase(),
    targetUsdc: Math.round(input.targetUsdc * 1e6) / 1e6,
    deadline: new Date(deadlineMs).toISOString(),
    createdAt: new Date().toISOString(),
    state: "draft",
    raisedUsdc: 0,
    contributors: {},
  };
  groups.push(record);
  save();
  return {
    record,
    calls: [
      {
        to: potsAddress(),
        data: encodeFunctionData({
          abi: groupPotsAbi,
          functionName: "createPot",
          args: [
            beneficiary.evmAddress as Address,
            units(record.targetUsdc),
            BigInt(Math.floor(deadlineMs / 1000)),
          ],
        }),
      },
    ],
  };
}

function requirePot(id: string): PotRecord {
  const g = getGroup(id);
  if (!g || g.kind !== "pot") throw new GroupMoneyError("No such pot", 404);
  if (!g.onChainId) throw new GroupMoneyError("This pot was never created", 409);
  return g;
}

export async function confirmPot(organizerId: string, id: string, txHash: Hex): Promise<PotRecord> {
  const record = getGroup(id);
  if (!record || record.kind !== "pot" || record.organizerId !== organizerId) {
    throw new GroupMoneyError("No such pot", 404);
  }
  if (record.onChainId) return syncPot(record);
  const organizer = store.getUser(organizerId)!;
  const receipt = await getPublicClient().getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new GroupMoneyError("That transaction did not succeed");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== record.contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: groupPotsAbi, data: log.data, topics: log.topics });
      if (ev.eventName !== "PotCreated") continue;
      const args = ev.args as { potId: bigint; organizer: Address; beneficiary: Address };
      if (
        args.organizer.toLowerCase() !== organizer.evmAddress.toLowerCase() ||
        args.beneficiary.toLowerCase() !== record.beneficiaryAddress
      ) {
        continue;
      }
      update(record, { onChainId: args.potId.toString(), createTx: txHash, state: "open" });
      return syncPot(record);
    } catch {
      continue;
    }
  }
  throw new GroupMoneyError("That transaction did not create this pot");
}

/** The calls a contributor signs: approve exactly this amount, then contribute. */
export function contributeCalls(userId: string, id: string, amountUsdc: number): Call[] {
  const record = requirePot(id);
  if (record.state !== "open") throw new GroupMoneyError("This pot is closed", 409);
  if (Date.parse(record.deadline) <= Date.now()) throw new GroupMoneyError("This pot's deadline has passed", 409);
  if (!(amountUsdc >= 0.01)) throw new GroupMoneyError("Enter an amount");
  if (!store.getUser(userId)?.evmAddress) throw new GroupMoneyError("Set up your wallet first", 409);
  const amount = units(amountUsdc);
  return [
    {
      to: config.arc.usdc as Address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [record.contract as Address, amount] }),
    },
    {
      to: record.contract as Address,
      data: encodeFunctionData({
        abi: groupPotsAbi,
        functionName: "contribute",
        args: [BigInt(record.onChainId!), amount],
      }),
    },
  ];
}

/** Records a contribution from its transaction, so the keeper knows whom to refund. */
export async function confirmContribution(userId: string, id: string, txHash: Hex): Promise<PotRecord> {
  const record = requirePot(id);
  const me = store.getUser(userId);
  const receipt = await getPublicClient().getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new GroupMoneyError("That transaction did not succeed");
  let found = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== record.contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: groupPotsAbi, data: log.data, topics: log.topics });
      if (ev.eventName !== "Contributed") continue;
      const args = ev.args as { potId: bigint; contributor: Address; amount: bigint };
      if (args.potId.toString() !== record.onChainId) continue;
      const who = args.contributor.toLowerCase();
      if (me?.evmAddress?.toLowerCase() === who) found = true;
      record.contributors[who] = record.contributors[who] ?? 0;
    } catch {
      continue;
    }
  }
  if (!found) throw new GroupMoneyError("That transaction did not add to this pot");
  save();
  return syncPot(record);
}

const POT_STATES = ["none", "open", "released", "refunding"] as const;

export async function syncPot(record: PotRecord): Promise<PotRecord> {
  if (!record.onChainId) return record;
  const client = getPublicClient();
  const id = BigInt(record.onChainId);
  const address = record.contract as Address;
  const p = (await client.readContract({ address, abi: groupPotsAbi, functionName: "pots", args: [id] })) as readonly [
    Address, Address, bigint, bigint, bigint, number,
  ];
  const [, , , raised, , stateIndex] = p;
  const contributions = await Promise.all(
    Object.keys(record.contributors).map(async (who) => {
      const v = await client.readContract({
        address,
        abi: groupPotsAbi,
        functionName: "contributed",
        args: [id, who as Address],
      });
      return [who, fromUnits(v as bigint)] as const;
    }),
  );
  const before = record.state;
  const state = POT_STATES[Number(stateIndex)] ?? "open";
  update(record, {
    state: state === "none" ? "open" : state,
    raisedUsdc: fromUnits(raised),
    contributors: Object.fromEntries(contributions),
    syncedAt: new Date().toISOString(),
    ...(state === "released" && !record.releasedAt ? { releasedAt: new Date().toISOString() } : {}),
  });
  if (before === "open" && record.state === "released") {
    const people = new Set([record.organizerId, record.beneficiaryId]);
    for (const addr of Object.keys(record.contributors)) {
      const u = userByAddress(addr);
      if (u) people.add(u.id);
    }
    for (const id of people) {
      alertUser(id, {
        kind: "group_update",
        moneyIn: id === record.beneficiaryId,
        title: `"${record.title}" reached its target`,
        body: `$${record.raisedUsdc.toFixed(2)} went to ${label(store.getUser(record.beneficiaryId))}.`,
        link: `evabob://group/${record.id}`,
      });
    }
  }
  return record;
}

// ─── The keeper ──────────────────────────────────────────────────────────

async function opsCall(address: Address, abi: typeof moneyCirclesAbi | typeof groupPotsAbi, functionName: string, args: readonly unknown[]) {
  const client = getPublicClient();
  const wallet = getWalletClient();
  // Simulate first: a round that someone else already collected, or a refund
  // already sent, should cost nothing.
  const { request } = await client.simulateContract({
    account: wallet.account,
    address,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
  });
  const hash = await wallet.writeContract(request as never);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

async function collectRound(record: CircleRecord): Promise<boolean> {
  const receipt = await opsCall(record.contract as Address, moneyCirclesAbi, "collect", [BigInt(record.onChainId!)]);
  let paid: CircleRound | null = null;
  const missed: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== record.contract.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: moneyCirclesAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Missed") missed.push((ev.args as { member: Address }).member.toLowerCase());
      if (ev.eventName === "PaidOut") {
        const a = ev.args as { round: number; recipient: Address; amount: bigint };
        paid = {
          round: Number(a.round),
          recipient: a.recipient.toLowerCase(),
          amountUsdc: fromUnits(a.amount),
          missed,
          txHash: receipt.transactionHash,
          at: new Date().toISOString(),
        };
      }
    } catch {
      continue;
    }
  }
  if (!paid) return false;
  record.history.push(paid);
  save();
  const who = labelFor(paid.recipient);
  for (let i = 0; i < record.memberIds.length; i++) {
    const memberId = record.memberIds[i]!;
    const address = record.memberAddresses[i]!;
    const mine = address === paid.recipient;
    const missedMine = paid.missed.includes(address);
    alertUser(memberId, {
      kind: "group_update",
      moneyIn: mine,
      title: mine ? `You received $${paid.amountUsdc.toFixed(2)} from "${record.name}"` : `"${record.name}": round ${paid.round + 1} paid`,
      body: missedMine
        ? `Your $${record.contributionUsdc} could not be collected this round, so you are behind. Add money to your balance and we will catch you up automatically.`
        : mine
          ? "It's your turn. The pot is in your balance now."
          : `${who} received $${paid.amountUsdc.toFixed(2)}.`,
      link: `evabob://group/${record.id}`,
    });
  }
  return true;
}

async function tryCatchUp(record: CircleRecord, member: string): Promise<boolean> {
  const client = getPublicClient();
  const address = record.contract as Address;
  const debts = (await client.readContract({
    address,
    abi: moneyCirclesAbi,
    functionName: "debtsOf",
    args: [BigInt(record.onChainId!), member as Address],
  })) as readonly { creditor: Address; amount: bigint }[];
  const first = debts[0];
  if (!first) return false;
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: config.arc.usdc as Address, abi: erc20Abi, functionName: "balanceOf", args: [member as Address] }),
    client.readContract({ address: config.arc.usdc as Address, abi: erc20Abi, functionName: "allowance", args: [member as Address, address] }),
  ]);
  // Leave a little for gas: on Arc, USDC is what pays for the member's next transaction.
  if (balance < first.amount + 50_000n || allowance < first.amount) return false;
  await opsCall(address, moneyCirclesAbi, "catchUp", [BigInt(record.onChainId!), member as Address]);
  const memberUser = userByAddress(member);
  const creditor = userByAddress(first.creditor);
  if (memberUser) {
    alertUser(memberUser.id, {
      kind: "group_update",
      title: `You're caught up in "${record.name}"`,
      body: `$${fromUnits(first.amount).toFixed(2)} went to ${labelFor(first.creditor)}, the round you missed.`,
      link: `evabob://group/${record.id}`,
    });
  }
  if (creditor) {
    alertUser(creditor.id, {
      kind: "group_update",
      moneyIn: true,
      title: `${labelFor(member)} caught up in "${record.name}"`,
      body: `You received the $${fromUnits(first.amount).toFixed(2)} you were short.`,
      link: `evabob://group/${record.id}`,
    });
  }
  return true;
}

async function refundPot(record: PotRecord, now: number): Promise<number> {
  const due =
    record.state === "refunding" ||
    (record.state === "open" && Date.parse(record.deadline) <= now && record.raisedUsdc < record.targetUsdc);
  if (!due) return 0;
  let refunded = 0;
  for (const [who, amount] of Object.entries(record.contributors)) {
    if (!(amount > 0)) continue;
    await opsCall(record.contract as Address, groupPotsAbi, "refund", [BigInt(record.onChainId!), who as Address]);
    refunded += 1;
    const u = userByAddress(who);
    if (u) {
      alertUser(u.id, {
        kind: "group_update",
        moneyIn: true,
        title: `Refunded from "${record.title}"`,
        body: `It did not reach its target, so your $${amount.toFixed(2)} is back in your balance.`,
        link: `evabob://group/${record.id}`,
      });
    }
  }
  return refunded;
}

/**
 * Runs on the tick: collects due rounds, catches up behind members whose
 * wallet can now cover it, and refunds pots that missed their target.
 */
export async function runGroupMoneyWork(now = Date.now()): Promise<{
  collected: number;
  caughtUp: number;
  refunded: number;
  errors: string[];
}> {
  const out = { collected: 0, caughtUp: 0, refunded: 0, errors: [] as string[] };
  if (!config.arc.moneyCircles && !config.arc.groupPots) return out;
  for (const g of [...groups]) {
    if (!g.onChainId) continue;
    try {
      if (g.kind === "circle") {
        if (g.state !== "running" && g.state !== "finished") {
          if (g.state === "forming") await syncCircle(g);
          continue;
        }
        if (g.state === "running" && g.nextCollectionAt && Date.parse(g.nextCollectionAt) <= now) {
          await syncCircle(g); // someone else may have collected it
          if (g.state === "running" && Date.parse(g.nextCollectionAt!) <= now && (await collectRound(g))) {
            out.collected += 1;
          }
          await syncCircle(g);
        }
        let caughtUp = 0;
        for (const member of Object.keys(g.arrears)) {
          if (await tryCatchUp(g, member)) caughtUp += 1;
        }
        if (caughtUp) await syncCircle(g);
        out.caughtUp += caughtUp;
      } else {
        if (g.state === "released") continue;
        const deadlinePassed = Date.parse(g.deadline) <= now;
        if (deadlinePassed || g.state === "refunding") {
          await syncPot(g);
          const refunded = await refundPot(g, now);
          if (refunded) await syncPot(g);
          out.refunded += refunded;
        }
      }
    } catch (e) {
      out.errors.push(`${g.id}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return out;
}

// ─── Views ───────────────────────────────────────────────────────────────

function memberView(record: CircleRecord, i: number) {
  const address = record.memberAddresses[i]!;
  const user = store.getUser(record.memberIds[i]!);
  const paidRound = record.history.find((h) => h.recipient === address);
  return {
    userId: record.memberIds[i],
    name: label(user),
    joined: record.joined.includes(address),
    behindUsdc: record.arrears[address] ?? 0,
    paidOut: paidRound ? { round: paidRound.round + 1, amountUsdc: paidRound.amountUsdc, at: paidRound.at } : null,
    /** Place in the payout queue, 1 = next. Null once paid. */
    place: record.queue.indexOf(address) >= 0 ? record.queue.indexOf(address) + 1 : null,
  };
}

export function circleView(record: CircleRecord, userId: string) {
  const i = record.memberIds.indexOf(userId);
  return {
    kind: "circle" as const,
    id: record.id,
    name: record.name,
    state: record.state,
    organizer: label(store.getUser(record.organizerId)),
    isOrganizer: record.organizerId === userId,
    contributionUsdc: record.contributionUsdc,
    every: record.every,
    everyWords: everyWords(record.every),
    rounds: record.memberIds.length,
    roundsCollected: record.roundsCollected,
    potUsdc: record.contributionUsdc * record.memberIds.length,
    commitmentUsdc: record.contributionUsdc * record.memberIds.length,
    startAt: record.startAt,
    nextCollectionAt: record.nextCollectionAt ?? null,
    members: record.memberIds.map((_, j) => memberView(record, j)),
    me: i >= 0 ? memberView(record, i) : null,
    history: record.history.map((h) => ({
      round: h.round + 1,
      recipient: labelFor(h.recipient),
      amountUsdc: h.amountUsdc,
      missed: h.missed.map(labelFor),
      at: h.at,
    })),
  };
}

export function potView(record: PotRecord, userId?: string) {
  const me = userId ? store.getUser(userId)?.evmAddress?.toLowerCase() : undefined;
  const contributors = Object.keys(record.contributors).length;
  return {
    kind: "pot" as const,
    id: record.id,
    title: record.title,
    description: record.description ?? "",
    state: record.state,
    organizer: label(store.getUser(record.organizerId)),
    beneficiary: label(store.getUser(record.beneficiaryId)),
    targetUsdc: record.targetUsdc,
    raisedUsdc: record.raisedUsdc,
    deadline: record.deadline,
    contributors,
    releasedAt: record.releasedAt ?? null,
    url: `${(config.appPublicUrl || "https://evabob.app").replace(/\/$/, "")}/g/${record.id}`,
    deepLink: `evabob://group/${record.id}`,
    ...(userId
      ? {
          isOrganizer: record.organizerId === userId,
          myContributionUsdc: me ? record.contributors[me] ?? 0 : 0,
        }
      : {}),
  };
}

/** Circles the person is in and pots they started, gave to, or benefit from. */
export function listGroupsFor(userId: string) {
  const me = store.getUser(userId)?.evmAddress?.toLowerCase();
  return groups
    .filter((g) => g.onChainId)
    .filter((g) =>
      g.kind === "circle"
        ? g.memberIds.includes(userId)
        : g.organizerId === userId || g.beneficiaryId === userId || (me != null && me in g.contributors),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((g) => (g.kind === "circle" ? circleView(g, userId) : potView(g, userId)));
}

/** A group as the signed-in person sees it, refreshed from the chain if stale. */
export async function groupFor(id: string, userId: string) {
  const g = getGroup(id);
  if (!g || !g.onChainId) throw new GroupMoneyError("Not found", 404);
  const stale = !g.syncedAt || Date.now() - Date.parse(g.syncedAt) > 15_000;
  if (g.kind === "circle") {
    if (!g.memberIds.includes(userId)) throw new GroupMoneyError("This circle is private to its members", 403);
    if (stale) await syncCircle(g).catch(() => g);
    return circleView(g, userId);
  }
  if (stale) await syncPot(g).catch(() => g);
  return potView(g, userId);
}

/** What anyone with the link sees of a pot. Circles are private. */
export async function publicPotView(id: string) {
  const g = getGroup(id);
  if (!g || g.kind !== "pot" || !g.onChainId) return null;
  const stale = !g.syncedAt || Date.now() - Date.parse(g.syncedAt) > 30_000;
  if (stale) await syncPot(g).catch(() => g);
  return potView(g);
}
