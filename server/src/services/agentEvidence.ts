/**
 * Evidence bundles for agent payments.
 *
 * When a counterparty argues — "your agent asked for this", "we sent it" —
 * the owner needs more than a line in a history list. Every paid call gets a
 * bundle recording three things, each timestamped:
 *
 *   authorised  what the owner allowed: the allowance, the tier that let the
 *               payment through, and the approval if one was needed
 *   asked       the exact request the agent made
 *   came back   what the seller returned: status, type, size, a SHA-256 of
 *               the whole body, and the start of it
 *
 * plus how the payment ended. The bundle is hashed over a canonical encoding,
 * and each one carries the previous bundle's hash for the same agent, so a
 * bundle altered after the fact no longer matches its hash and breaks the
 * chain after it. Exported as JSON with the recipe to recompute the hash.
 *
 * Also here: the check that decides whether a response was usable, which is
 * what "pay after proof" releases or refunds on.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { markPrimaryStoreDirty, registerPrimaryStoreReloader } from "./primary-store.js";

export const PREVIEW_BYTES = 8_192;

export type Verdict = { usable: boolean; reason: string };

export type EvidenceBundle = {
  id: string;
  version: 1;
  agentId: string;
  ownerId: string;
  paymentKey: string;
  createdAt: string;
  authorised: {
    owner: string;
    agent: { id: string; label: string; handle: string | null };
    allowance: string;
    tier: "silent" | "approved";
    approval: { id: string; decidedAt: string | null } | null;
    remainingBeforeUsdc: number;
    at: string;
  };
  asked: { method: "GET"; url: string; at: string };
  cameBack: {
    at: string;
    status: number | null;
    contentType: string | null;
    bytes: number;
    sha256: string | null;
    preview: string;
    verdict: Verdict;
  };
  payment: {
    amountUsdc: number;
    payTo: string | null;
    network: string | null;
    /** "proof": the seller took the money only after the check passed. */
    settlement: "proof" | "direct";
    outcome: "paid" | "not_charged" | "paid_not_delivered" | "unknown";
    settleReference: string | null;
  };
  prevHash: string | null;
  hash: string;
};

const DATA_PATH = dataPath("agent-evidence.json");
let bundles: EvidenceBundle[] = load();

