import { createHmac } from "node:crypto";
import { config } from "../config.js";

export function pusherConfigured() {
  return Boolean(
    config.pusher.appId && config.pusher.key && config.pusher.secret,
  );
}

export function authenticatePusherChannel(
  socketId: string,
  channelName: string,
  userData?: string,
): { auth: string; channel_data?: string } {
  if (!config.pusher.key || !config.pusher.secret) {
    throw new Error("Pusher not configured");
  }
  let stringToSign = `${socketId}:${channelName}`;
  if (userData) stringToSign += `:${userData}`;
  const signature = createHmac("sha256", config.pusher.secret)
    .update(stringToSign)
    .digest("hex");
  const auth = `${config.pusher.key}:${signature}`;
  return userData ? { auth, channel_data: userData } : { auth };
}

/** Trigger event on a channel via Pusher HTTP API */
export async function pusherTrigger(
  channel: string,
  event: string,
  data: unknown,
) {
  if (!pusherConfigured()) {
    console.warn("Pusher not configured — skip trigger", channel, event);
    return { skipped: true };
  }
  const body = JSON.stringify({
    name: event,
    channels: [channel],
    data: JSON.stringify(data),
  });
  const path = `/apps/${config.pusher.appId}/events`;
  const method = "POST";
  const authTimestamp = Math.floor(Date.now() / 1000);
  const authVersion = "1.0";
  const bodyMd5 = await md5(body);

  const query = new URLSearchParams({
    auth_key: config.pusher.key,
    auth_timestamp: String(authTimestamp),
    auth_version: authVersion,
    body_md5: bodyMd5,
  });
  // Sort params for signature
  const sorted = [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const stringToSign = `${method}\n${path}\n${sorted}`;
  const authSignature = createHmac("sha256", config.pusher.secret)
    .update(stringToSign)
    .digest("hex");
  query.set("auth_signature", authSignature);

  const host = `api-${config.pusher.cluster}.pusher.com`;
  const url = `https://${host}${path}?${query.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Pusher trigger failed ${res.status}: ${t}`);
  }
  return { ok: true };
}

async function md5(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(s).digest("hex");
}
