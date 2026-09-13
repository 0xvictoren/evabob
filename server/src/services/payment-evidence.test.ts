import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { verifyPaymentEvidence } from "./payment-evidence.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const USDC = "0x3600000000000000000000000000000000000000";
const TX = `0x${"ab".repeat(32)}`;
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

const topic = (address: string) =>
  `0x${address.slice(2).padStart(64, "0")}` as Hex;

function reader(blockTimestamp: number, includeBlockReader = true) {
  return {
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 10n,
      logs: [{
        address: USDC,
        topics: [TRANSFER_TOPIC, topic(SENDER), topic(RECIPIENT)] as const,
        data: encodeAbiParameters([{ type: "uint256" }], [5_000_000n]),
      }],
    }),
    ...(includeBlockReader
      ? { getBlock: async () => ({ timestamp: BigInt(blockTimestamp) }) }
      : {}),
  };
}

const payment = {
  txHash: TX,
  sender: SENDER,
  recipient: RECIPIENT,
  token: "USDC",
  amount: 5,
};

test("payment evidence must be mined after the operation it settles", async () => {
  const createdAt = Date.parse("2026-09-12T12:00:00.000Z");
  assert.equal(
    await verifyPaymentEvidence(
      { ...payment, notBefore: createdAt },
      reader(createdAt / 1000 + 5),
    ),
    true,
  );
  assert.equal(
    await verifyPaymentEvidence(
      { ...payment, notBefore: createdAt },
      reader(createdAt / 1000 - 120),
    ),
    false,
  );
});

test("freshness checks fail closed when block time cannot be read", async () => {
  assert.equal(
    await verifyPaymentEvidence(
      { ...payment, notBefore: Date.now() },
      reader(0, false),
    ),
    false,
  );
});
