import { createHmac } from "node:crypto";
import { config } from "../config.js";

/**
 * Pusher private channel auth signature.
 * @see https://pusher.com/docs/channels/server_api/authenticating-users/
 */
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

export function pusherConfigured() {
  return Boolean(
    config.pusher.appId && config.pusher.key && config.pusher.secret,
  );
}
