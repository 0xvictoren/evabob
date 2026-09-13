import assert from "node:assert/strict";
import test from "node:test";
import { validatePrimaryDatasets } from "./primary-store.js";

const valid = {
  app: {
    users: [],
    activity: [],
    threads: [],
    messages: [],
    transfers: [],
    agents: [],
    contacts: [],
  },
  paymentRequests: [],
  protectedEscrows: [],
};

test("accepts a complete primary-store snapshot", () => {
  assert.deepEqual(validatePrimaryDatasets(valid), valid);
});

test("rejects partial snapshots instead of erasing omitted financial data", () => {
  assert.throws(
    () => validatePrimaryDatasets({ ...valid, app: { users: [] } }),
    /app\.activity must be an array/,
  );
  assert.throws(
    () => validatePrimaryDatasets({ ...valid, paymentRequests: {} }),
    /paymentRequests must be an array/,
  );
});
