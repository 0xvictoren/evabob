/**
 * A PIN for every Gateway Account payment (GATEWAY_PAY_REQUIRE_PIN).
 *
 * Gateway Account payments are signed by the server as the person's Gateway delegate, so
 * without this a session token alone could spend the whole GA. With the switch
 * on, /v1/circle/gateway/pay does not send the payment: it asks Circle for a
 * message-signing challenge that names the payment, and parks the payment
 * here under that challenge id. The app runs the challenge (the person enters
 * their PIN and sees what they are approving) and then reports it through
 * /v1/circle/verify-challenges, which every installed build already calls
 * after a PIN. Only a challenge Circle reports COMPLETE, for the same person,
 * releases the payment — once.
 *
 * Parked payments live in memory only and expire after PIN_WINDOW_MS. A
 * restart simply drops them: nothing was sent, and the person pays again.
 */

import { config } from "../config.js";

export type ParkedGatewayPayment = {
  userId: string;
  depositor: `0x${string}`;
  amountUsdc: number;
  destinationDomain: number;
  destinationAddress: string;
  sourceDomain?: number;
  enableForwarder?: boolean;
  parkedAt: number;
};

/** How long a parked payment waits for its PIN. */
export const PIN_WINDOW_MS = 10 * 60 * 1000;

const parked = new Map<string, ParkedGatewayPayment>();

export function gatewayPayNeedsPin(): boolean {
  return config.features.gatewayPayPin;
}

/** The words the person sees on the PIN screen: what they are approving. */
export function pinMessageFor(input: { amountUsdc: number; destinationAddress: string }): string {
  const to = `${input.destinationAddress.slice(0, 6)}…${input.destinationAddress.slice(-4)}`;
  return `Evabob: pay ${input.amountUsdc} USDC from your Gateway Account to ${to}`;
}

function sweep(now: number) {
  for (const [id, row] of parked) {
    if (now - row.parkedAt > PIN_WINDOW_MS) parked.delete(id);
  }
}

export function parkForPin(
  challengeId: string,
  payment: Omit<ParkedGatewayPayment, "parkedAt">,
  now = Date.now(),
): void {
  sweep(now);
  parked.set(challengeId, { ...payment, parkedAt: now });
}

/** True when this challenge only confirms a parked Gateway Account payment (no transaction). */
export function isParkedChallenge(challengeId: string): boolean {
  return parked.has(challengeId);
}

/**
 * The payments whose PIN challenges Circle has confirmed COMPLETE for this
 * person. Each is handed out once and forgotten, so a repeated report cannot
 * send a payment twice.
 */
export function releaseConfirmed(
  userId: string,
  completedChallengeIds: string[],
  now = Date.now(),
): ParkedGatewayPayment[] {
  sweep(now);
  const out: ParkedGatewayPayment[] = [];
  for (const id of completedChallengeIds) {
    const row = parked.get(id);
    if (!row || row.userId !== userId) continue;
    parked.delete(id);
    out.push(row);
  }
  return out;
}

/** Tests only. */
export function __resetParkedPayments(): void {
  parked.clear();
}
