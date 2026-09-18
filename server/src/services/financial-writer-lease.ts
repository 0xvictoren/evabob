import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { dataPath } from "../utils/data-path.js";
import {
  mongoAcquireWriterLease,
  mongoConfigured,
  mongoReady,
  mongoReleaseWriterLease,
  mongoRenewWriterLease,
} from "./mongo.js";

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLocalWriterLease(path: string): { release(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const leaseId = randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          leaseId,
          startedAt: new Date().toISOString(),
        }),
      );
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          // Do not remove a successor's lock if this lease was replaced after
          // a crash/recovery race or by an operator repairing the lock file.
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as {
              leaseId?: string;
            };
            if (current.leaseId === leaseId) unlinkSync(path);
          } catch { /* already removed or no longer ours */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let active = true;
      try {
        const row = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
        active = pidIsAlive(Number(row.pid));
      } catch {
        active = false;
      }
      if (active) {
        throw new Error(
          "Another Evabob server is already the financial JSON writer.",
        );
      }
      try { unlinkSync(path); } catch { /* raced with another process */ }
    }
  }
  throw new Error("Could not acquire the financial writer lease.");
}

export async function acquireFinancialWriterLease(): Promise<{
  release(): Promise<void>;
}> {
  const local = acquireLocalWriterLease(
    dataPath(".evabob-financial-writer.lock"),
  );
  const owner = `${process.pid}:${randomUUID()}`;
  const ttlMs = 45_000;
  let remote = false;

  // A serverless host freezes idle instances, so a lease cannot be kept
  // alive by a heartbeat and a second concurrent instance would crash at
  // start. There, the lease is advisory: correctness comes from the
  // generation-checked snapshot saves (mongo.ts), which refuse to overwrite
  // another instance's write instead of relying on being the only writer.
  const serverless = Boolean(process.env.VERCEL);
  try {
    if (mongoReady()) {
      remote = await mongoAcquireWriterLease(owner, ttlMs);
      if (!remote && serverless) {
        console.warn(
          "[store] another instance holds the writer lease; continuing with generation-checked saves",
        );
      } else if (!remote) {
        throw new Error(
          "Another Evabob instance holds the global financial writer lease.",
        );
      }
    } else if (mongoConfigured() && process.env.NODE_ENV === "production") {
      throw new Error(
        "MongoDB is configured but unavailable; refusing unsafe JSON fallback in production.",
      );
    }
  } catch (error) {
    local.release();
    throw error;
  }

  let released = false;
  const heartbeat = remote && !serverless
    ? setInterval(() => {
        void mongoRenewWriterLease(owner, ttlMs).then((ok) => {
          if (!ok) {
            console.error("[store] financial writer lease lost; exiting");
            process.exit(1);
          }
        }).catch((error) => {
          console.error("[store] financial writer lease heartbeat failed", error);
          process.exit(1);
        });
      }, 15_000)
    : undefined;
  heartbeat?.unref();

  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    if (remote) await mongoReleaseWriterLease(owner).catch(() => undefined);
    local.release();
  };
  process.once("exit", () => local.release());
  return { release };
}
