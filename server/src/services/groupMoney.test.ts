import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData } from "viem";

// Isolated data directory and contracts, set before config is first imported.
const scratch = mkdtempSync(join(tmpdir(), "evabob-groups-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
const CIRCLES = "0x482497289a4F5197f67f98B2535cd23D6238d256";
const POTS = "0x3CBDdab2398e06d5FB496a9DbF9424abD449D795";
process.env.MONEY_CIRCLES_ADDRESS = CIRCLES;
process.env.GROUP_POTS_ADDRESS = POTS;

const { store } = await import("../store/db.js");
const { groupPotsAbi, moneyCirclesAbi } = await import("../abis/groupMoney.js");
const { GroupMoneyError, prepareCircle, preparePot, potView, circleView } = await import("./groupMoney.js");

function user(handle: string, hex: string) {
  const id = `g-${handle}`;
  store.upsertUser({ id, email: `${handle}@example.com`, displayName: handle, evmAddress: "0x" + hex.repeat(40) });
  store.getUser(id)!.handle = handle;
  return id;
}

const organizer = user("organizer", "1");
user("ada", "2");
user("bola", "3");

test("a circle is created with its members in payout order", async () => {
  // The organizer is not a member here, so no chain read is needed.
  const { record, calls } = await prepareCircle(organizer, {
    name: "  Friday   ajo ",
    contributionUsdc: 10,
    every: "week",
    members: ["@ada", "@bola"],
  });
  assert.equal(record.name, "Friday ajo");
  assert.equal(record.state, "draft");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, CIRCLES);
  const decoded = decodeFunctionData({ abi: moneyCirclesAbi, data: calls[0]!.data });
  assert.equal(decoded.functionName, "createCircle");
  const [contribution, roundSeconds, , members] = decoded.args as readonly [bigint, bigint, bigint, readonly string[]];
  assert.equal(contribution, 10_000_000n);
  assert.equal(roundSeconds, 7n * 24n * 60n * 60n);
  assert.deepEqual(members.map((m) => m.toLowerCase()), ["0x" + "2".repeat(40), "0x" + "3".repeat(40)]);

  // The view never shows a draft as if it were running.
  const view = circleView(record, "g-ada");
  assert.equal(view.rounds, 2);
  assert.equal(view.potUsdc, 20);
  assert.equal(view.me?.place, 1);
});

test("a circle needs real, distinct people and a sensible amount", async () => {
  const bad = (input: Partial<Parameters<typeof prepareCircle>[1]>) =>
    assert.rejects(
      prepareCircle(organizer, { name: "x", contributionUsdc: 10, every: "week", members: ["@ada", "@bola"], ...input }),
      GroupMoneyError,
    );
  await bad({ members: ["@ada"] });
  await bad({ members: ["@ada", "@ada"] });
  await bad({ members: ["@ada", "@nobody-here"] });
  await bad({ contributionUsdc: 0.5 });
  await bad({ name: "   " });
});

test("a pot pays its beneficiary, and contributions are exact approvals", () => {
  const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { record, calls } = preparePot(organizer, {
    title: "Mama Titi's hospital bill",
    targetUsdc: 250,
    deadline,
    beneficiary: "@ada",
  });
  assert.equal(record.beneficiaryAddress, "0x" + "2".repeat(40));
  const decoded = decodeFunctionData({ abi: groupPotsAbi, data: calls[0]!.data });
  assert.equal(decoded.functionName, "createPot");
  assert.equal((decoded.args as readonly unknown[])[1], 250_000_000n);

  // Anyone may see a pot's progress, but not its contributors' addresses.
  const view = potView(record);
  assert.equal(view.beneficiary, "@ada");
  assert.equal("myContributionUsdc" in view, false);
  assert.match(view.url, /\/g\/p_/);

  assert.throws(() => preparePot(organizer, { title: "x", targetUsdc: 10, deadline: new Date().toISOString() }), GroupMoneyError);
  assert.throws(() => preparePot(organizer, { title: "x", targetUsdc: 10, deadline, beneficiary: "@nobody-here" }), GroupMoneyError);
});
