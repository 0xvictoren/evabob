/**
 * Telling sellers about a request ("pinging"), five at a time.
 *
 * The first five are told when the request is posted. If seven hours pass
 * and no seller has said they are available — and the buyer has messaged
 * nobody — the next five are told, for up to four rounds. Run from the
 * scheduled tick; idempotent, because each round records who was told.
 */

import { store } from "../store/db.js";
import * as market from "./market.js";
import { alertUser } from "./notifyUser.js";

const money = (n: number) => `$${n.toFixed(2)}`;

/** Tells the next batch of sellers about a want. Returns how many were told. */
export function pingSellers(want: market.MarketPost, now = Date.now()): number {
  const asker = store.getUser(want.ownerId);
  const sellers = market.nextSellersToPing(want, now);
  for (const sellerId of sellers) {
    alertUser(sellerId, {
      kind: "market_match",
      title: "Someone near you needs what you sell",
      body:
        `${asker?.handle ? `@${asker.handle}` : "Someone"} wants "${want.title}" and will pay up to ${money(want.priceUsd)}. ` +
        "Say you are available and they can message you.",
      link: `evabob://market/${want.id}`,
    });
  }
  return sellers.length;
}

/** The scheduled step: widen every request that has waited long enough. */
export function widenMarketPings(now = Date.now()): { widened: number; told: number } {
  let widened = 0;
  let told = 0;
  for (const want of market.wantsToWiden(now)) {
    const n = pingSellers(want, now);
    widened += 1;
    told += n;
  }
  return { widened, told };
}