function load(): EvidenceBundle[] {
  try {
    if (!existsSync(DATA_PATH)) return [];
    const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as EvidenceBundle[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(): void {
  writeJsonAtomic(DATA_PATH, bundles);
  markPrimaryStoreDirty();
}

registerPrimaryStoreReloader(() => {
  bundles = load();
});

/** JSON with keys sorted at every level, so the same bundle always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hash of a bundle: SHA-256 of its canonical JSON without the `hash` field. */
export function bundleHash(bundle: Omit<EvidenceBundle, "hash"> & { hash?: string }): string {
  const { hash: _drop, ...rest } = bundle;
  void _drop;
  return sha256(canonicalJson(rest));
}

const ERROR_ONLY_KEYS = new Set(["error", "errors", "message", "detail", "code", "status", "statusCode"]);

/**
 * Whether a seller's response is something the agent can use. Deliberately
 * plain: success status, something in the body, and — when it says it is
 * JSON — JSON that is not empty and not just an error.
 */
export function judgeResponse(input: {
  status: number | null | undefined;
  contentType?: string | null;
  body: string | null | undefined;
}): Verdict {
  const status = input.status ?? 0;
  if (status < 200 || status >= 300) {
    return { usable: false, reason: status ? `The seller answered HTTP ${status}.` : "The seller did not answer." };
  }
  const body = (input.body ?? "").trim();
  if (!body) return { usable: false, reason: "The seller returned nothing." };
  const saysJson = /json/i.test(input.contentType ?? "") || /^[[{]/.test(body);
  if (!saysJson) return { usable: true, reason: "The seller returned content." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return /json/i.test(input.contentType ?? "")
      ? { usable: false, reason: "The seller said JSON but sent something that is not." }
      : { usable: true, reason: "The seller returned content." };
  }
  if (parsed == null) return { usable: false, reason: "The seller returned an empty answer." };
  if (Array.isArray(parsed)) {
    return parsed.length === 0
      ? { usable: false, reason: "The seller returned an empty list." }
      : { usable: true, reason: "The seller returned data." };
  }
  if (typeof parsed === "object") {
    const keys = Object.keys(parsed as object);
    if (keys.length === 0) return { usable: false, reason: "The seller returned an empty answer." };
    if (keys.every((k) => ERROR_ONLY_KEYS.has(k)) && keys.some((k) => k === "error" || k === "errors")) {
      return { usable: false, reason: "The seller returned an error instead of data." };
    }
  }
  return { usable: true, reason: "The seller returned data." };
}

export function newEvidenceId(): string {
  return `ev_${randomBytes(12).toString("hex")}`;
}

/** Stores a bundle, linking it to the agent's previous one, and returns it. */
export function recordEvidence(
  draft: Omit<EvidenceBundle, "id" | "version" | "prevHash" | "hash" | "createdAt"> & { id?: string },
): EvidenceBundle {
  const previous = [...bundles].reverse().find((b) => b.agentId === draft.agentId);
  const withoutHash: Omit<EvidenceBundle, "hash"> = {
    ...draft,
    id: draft.id ?? newEvidenceId(),
    version: 1,
    createdAt: new Date().toISOString(),
    prevHash: previous?.hash ?? null,
  };
  const bundle: EvidenceBundle = { ...withoutHash, hash: bundleHash(withoutHash) };
  bundles.push(bundle);
  save();
  return bundle;
}

/**
 * Records how a held payment ended, as a new bundle rather than an edit, so
 * the one that was hashed at the time stays exactly as it was.
 */
export function recordOutcome(
  original: EvidenceBundle,
  payment: Partial<EvidenceBundle["payment"]>,
): EvidenceBundle {
  const { id: _id, hash: _hash, prevHash: _prev, createdAt: _at, version: _v, ...rest } = original;
  void _id; void _hash; void _prev; void _at; void _v;
  return recordEvidence({ ...rest, payment: { ...original.payment, ...payment } });
}

export function getEvidence(id: string): EvidenceBundle | null {
  return bundles.find((b) => b.id === id) ?? null;
}

export function evidenceForPayment(agentId: string, paymentKey: string): EvidenceBundle[] {
  return bundles.filter((b) => b.agentId === agentId && b.paymentKey === paymentKey);
}

/** Every bundle for payments to one seller origin: its delivery record. */
export function evidenceForSeller(origin: string): EvidenceBundle[] {
  const o = origin.toLowerCase();
  return bundles.filter((b) => {
    try {
      return new URL(b.asked.url).origin.toLowerCase() === o;
    } catch {
      return false;
    }
  });
}

/**
 * What the owner downloads: the bundles for one payment, and how anyone can
 * check them without trusting Evabob's word.
 */
export function exportEvidence(agentId: string, paymentKey: string) {
  const rows = evidenceForPayment(agentId, paymentKey);
  return {
    kind: "evabob.agent-payment-evidence",
    exportedAt: new Date().toISOString(),
    howToVerify:
      "For each bundle, remove the `hash` field, serialise the rest as JSON with object keys " +
      "sorted at every level and no whitespace, and take the SHA-256 of the UTF-8 bytes. It " +
      "must equal `hash`. `prevHash` is the hash of the same agent's previous bundle. " +
      "`cameBack.sha256` is the SHA-256 of the full response body the seller returned.",
    bundles: rows.map((b) => ({ ...b, hashMatches: bundleHash(b) === b.hash })),
  };
}

/** The response part of a bundle, from the raw response. */
export function cameBackFrom(input: {
  status: number | null | undefined;
  contentType?: string | null;
  body: string | null | undefined;
  verdict?: Verdict;
}): EvidenceBundle["cameBack"] {
  const body = input.body ?? "";
  return {
    at: new Date().toISOString(),
    status: input.status ?? null,
    contentType: input.contentType ?? null,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: input.body == null ? null : sha256(body),
    preview: body.slice(0, PREVIEW_BYTES),
    verdict: input.verdict ?? judgeResponse(input),
  };
}
