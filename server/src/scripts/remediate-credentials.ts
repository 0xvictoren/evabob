/**
 * One-time HTTP incident remediation.
 *
 * - revokes any agent record that ever persisted apiKeyFull;
 * - removes that field from local JSON and the authoritative Mongo snapshot;
 * - removes stale Mongo snapshot generations;
 * - forgets every Circle user-session fingerprint so a new authenticated
 *   application session must obtain fresh Circle material.
 *
 * Deliberately prints counts only. Credentials and affected identities must
 * never enter a terminal transcript or support bundle.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import {
  connectMongo,
  disconnectMongo,
  mongoForgetAllUcwSessions,
  mongoLoadPrimaryStore,
  mongoPurgePrimaryStoreHistory,
  mongoSavePrimaryStore,
  type PrimaryStoreDatasets,
} from "../services/mongo.js";
import { remediatePlaintextAgentKeys } from "../services/credential-remediation.js";

const revokedAt = process.env.SECURITY_INCIDENT_AT?.trim() || new Date().toISOString();

function checksum(datasets: PrimaryStoreDatasets): string {
  return createHash("sha256").update(JSON.stringify(datasets)).digest("hex");
}

let localRevoked = 0;
const localPath = dataPath("evabob-db.json");
if (existsSync(localPath)) {
  const local = JSON.parse(readFileSync(localPath, "utf8")) as Record<string, unknown>;
  const result = remediatePlaintextAgentKeys(local, revokedAt);
  localRevoked = result.revoked;
  if (result.firstRun) writeJsonAtomic(localPath, local);
}

let mongoRevoked = 0;
let deletedGenerations = 0;
let forgottenCircleSessions = 0;
const connected = await connectMongo();
if (connected.ok) {
  try {
    const remote = await mongoLoadPrimaryStore();
    if (remote) {
      const app = remote.datasets.app;
      if (!app || typeof app !== "object" || Array.isArray(app)) {
        throw new Error("Mongo primary store has an invalid app dataset");
      }
      const result = remediatePlaintextAgentKeys(
        app as Record<string, unknown>,
        revokedAt,
      );
      mongoRevoked = result.revoked;
      if (result.firstRun) {
        await mongoSavePrimaryStore(
          remote.datasets,
          checksum(remote.datasets),
          remote.generation,
        );
        deletedGenerations = await mongoPurgePrimaryStoreHistory();
        forgottenCircleSessions = await mongoForgetAllUcwSessions();
      }
    }
  } finally {
    await disconnectMongo();
  }
} else if (process.env.MONGODB_URI?.trim() || config.deploymentEnv !== "local") {
  throw new Error(`Mongo is required for credential remediation: ${connected.detail}`);
}

console.log(JSON.stringify({
  localPlaintextAgentKeysRevoked: localRevoked,
  mongoPlaintextAgentKeysRevoked: mongoRevoked,
  staleMongoSnapshotChunksDeleted: deletedGenerations,
  circleSessionFingerprintsDeleted: forgottenCircleSessions,
}));
