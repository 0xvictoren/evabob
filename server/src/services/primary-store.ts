import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dataPath } from "../utils/data-path.js";
import {
  mongoLoadPrimaryStore,
  mongoPrimaryStoreGeneration,
  mongoReady,
  mongoSavePrimaryStore,
  PrimaryStoreConflict,
  type PrimaryStoreDatasets,
} from "./mongo.js";

const paths = {
  app: dataPath("evabob-db.json"),
  paymentRequests: dataPath("payment-requests.json"),
  protectedEscrows: dataPath("protected-escrows.json"),
  // Bridges in flight used to live only in this file on local disk. On a
  // serverless host every instance has its own disk, so a bridge started on
  // one could not be found, finished or recovered from another — money
  // between chains with no job to finish it. They belong in the snapshot.
  appKitJobs: dataPath("app-kit-jobs.json"),
  pushDevices: dataPath("push-devices.json"),
  gatewayTracker: dataPath("gateway-tracker.json"),
  holdLinks: dataPath("hold-links.json"),
  groupMoney: dataPath("group-money.json"),
} as const;

/** Datasets added after the first snapshot: absent means "none yet". */
const LATER_DATASETS = [
  "appKitJobs",
  "pushDevices",
  "gatewayTracker",
  "holdLinks",
  "groupMoney",
] as const;

const emptyApp = {
  users: [],
  activity: [],
  threads: [],
  messages: [],
  transfers: [],
  agents: [],
  contacts: [],
};

let generation = 0;
let persistedGeneration = 0;
let lastChecksum = "";
let flushTail: Promise<void> = Promise.resolve();
let lastError: string | null = null;
/**
 * The Mongo snapshot generation this process last loaded or saved. Saves are
 * conditional on it, so another instance's write is detected, not overwritten.
 * Null until something has been saved.
 */
let remoteGeneration: number | null = null;
/** Set when a save lost a race; the next request reloads before it runs. */
let stale = false;

/**
 * Modules that hold a dataset in memory register here to re-read it after
 * the snapshot is reloaded from Mongo. Files read on every call need not.
 */
const reloaders: Array<() => void> = [];
export function registerPrimaryStoreReloader(fn: () => void): void {
  reloaders.push(fn);
}

