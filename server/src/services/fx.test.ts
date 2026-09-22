import assert from "node:assert/strict";
import test from "node:test";

import { fetchUsdRates, FIXED_USD_TO_NGN, fxConfigured } from "./fx.js";

test("FX uses the fixed product USD to NGN rate without provider configuration", async () => {
  const rates = await fetchUsdRates();

  assert.equal(FIXED_USD_TO_NGN, 1390);
  assert.equal(rates.ngn, 1390);
  assert.equal(rates.source, "fixed");
  assert.equal(fxConfigured(), true);
});
