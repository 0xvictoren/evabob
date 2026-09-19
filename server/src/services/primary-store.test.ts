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
  appKitJobs: [],
  pushDevices: [],
  gatewayTracker: [],
  holdLinks: [],
  groupMoney: [],
  agentEvidence: [],
  paywalls: [],
  agentTasks: [],
};

test("accepts a complete primary-store snapshot", () => {
  assert.deepEqual(validatePrimaryDatasets(valid), valid);
});

test("loads a snapshot written before bridge jobs and devices were included", () => {
  // Snapshots already in Mongo predate these datasets. They must still load,
  // with the new datasets empty, rather than fail the whole restore.
  const {
    appKitJobs: _jobs,
    pushDevices: _devices,
    gatewayTracker: _gw,
    holdLinks: _links,
    groupMoney: _groups,
    agentEvidence: _evidence,
    paywalls: _paywalls,
    agentTasks: _tasks,
    ...older
  } = valid;
  assert.deepEqual(validatePrimaryDatasets(older), valid);
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
  assert.throws(
    () => validatePrimaryDatasets({ ...valid, appKitJobs: {} }),
    /appKitJobs must be an array/,
  );
});