function readJson(path: string, fallback: unknown): unknown {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Mongo primary store has an invalid ${name} dataset`);
  }
}

export function validatePrimaryDatasets(value: unknown): PrimaryStoreDatasets {
  assertRecord(value, "root");
  const app = value.app;
  assertRecord(app, "app");
  for (const key of [
    "users",
    "activity",
    "threads",
    "messages",
    "transfers",
    "agents",
    "contacts",
  ]) {
    if (!Array.isArray(app[key])) {
      throw new Error(`Mongo primary store app.${key} must be an array`);
    }
  }
  if (!Array.isArray(value.paymentRequests)) {
    throw new Error("Mongo primary store paymentRequests must be an array");
  }
  if (!Array.isArray(value.protectedEscrows)) {
    throw new Error("Mongo primary store protectedEscrows must be an array");
  }
  // Added later, so a snapshot without them is valid and means "none".
  for (const key of LATER_DATASETS) {
    if (value[key] != null && !Array.isArray(value[key])) {
      throw new Error(`Mongo primary store ${key} must be an array`);
    }
  }
  return {
    app,
    paymentRequests: value.paymentRequests,
    protectedEscrows: value.protectedEscrows,
    ...Object.fromEntries(LATER_DATASETS.map((key) => [key, value[key] ?? []])),
  };
}

function readLocalDatasets(): PrimaryStoreDatasets {
  return validatePrimaryDatasets({
    app: readJson(paths.app, emptyApp),
    paymentRequests: readJson(paths.paymentRequests, []),
    protectedEscrows: readJson(paths.protectedEscrows, []),
    ...Object.fromEntries(LATER_DATASETS.map((key) => [key, readJson(paths[key], [])])),
  });
}

function checksum(datasets: PrimaryStoreDatasets): string {
  return createHash("sha256")
    .update(JSON.stringify(datasets))
    .digest("hex");
}

function restoreLocal(datasets: PrimaryStoreDatasets): void {
  writeJsonAtomic(paths.app, datasets.app);
  writeJsonAtomic(paths.paymentRequests, datasets.paymentRequests);
  writeJsonAtomic(paths.protectedEscrows, datasets.protectedEscrows);
  for (const key of LATER_DATASETS) writeJsonAtomic(paths[key], datasets[key] ?? []);
}

/**
 * Must run before importing db.ts, payment-requests.ts, escrow-jobs.ts,
 * appKitMoney.ts or push.ts — each loads its file into memory on import.
 */
export async function initializePrimaryStore(): Promise<{
  mode: "mongo" | "json";
  restored: boolean;
}> {
  const local = readLocalDatasets();
  if (!mongoReady()) {
    lastChecksum = checksum(local);
    return { mode: "json", restored: false };
  }

  const remote = await mongoLoadPrimaryStore();
  if (remote) {
    applyRemote(remote);
    generation = 0;
    persistedGeneration = 0;
    lastError = null;
    return { mode: "mongo", restored: true };
  }

  lastChecksum = checksum(local);
  remoteGeneration = await mongoSavePrimaryStore(local, lastChecksum, null);
  generation = 0;
  persistedGeneration = 0;
  lastError = null;
  return { mode: "mongo", restored: false };
}

function applyRemote(remote: {
  checksum: string;
  datasets: PrimaryStoreDatasets;
  generation: number;
}): void {
  const datasets = validatePrimaryDatasets(remote.datasets);
  // Checksummed over the validated shape. A snapshot written before newer
  // datasets existed is validated with them added as empty lists, which
  // changes its hash; only then fall back to the stored bytes' own hash.
  const actualChecksum = checksum(datasets);
  if (
    remote.checksum !== actualChecksum &&
    remote.checksum !== checksum(remote.datasets as PrimaryStoreDatasets)
  ) {
    throw new Error("Mongo primary store checksum mismatch");
  }
  restoreLocal(datasets);
  lastChecksum = actualChecksum;
  remoteGeneration = remote.generation;
  stale = false;
}

/**
 * Brings this process up to date if another instance has saved since.
 *
 * Runs before each request. It costs one small read of the snapshot head;
 * the full snapshot is only fetched when the generation moved. It never
 * discards unsaved local changes — if there are any, the save that follows
 * will detect the conflict instead.
 */
export async function refreshPrimaryStoreIfStale(): Promise<boolean> {
  if (!mongoReady()) return false;
  if (generation > persistedGeneration) return false;
  const head = await mongoPrimaryStoreGeneration();
  if (head == null) return false;
  if (!stale && head === remoteGeneration) return false;
  const remote = await mongoLoadPrimaryStore();
  if (!remote) return false;
  applyRemote(remote);
  for (const reload of reloaders) {
    try {
      reload();
    } catch (e) {
      console.error("[store] reload failed", e);
    }
  }
  return true;
}

/** Called by every JSON-backed store mutation. */
export function markPrimaryStoreDirty(): void {
  generation += 1;
}

async function flushLatest(): Promise<void> {
  if (!mongoReady()) return;
  while (persistedGeneration < generation) {
    const target = generation;
    const datasets = readLocalDatasets();
    const nextChecksum = checksum(datasets);
    if (nextChecksum !== lastChecksum) {
      try {
        remoteGeneration = await mongoSavePrimaryStore(
          datasets,
          nextChecksum,
          remoteGeneration,
        );
      } catch (error) {
        // Another instance saved first. Refuse to overwrite it: the request
        // fails as not durably recorded, and the next one reloads first.
        if (error instanceof PrimaryStoreConflict) stale = true;
        throw error;
      }
      lastChecksum = nextChecksum;
    }
    persistedGeneration = target;
  }
  lastError = null;
}

/** Serialises concurrent flushes so an older snapshot cannot win a race. */
export function flushPrimaryStore(): Promise<void> {
  const run = flushTail.catch(() => undefined).then(flushLatest);
  flushTail = run.catch(() => undefined);
  return run.catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  });
}

export function primaryStoreHealth(): {
  mode: "mongo" | "json";
  pending: boolean;
  error: string | null;
  generation: number | null;
} {
  return {
    mode: mongoReady() ? "mongo" : "json",
    pending: generation > persistedGeneration,
    error: lastError,
    generation: remoteGeneration,
  };
}
