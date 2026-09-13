import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { dataPath } from "../utils/data-path.js";
import {
  mongoOwnsUcwSession,
  mongoReady,
  mongoRememberUcwSession,
} from "./mongo.js";

type SessionRecord = { userId: string; expiresAt: number };
type SessionFile = Record<string, SessionRecord>;

const fingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Persist token fingerprints without ever storing Circle credentials. */
export class UcwSessionStore {
  private sessions: SessionFile;

  constructor(private readonly path: string) {
    this.sessions = this.load();
  }

  private load(): SessionFile {
    try {
      if (!existsSync(this.path)) return {};
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as SessionFile
        : {};
    } catch {
      return {};
    }
  }

  private prune(now: number): boolean {
    let changed = false;
    for (const [key, session] of Object.entries(this.sessions)) {
      if (!session || session.expiresAt <= now) {
        delete this.sessions[key];
        changed = true;
      }
    }
    return changed;
  }

  remember(userId: string, token: string, now = Date.now()): void {
    this.prune(now);
    this.sessions[fingerprint(token)] = {
      userId,
      // Circle tokens last 60 minutes; expire the application binding first.
      expiresAt: now + 55 * 60_000,
    };
    writeJsonAtomic(this.path, this.sessions);
  }

  owns(userId: string, token: string, now = Date.now()): boolean {
    const changed = this.prune(now);
    const session = this.sessions[fingerprint(token)];
    if (changed) writeJsonAtomic(this.path, this.sessions);
    return Boolean(
      session && session.userId === userId && session.expiresAt > now,
    );
  }
}

const sessionStore = new UcwSessionStore(
  dataPath("ucw-session-fingerprints.json"),
);

export async function rememberUcwSession(
  userId: string,
  token: string,
  now = Date.now(),
) {
  sessionStore.remember(userId, token, now);
  if (mongoReady()) {
    await mongoRememberUcwSession(
      fingerprint(token),
      userId,
      new Date(now + 55 * 60_000),
    );
  }
}

export async function ownsUcwSession(
  userId: string,
  token: string,
  now = Date.now(),
) {
  if (sessionStore.owns(userId, token, now)) return true;
  return mongoReady()
    ? mongoOwnsUcwSession(fingerprint(token), userId, new Date(now))
    : false;
}
