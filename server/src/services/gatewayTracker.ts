/**
 * Keeps track of Gateway money in flight, so it is never lost track of.
 *
 * Two things used to be fire-and-forget:
 *
 *  - A GA payment whose destination mint did not happen inside the request.
 *    The route answered "in transit — do not retry" and kept nothing. The
 *    attestation that could still finish the mint existed only in that one
 *    response, and Circle's attestations expire after about 10 minutes. Now
 *    every such payment is recorded with its attestation; a pass mints it from
 *    the ops wallet while the attestation is valid, and otherwise asks Circle
 *    how the transfer ended.
 *
 *  - A GA top-up. The activity row was written before the person had even
 *    entered their PIN, so a cancelled top-up still said "Gateway deposit".
 *    Now the row is written when they have signed, and it flips to "arrived"
 *    only when Gateway actually credits the money — seconds from Arc, around
 *    40 minutes from Base Sepolia, and it has taken hours from Ethereum
 *    Sepolia. They are told either way.
 *
 * Records live in gateway-tracker.json, part of the Mongo snapshot. The pass
 * runs every minute in the local server, from /internal/cron/tick, and when
 * the person reopens the app.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { store } from "../store/db.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { alertUser } from "./notifyUser.js";
import { markPrimaryStoreDirty } from "./primary-store.js";

const MINUTE = 60 * 1000;

/** Circle attestations expire after ~10 minutes; stop minting a little early. */
export const ATTESTATION_MINT_WINDOW_MS = 9 * MINUTE;

/** A payment with neither attestation nor transfer id cannot be followed up. */
export const UNTRACEABLE_AFTER_MS = 30 * MINUTE;

/** A top-up nobody signed for is dropped quietly after this. */
export const UNSIGNED_TOPUP_TTL_MS = 2 * 60 * MINUTE;

/** A signed top-up not seen arriving after this is escalated to operators. */
export const TOPUP_OVERDUE_MS = 72 * 60 * MINUTE;

const DUST = 0.000_001;

