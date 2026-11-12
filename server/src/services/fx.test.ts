import assert from "node:assert/strict";
import test from "node:test";

import { CURRENCIES, currencyOf, fetchUsdRates, getCachedFx, parseFeed, setFxForTests } from "./fx.js";

test("before the feed has ever answered, rough rates are used so amounts still show", () => {
  setFxForTests(null);
  const rates = getCachedFx();
  assert.equal(rates.source, "fallback");
  assert.equal(rates.rates.USD, 1);
  for (const c of CURRENCIES) assert.ok(rates.rates[c.code]! > 0, c.code);
});

test("a feed answer becomes the rates; a broken or foreign-based one is refused", () => {
  const parsed = parseFeed({ base_code: "USD", time_last_update_unix: 1_794_441_751, rates: { USD: 1, NGN: 1432.5, GHS: 11.2, BAD: "x" } });
  assert.equal(parsed?.rates.NGN, 1432.5);
  assert.equal(parsed?.rates.BAD, undefined);
  assert.equal(parsed?.at.toISOString(), new Date(1_794_441_751_000).toISOString());
  assert.equal(parseFeed({ base_code: "EUR", rates: { NGN: 1700 } }), null);
  assert.equal(parseFeed({ rates: { GHS: 11 } }), null);
  assert.equal(parseFeed("nope"), null);
});

test("live rates are served from memory, and a missing currency keeps its last rate", async () => {
  setFxForTests({ NGN: 1432.5, GHS: 11.2, EUR: 0.9 });
  const rates = await fetchUsdRates();
  assert.equal(rates.source, "live");
  assert.equal(rates.ngn, 1432.5);
  assert.equal(rates.rates.GHS, 11.2);
  assert.ok(rates.rates.KES! > 0);
  setFxForTests(null);
});

test("a currency is found by its code, whatever the case", () => {
  assert.equal(currencyOf("ngn")?.symbol, "₦");
  assert.equal(currencyOf("ghs")?.name, "Ghanaian cedi");
  assert.equal(currencyOf("XXX"), undefined);
});
