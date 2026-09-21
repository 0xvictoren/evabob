/**
 * Push notifications that reach a phone whose app is closed.
 *
 * Pusher alerts (notifyUser.ts) reach the app only while it is running or
 * backgrounded. Everything the held-payment rules depend on — "the work was
 * delivered, you have 7 days", "releases tomorrow", "your payer cancelled",
 * money arriving, a bridge finished for you — has to reach someone who is not
 * holding the phone. That needs FCM (which also delivers to iPhones through
 * APNs, once an APNs key is uploaded to the Firebase project).
 *
 * This speaks the FCM HTTP v1 API directly with a service-account token, so
 * it adds no SDK. It is off until FIREBASE_SERVICE_ACCOUNT_JSON is set; every
 * alert then goes out both ways, and the app collapses the two copies into
 * one notification by a shared tag.
 *
 * Devices are stored in push-devices.json, part of the Mongo snapshot, so a
 * registration made on one server instance is visible to all of them.
 */

import { existsSync, readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { dataPath } from "../utils/data-path.js";
import { writeJsonAtomic } from "../utils/write-json-atomic.js";
import { markPrimaryStoreDirty } from "./primary-store.js";

export type PushDevice = {
  token: string;
  userId: string;
  platform: "android" | "ios";
  createdAt: string;
  lastSeenAt: string;
};

export type PushMessage = {
  title: string;
  body: string;
  /** Shared with the Pusher copy so the phone shows one notification. */
  tag: string;
  /** Opaque strings the app uses to open the right screen. */
  data?: Record<string, string | undefined>;
};

const DEVICES_PATH = dataPath("push-devices.json");

/** A person rarely has more phones than this; older registrations drop off. */
const MAX_DEVICES_PER_USER = 5;

function load(): PushDevice[] {
  try {
    if (!existsSync(DEVICES_PATH)) return [];
    const rows = JSON.parse(readFileSync(DEVICES_PATH, "utf8")) as PushDevice[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function save(rows: PushDevice[]) {
  writeJsonAtomic(DEVICES_PATH, rows);
  markPrimaryStoreDirty();
}

/**
 * Registers a phone for a user. A token is unique to one app install, so
 * registering it moves it: when someone signs out and a different person signs
 * in on the same phone, the first person's alerts must stop arriving there.
 */
export function registerPushDevice(input: {
  userId: string;
  token: string;
  platform: "android" | "ios";
}): PushDevice {
  const now = new Date().toISOString();
  const rows = load().filter((d) => d.token !== input.token);
  const device: PushDevice = {
    token: input.token,
    userId: input.userId,
    platform: input.platform,
    createdAt: now,
    lastSeenAt: now,
  };
  const mine = rows
    .filter((d) => d.userId === input.userId)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const keep = new Set(mine.slice(0, MAX_DEVICES_PER_USER - 1).map((d) => d.token));
  const next = [
    ...rows.filter((d) => d.userId !== input.userId || keep.has(d.token)),
    device,
  ];
  save(next);
  return device;
}

/** Removes a phone, e.g. on sign-out. Only the owner's own registration. */
export function unregisterPushDevice(userId: string, token: string): boolean {
  const rows = load();
  const next = rows.filter((d) => !(d.token === token && d.userId === userId));
  if (next.length === rows.length) return false;
  save(next);
  return true;
}

export function unregisterAllPushDevices(userId: string): number {
  const rows = load();
  const next = rows.filter((device) => device.userId !== userId);
  const removed = rows.length - next.length;
  if (removed) save(next);
  return removed;
}

export function listPushDevices(userId: string): PushDevice[] {
  return load().filter((d) => d.userId === userId);
}

function dropToken(token: string) {
  const rows = load();
  const next = rows.filter((d) => d.token !== token);
  if (next.length !== rows.length) save(next);
}

// ─── FCM credentials ──────────────────────────────────────────────────────

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

let account: ServiceAccount | null | undefined;

/** Accepts the service-account JSON as-is or base64-encoded (easier in env UIs). */
export function parseServiceAccount(raw: string): ServiceAccount | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const json = text.startsWith("{")
      ? text
      : Buffer.from(text, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      // Env UIs often store the key with literal "\n" sequences.
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
    };
  } catch {
    return null;
  }
}

function serviceAccount(): ServiceAccount | null {
  if (account === undefined) {
    account = parseServiceAccount(config.push.serviceAccountJson);
    if (config.push.serviceAccountJson && !account) {
      console.warn("!! FIREBASE_SERVICE_ACCOUNT_JSON is set but unreadable — push disabled.");
    }
  }
  return account;
}

export function pushConfigured(): boolean {
  return serviceAccount() !== null;
}

let accessToken: { value: string; expiresAtMs: number } | null = null;

async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.expiresAtMs - 60_000 > Date.now()) {
    return accessToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
    { algorithm: "RS256" },
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM token exchange failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = {
    value: data.access_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** The FCM v1 message for one device. Exported for tests. */
export function fcmMessage(device: PushDevice, message: PushMessage) {
  const data = Object.fromEntries(
    Object.entries({ ...message.data, tag: message.tag }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    message: {
      token: device.token,
      notification: {
        title: "Evabob",
        body: "You have a new private update.",
      },
      data,
      android: {
        priority: "HIGH",
        notification: {
          // Money arriving plays the app's money-in sound, from a channel the
          // app creates with it; everything else uses the phone's default.
          channel_id: data.moneyIn === "1" ? "evabob_money_in" : "evabob_money",
          ...(data.moneyIn === "1" ? { sound: "money_in" } : {}),
          tag: message.tag,
        },
      },
      apns: {
        headers: { "apns-collapse-id": message.tag.slice(0, 64) },
        payload: { aps: { sound: "default" } },
      },
    },
  };
}

/** FCM's answer meaning this token will never work again. */
function isDeadToken(status: number, body: string): boolean {
  return (
    status === 404 ||
    /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(body)
  );
}

/**
 * Sends to every phone a user has registered. Never throws: like the Pusher
 * alert, a missed push costs a notification, never the operation that raised
 * it. Tokens FCM reports as dead are removed.
 */
export async function sendPush(userId: string, message: PushMessage): Promise<number> {
  const sa = serviceAccount();
  if (!sa) return 0;
  const devices = listPushDevices(userId);
  if (devices.length === 0) return 0;
  let sent = 0;
  try {
    const token = await fcmAccessToken(sa);
    for (const device of devices) {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(fcmMessage(device, message)),
        },
      );
      if (res.ok) {
        sent += 1;
        continue;
      }
      const body = await res.text().catch(() => "");
      if (isDeadToken(res.status, body)) {
        dropToken(device.token);
      } else {
        console.warn(`[push] ${res.status} for ${userId}: ${body.slice(0, 160)}`);
      }
    }
  } catch (e) {
    console.warn("[push]", e instanceof Error ? e.message : e);
  }
  return sent;
}