export type GatewayPayRecord = {
  kind: "pay";
  id: string;
  userId: string;
  transferId?: string;
  attestation?: string;
  signature?: string;
  destinationDomain: number;
  destinationAddress: string;
  amountUsdc: number;
  status: "on_its_way" | "complete" | "not_sent" | "unknown";
  mintTx?: string;
  activityId?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type GatewayDepositWatch = {
  kind: "deposit";
  id: string;
  userId: string;
  /** The wallet whose Gateway balance on [domain] receives the deposit. */
  depositor: string;
  domain: number;
  amountUsdc: number;
  /** Credited + still-arriving balance on [domain] before the deposit. */
  baselineUsdc: number;
  /** Credited balance on [domain] before the deposit. */
  baselineCreditedUsdc: number;
  status: "awaiting_signature" | "submitted" | "credited" | "abandoned" | "overdue";
  activityId?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
};

type Row = GatewayPayRecord | GatewayDepositWatch;

const PATH = dataPath("gateway-tracker.json");

function load(): Row[] {
  try {
    if (!existsSync(PATH)) return [];
    const rows = JSON.parse(readFileSync(PATH, "utf8")) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(rows: Row[]) {
  // Settled rows are kept a week for support questions, then dropped.
  const cutoff = Date.now() - 7 * 24 * 60 * MINUTE;
  const kept = rows.filter(
    (r) =>
      !["complete", "not_sent", "credited", "abandoned"].includes(r.status) ||
      Date.parse(r.updatedAt) > cutoff,
  );
  writeJsonAtomic(PATH, kept);
  markPrimaryStoreDirty();
}

function update<T extends Row>(id: string, patch: Partial<T>): T | undefined {
  const rows = load();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return undefined;
  rows[i] = { ...rows[i]!, ...patch, updatedAt: new Date().toISOString() } as Row;
  save(rows);
  return rows[i] as T;
}

export function listTracked(userId?: string): Row[] {
  return load().filter((r) => !userId || r.userId === userId);
}

const chainName = (domain: number) =>
  ({ 26: "Arc", 0: "Ethereum", 6: "Base" } as Record<number, string>)[domain] ??
  "another network";

// ─── Pure decisions (tested) ──────────────────────────────────────────────

/** What to do next with a payment that has not landed. */
export function payNextStep(
  r: Pick<GatewayPayRecord, "status" | "attestation" | "signature" | "transferId" | "createdAt">,
  nowMs: number,
): "mint" | "ask_circle" | "give_up" | null {
  if (r.status !== "on_its_way") return null;
  const age = nowMs - Date.parse(r.createdAt);
  if (r.attestation && r.signature && age < ATTESTATION_MINT_WINDOW_MS) return "mint";
  if (r.transferId) return "ask_circle";
  return age >= UNTRACEABLE_AFTER_MS ? "give_up" : null;
}

/** How a top-up stands, from the Gateway balance on its domain. */
export function depositProgress(input: {
  baselineUsdc: number;
  baselineCreditedUsdc: number;
  amountUsdc: number;
  creditedUsdc: number;
  arrivingUsdc: number;
}): "not_seen" | "arriving" | "credited" {
  // A Gateway fee or rounding must not hide a real deposit; another deposit
  // landing at the same time must not fake one. Most of the amount is the bar.
  const bar = input.amountUsdc * 0.95 - DUST;
  if (input.creditedUsdc - input.baselineCreditedUsdc >= bar) return "credited";
  if (input.creditedUsdc + input.arrivingUsdc - input.baselineUsdc >= bar) {
    return "arriving";
  }
  return "not_seen";
}

// ─── Payments ─────────────────────────────────────────────────────────────

/**
 * Records a GA payment that did not finish inside the request, with the
 * pending activity row the person sees. Returns the record id.
 */
export function trackGatewayPay(input: {
  userId: string;
  transferId?: string;
  attestation?: string;
  signature?: string;
  destinationDomain: number;
  destinationAddress: string;
  amountUsdc: number;
  activityId?: string;
}): string {
  const now = new Date().toISOString();
  const row: GatewayPayRecord = {
    kind: "pay",
    id: randomUUID(),
    ...input,
    status: "on_its_way",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  save([...load(), row]);
  return row.id;
}

function settlePay(
  r: GatewayPayRecord,
  outcome: "complete" | "not_sent" | "unknown",
  mintTx?: string,
  note?: string,
) {
  update<GatewayPayRecord>(r.id, { status: outcome, ...(mintTx ? { mintTx } : {}) });
  const to = `${r.destinationAddress.slice(0, 6)}…${r.destinationAddress.slice(-4)}`;
  if (r.activityId) {
    store.updateActivity(r.activityId, {
      // "unknown" stays pending: the money may well have moved.
      ...(outcome === "unknown"
        ? {}
        : { status: outcome === "complete" ? ("completed" as const) : ("failed" as const) }),
      ...(mintTx ? { txHash: mintTx } : {}),
      description:
        outcome === "complete"
          ? `${r.amountUsdc} USDC from your GA · arrived on ${chainName(r.destinationDomain)}`
          : outcome === "not_sent"
            ? `${r.amountUsdc} USDC to ${to} did not go through, so nothing left your GA`
            : `${r.amountUsdc} USDC to ${to} · we are checking this one`,
    });
  }
  if (outcome === "complete") {
    alertUser(r.userId, {
      kind: "ga_payment_done",
      title: "Payment arrived",
      body: `${r.amountUsdc} USDC from your GA reached ${to} on ${chainName(r.destinationDomain)}.`,
      amountUsdc: r.amountUsdc,
      token: "USDC",
      ...(mintTx ? { txHash: mintTx } : {}),
    });
  } else {
    alertUser(r.userId, {
      kind: "ga_payment_failed",
      title: outcome === "not_sent" ? "Payment did not go through" : "We are checking a payment",
      body:
        outcome === "not_sent"
          ? `${r.amountUsdc} USDC to ${to} did not go through, so nothing left your GA. You can try again.`
          : `We could not confirm ${r.amountUsdc} USDC to ${to} yet. We are looking into it.`,
      amountUsdc: r.amountUsdc,
      token: "USDC",
    });
    if (outcome === "unknown") {
      for (const op of config.auth.operatorUserIds) {
        alertUser(op, {
          kind: "review_needed",
          title: "A GA payment needs checking",
          body: `${r.amountUsdc} USDC · ${note ?? "no transfer id or attestation to follow"}`,
        });
      }
    }
  }
}

async function advancePay(r: GatewayPayRecord, nowMs: number): Promise<string | null> {
  const step = payNextStep(r, nowMs);
  if (!step) return null;
  const { gatewayMintOnEvmDomain, readGatewayTransfer } = await import(
    "./gateway-e2e.js"
  );
  if (step === "mint") {
    update<GatewayPayRecord>(r.id, { attempts: r.attempts + 1 });
    try {
      const mintTx = await gatewayMintOnEvmDomain({
        domain: r.destinationDomain,
        attestation: r.attestation as `0x${string}`,
        signature: r.signature as `0x${string}`,
      });
      settlePay(r, "complete", mintTx);
      return "complete";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update<GatewayPayRecord>(r.id, { lastError: msg.slice(0, 300) });
      // Already minted — by the forwarder or an earlier pass. Ask Circle for
      // the mint rather than guessing.
      if (!/used|already|minted/i.test(msg) || !r.transferId) return null;
    }
  }
  if (step === "give_up") {
    settlePay(r, "unknown", undefined, "no transfer id or attestation to follow");
    return "unknown";
  }
  if (!r.transferId) return null;
  const polled = await readGatewayTransfer(r.transferId);
  const status = polled.status.toLowerCase();
  if (status === "confirmed" || status === "finalized") {
    settlePay(r, "complete", polled.mintTx);
    return "complete";
  }
  if (status === "failed" || status === "expired") {
    // Gateway only burns the source once the destination mint happens, so a
    // transfer that expired or failed before minting took nothing.
    settlePay(r, "not_sent");
    return "not_sent";
  }
  return null;
}

// ─── Top-ups ──────────────────────────────────────────────────────────────

async function readDomainBalance(depositor: string, domain: number) {
  const { fetchGatewayBalances } = await import("./gateway.js");
  const { balances } = await fetchGatewayBalances(depositor as `0x${string}`);
  const row = balances.find((b) => b.domain === domain);
  const usdc = (raw: string | undefined) => {
    const s = String(raw ?? "0").trim();
    if (!s) return 0;
    if (s.includes(".")) return Number(s) || 0;
    const n = Number(s);
    return Number.isFinite(n) ? n / 1e6 : 0;
  };
  return { credited: usdc(row?.balance), arriving: usdc(row?.pendingBatch) };
}

/**
 * Starts watching a top-up before the person signs for it. Nothing is shown
 * in their activity until [confirmTopUpSigned] — a cancelled PIN leaves no
 * trace. Returns the watch id.
 */
export async function startTopUpWatch(input: {
  userId: string;
  depositor: string;
  domain: number;
  amountUsdc: number;
}): Promise<string> {
  const now = new Date().toISOString();
  let baseline = { credited: 0, arriving: 0 };
  try {
    baseline = await readDomainBalance(input.depositor, input.domain);
  } catch {
    // Without a baseline the watch can still work from zero; it only makes an
    // unrelated earlier deposit able to look like this one.
  }
  const row: GatewayDepositWatch = {
    kind: "deposit",
    id: randomUUID(),
    ...input,
    baselineUsdc: baseline.credited + baseline.arriving,
    baselineCreditedUsdc: baseline.credited,
    status: "awaiting_signature",
    createdAt: now,
    updatedAt: now,
  };
  save([...load(), row]);
  return row.id;
}

function topUpRow(w: GatewayDepositWatch, txHash?: string) {
  return store.addActivity({
    userId: w.userId,
    kind: "fund",
    title: "Top up your GA",
    description: `${w.amountUsdc} USDC on its way from ${chainName(w.domain)}`,
    amountUsdc: w.amountUsdc,
    token: "USDC",
    amountToken: w.amountUsdc,
    status: "pending",
    mode: "gateway_deposit",
    ...(txHash ? { txHash } : {}),
  });
}

/** The person signed: show the top-up as on its way. Owner only. */
export function confirmTopUpSigned(input: {
  userId: string;
  watchId: string;
  txHash?: string;
}): GatewayDepositWatch | undefined {
  const w = load().find(
    (r): r is GatewayDepositWatch =>
      r.kind === "deposit" && r.id === input.watchId && r.userId === input.userId,
  );
  if (!w) return undefined;
  if (w.status !== "awaiting_signature") return w;
  const row = topUpRow(w, input.txHash);
  return update<GatewayDepositWatch>(w.id, {
    status: "submitted",
    activityId: row.id,
    ...(input.txHash ? { txHash: input.txHash } : {}),
  });
}

async function advanceTopUp(w: GatewayDepositWatch, nowMs: number): Promise<string | null> {
  if (w.status !== "awaiting_signature" && w.status !== "submitted") return null;
  const age = nowMs - Date.parse(w.createdAt);
  const now = await readDomainBalance(w.depositor, w.domain);
  const progress = depositProgress({
    baselineUsdc: w.baselineUsdc,
    baselineCreditedUsdc: w.baselineCreditedUsdc,
    amountUsdc: w.amountUsdc,
    creditedUsdc: now.credited,
    arrivingUsdc: now.arriving,
  });

  // Signed, but the app never said so (closed mid-flow): the money moving is
  // proof enough to show it.
  let current = w;
  if (progress !== "not_seen" && w.status === "awaiting_signature") {
    const row = topUpRow(w);
    current = update<GatewayDepositWatch>(w.id, { status: "submitted", activityId: row.id })!;
  }

  if (progress === "credited") {
    update<GatewayDepositWatch>(w.id, { status: "credited" });
    if (current.activityId) {
      store.updateActivity(current.activityId, {
        status: "completed",
        description: `${w.amountUsdc} USDC added to your GA from ${chainName(w.domain)}`,
      });
    }
    alertUser(w.userId, {
      kind: "ga_topup_arrived",
      title: "Your top-up arrived",
      body: `${w.amountUsdc} USDC from ${chainName(w.domain)} is in your GA and ready to spend.`,
      amountUsdc: w.amountUsdc,
      token: "USDC",
    });
    return "credited";
  }
  if (progress === "not_seen" && current.status === "awaiting_signature" && age > UNSIGNED_TOPUP_TTL_MS) {
    update<GatewayDepositWatch>(w.id, { status: "abandoned" });
    return "abandoned";
  }
  if (current.status === "submitted" && age > TOPUP_OVERDUE_MS) {
    update<GatewayDepositWatch>(w.id, { status: "overdue" });
    if (current.activityId) {
      store.updateActivity(current.activityId, {
        description: `${w.amountUsdc} USDC from ${chainName(w.domain)} · taking longer than it should — we are checking`,
      });
    }
    for (const op of config.auth.operatorUserIds) {
      alertUser(op, {
        kind: "review_needed",
        title: "A GA top-up is overdue",
        body: `${w.amountUsdc} USDC from ${chainName(w.domain)}, signed ${Math.round(age / 3_600_000)} hours ago, not credited.`,
      });
    }
    return "overdue";
  }
  return null;
}

// ─── The pass ─────────────────────────────────────────────────────────────

export type GatewayTrackerResult = {
  paymentsFinished: number;
  topUpsArrived: number;
  errors: string[];
};

/** Moves every open Gateway payment and top-up forward. Never throws. */
export async function runGatewayTracker(opts?: {
  onlyUserId?: string;
  now?: number;
}): Promise<GatewayTrackerResult> {
  const nowMs = opts?.now ?? Date.now();
  const result: GatewayTrackerResult = { paymentsFinished: 0, topUpsArrived: 0, errors: [] };
  for (const r of listTracked(opts?.onlyUserId)) {
    try {
      if (r.kind === "pay") {
        const out = await advancePay(r, nowMs);
        if (out === "complete") result.paymentsFinished += 1;
      } else {
        const out = await advanceTopUp(r, nowMs);
        if (out === "credited") result.topUpsArrived += 1;
      }
    } catch (e) {
      result.errors.push(`${r.kind} ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
