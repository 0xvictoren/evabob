import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dataPath } from "../utils/data-path.js";
import {
  mongoLoadPrimaryStore,
  mongoReady,
  mongoSavePrimaryStore,
  type PrimaryStoreDatasets,
} from "./mongo.js";

const paths = {
  app: dataPath("evabob-db.json"),
  paymentRequests: dataPath("payment-requests.json"),
  protectedEscrows: dataPath("protected-escrows.json"),
} as const;

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
  return {
    app,
    paymentRequests: value.paymentRequests,
    protectedEscrows: value.protectedEscrows,
  };
}

function readLocalDatasets(): PrimaryStoreDatasets {
  return validatePrimaryDatasets({
    app: readJson(paths.app, emptyApp),
    paymentRequests: readJson(paths.paymentRequests, []),
    protectedEscrows: readJson(paths.protectedEscrows, []),
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
}

/** Must run before importing db.ts, payment-requests.ts or escrow-jobs.ts. */
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
    const datasets = validatePrimaryDatasets(remote.datasets);
    const actualChecksum = checksum(datasets);
    if (remote.checksum !== actualChecksum) {
      throw new Error("Mongo primary store checksum mismatch");
    }
    restoreLocal(datasets);
    lastChecksum = actualChecksum;
    generation = 0;
    persistedGeneration = 0;
    lastError = null;
    return { mode: "mongo", restored: true };
  }

  lastChecksum = checksum(local);
  await mongoSavePrimaryStore(local, lastChecksum);
  generation = 0;
  persistedGeneration = 0;
  lastError = null;
  return { mode: "mongo", restored: false };
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
      await mongoSavePrimaryStore(datasets, nextChecksum);
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
} {
  return {
    mode: mongoReady() ? "mongo" : "json",
    pending: generation > persistedGeneration,
    error: lastError,
  };
}
