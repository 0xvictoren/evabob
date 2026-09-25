/**
 * Tells a user something happened to their money, while they are in the app.
 *
 * Receiving was the one moment Evabob had nothing to say. Money arrived and
 * the app only noticed on the next manual refresh, so a person found out
 * whenever they next happened to look. Chat has had a real-time channel since
 * the beginning; money never did.
 *
 * Two channels carry every alert. A Pusher event on a channel named after the
 * user reaches the app while it is running or backgrounded. A push through
 * FCM (services/push.ts) reaches the phone when the app is closed, once a
 * Firebase project is configured. Both carry the same tag, so a phone that
 * gets both shows one notification.
 */

import { humanizeAmounts } from "../utils/money-text.js";
import { randomUUID } from "node:crypto";
import { pusherTrigger } from "./pusher.js";
import { sendPush } from "./push.js";
import { logPseudonym, safeError } from "../utils/safe-log.js";

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
  kind:
    | "money_in"
    | "hold_released"
    | "hold_waiting"
    /** The worker marked a job delivered; the payer has 7 days to object. */
    | "hold_delivered"
    /** One day left before a delivered job releases on its own. */
    | "hold_release_soon"
    /** A job hold expires within a week and nothing was marked delivered. */
    | "hold_expiring"
    /** The payer cancelled after delivery; a person will review it. */
    | "hold_under_review"
    /** Money that was held went back to the payer. */
    | "hold_refunded"
    /** An operator has a cancellation to review. */
    | "review_needed"
    /** A bridge the person left unfinished was completed by the server. */
    | "bridge_arrived"
    /**
     * A Gateway Account payment was just signed and sent. The server signs these as the
     * person's Gateway delegate, so this alert is how an unexpected one is
     * noticed at once.
     */
    | "ga_payment_sent"
    /** A Gateway Account payment that was still on its way has arrived. */
    | "ga_payment_done"
    /** A Gateway Account payment did not go through, or cannot be confirmed yet. */
    | "ga_payment_failed"
    /** A Gateway Account top-up has been credited and can be spent. */
    | "ga_topup_arrived"
    /** An invoice is due tomorrow, today, or is overdue. */
    | "invoice_due"
    /** Something happened in a money circle or group pot. */
    | "group_update"
    /** A chat message arrived. */
    | "chat_message"
    /** Someone paid, declined or cancelled a request. */
    | "request_update"
    /** An agent wants to spend above its owner's limit. Approve or decline. */
    | "agent_approval"
    /** An agent was paused: the loop breaker, or everything frozen. */
    | "agent_paused"
    /** A paid call failed its check, or a seller took money for nothing. */
    | "agent_payment_issue"
    /** An agent hired this person, or a task they took changed. */
    | "agent_task"
    /** Software paid for something this person sells through a paywall. */
    | "paywall_sale"
    /** Software asked to book this person's time; accept or decline. */
    | "paywall_booking"
    /** A new Dynamic subject requested explicit access to an older account. */
    | "account_recovery";
  title: string;
  body: string;
  amountUsdc?: number;
  token?: string;
  counterparty?: string;
  txHash?: string;
  /** Held-payment transfer id, so a tap can open that hold. */
  transferId?: string;
  /** App Kit job id, so a tap can open that bridge. */
  jobId?: string;
  /** An evabob:// link a tap opens, for alerts about anything else. */
  link?: string;
  /** The chat a message arrived in, so the app can badge it and skip the open one. */
  threadId?: string;
  /**
   * Money has just reached this person — received, released to them,
   * refunded to them, paid out to them. The app plays its money-in sound.
   */
  moneyIn?: boolean;
};

/**
 * Tells the person's open app that their balance just changed, so it reads
 * the new figure now rather than on the next pull to refresh. Silent: no
 * notification, no push — only the live channel.
 */
export function signalBalanceChanged(userId: string): void {
  if (!userId) return;
  void pusherTrigger(`${USER_CHANNEL_PREFIX}${userId}`, "balance", {
    kind: "balance_changed",
    at: new Date().toISOString(),
  }).catch(() => undefined);
}

/**
 * Sends an alert without making the caller wait or care whether it worked.
 *
 * Every caller is doing something that matters more than the notification —
 * recording an inbound transfer, releasing a hold — and none of them should
 * fail because Pusher is unreachable. A missed alert costs someone a pull to
 * refresh; a thrown error here would cost the operation itself.
 */
export function alertUser(userId: string, input: UserAlert): void {
  if (!userId) return;
  // Rounded dollars and euros, never "1.438849 USDC".
  const alert: UserAlert = {
    ...input,
    title: humanizeAmounts(input.title),
    body: humanizeAmounts(input.body),
  };
  const tag = `${alert.kind}:${alert.transferId ?? alert.jobId ?? alert.txHash ?? alert.link ?? randomUUID()}`;
  void sendPush(userId, {
    title: alert.title,
    body: alert.body,
    tag,
    data: {
      kind: alert.kind,
      transferId: alert.transferId,
      jobId: alert.jobId,
      txHash: alert.txHash,
      link: alert.link,
      threadId: alert.threadId,
      moneyIn: alert.moneyIn ? "1" : undefined,
    },
  });
  void pusherTrigger(`${USER_CHANNEL_PREFIX}${userId}`, "alert", {
    ...alert,
    tag,
    at: new Date().toISOString(),
  }).catch((e) => {
    console.warn(
      `[notify-user] ${alert.kind} user=${logPseudonym(userId) ?? "-"} failed:`,
      safeError(e),
    );
  });
}
