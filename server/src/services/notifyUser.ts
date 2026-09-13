/**
 * Tells a user something happened to their money, while they are in the app.
 *
 * Receiving was the one moment Evabob had nothing to say. Money arrived and
 * the app only noticed on the next manual refresh, so a person found out
 * whenever they next happened to look. Chat has had a real-time channel since
 * the beginning; money never did.
 *
 * This is a Pusher event on a channel named after the user, which the app
 * turns into a system notification. It reaches them while the app is running
 * or backgrounded, and not while it is force-quit — that needs FCM or APNs and
 * a Firebase project. Worth being plain about the limit rather than calling
 * this "push notifications" and letting someone assume it wakes a closed app.
 */

import { pusherTrigger } from "./pusher.js";

/**
 * Channel namespace for a single user's alerts.
 *
 * Exported because `canJoinChannel` in routes/api.ts authorises against it,
 * and the two must not be able to drift apart: the authorisation check is
 * exactly "the part after this prefix equals the caller's verified id".
 */
export const USER_CHANNEL_PREFIX = "private-user-";

export type UserAlert = {
  /** What happened, so the client can pick wording and a screen to open. */
  kind: "money_in" | "hold_released" | "hold_waiting";
  title: string;
  body: string;
  amountUsdc?: number;
  token?: string;
  counterparty?: string;
  txHash?: string;
};

/**
 * Sends an alert without making the caller wait or care whether it worked.
 *
 * Every caller is doing something that matters more than the notification —
 * recording an inbound transfer, releasing a hold — and none of them should
 * fail because Pusher is unreachable. A missed alert costs someone a pull to
 * refresh; a thrown error here would cost the operation itself.
 */
export function alertUser(userId: string, alert: UserAlert): void {
  if (!userId) return;
  void pusherTrigger(`${USER_CHANNEL_PREFIX}${userId}`, "alert", {
    ...alert,
    at: new Date().toISOString(),
  }).catch((e) => {
    console.warn(
      `[notify-user] ${alert.kind} → ${userId} failed:`,
      e instanceof Error ? e.message.split("\n")[0] : e,
    );
  });
}
