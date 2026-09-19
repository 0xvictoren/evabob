import assert from "node:assert/strict";
import { test } from "node:test";
import { findEvabobLinks } from "./evabobLinks.js";

test("every kind of Evabob link is recognised, in order, once each", () => {
  const text = [
    "Buy my dress http://192.168.1.49:3000/h/Ab3dEf9hIjKl",
    "or pay this https://evabob.app/pay/2f3a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    "chip in http://192.168.1.49:3000/g/p_abc123 and take http://x.test/t/task_0123456789abcdef",
    "pay the agent https://evabob.app/a/ada_research",
    "claim yours: https://evabob.app/claim?transferId=12",
    "proof https://evabob.app/r/MAoogKtSudyzWA-cTHyrTQ",
    "agents buy https://evabob.app/x/eRr6l7L9QEwb",
    "again http://192.168.1.49:3000/h/Ab3dEf9hIjKl",
  ].join("\n");
  assert.deepEqual(
    findEvabobLinks(text).map((l) => `${l.kind}:${l.id}`),
    [
      "hold:Ab3dEf9hIjKl",
      "pay:2f3a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      "group:p_abc123",
      "task:task_0123456789abcdef",
      "agent:ada_research",
      "claim:12",
      "receipt:MAoogKtSudyzWA-cTHyrTQ",
      "paywall:eRr6l7L9QEwb",
    ],
  );
});

test("plain text has no links", () => {
  assert.deepEqual(findEvabobLinks("see you at 3, pay me later"), []);
});
