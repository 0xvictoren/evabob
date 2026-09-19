import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOOP_LIMIT,
  LOOP_WINDOW_MS,
  allowanceOf,
  decide,
  describeAllowance,
  endpointOf,
  forgetCalls,
  meterFor,
  normalizeCategory,
  noteCall,
  validateAllowance,
  windowEnd,
  windowStart,
  type Allowance,
} from "./agentAllowance.js";

const weekly: Allowance = {
  amountUsdc: 20,
  window: "week",
  categories: ["research"],
  askAboveUsdc: 2,
  proofOnly: false,
};

describe("allowance windows", () => {
  it("weeks start on Monday, UTC", () => {
    // Thursday 2026-09-17 15:00 UTC → Monday 2026-09-14.
    const thu = Date.UTC(2026, 8, 17, 15);
    assert.equal(new Date(windowStart("week", thu)).toISOString(), "2026-09-14T00:00:00.000Z");
    assert.equal(new Date(windowEnd("week", thu)).toISOString(), "2026-09-21T00:00:00.000Z");
    // A Sunday belongs to the week that started six days earlier.
    const sun = Date.UTC(2026, 8, 20, 23);
    assert.equal(new Date(windowStart("week", sun)).toISOString(), "2026-09-14T00:00:00.000Z");
  });

  it("days and months", () => {
    const t = Date.UTC(2026, 11, 31, 22);
    assert.equal(new Date(windowStart("day", t)).toISOString(), "2026-12-31T00:00:00.000Z");
    assert.equal(new Date(windowEnd("month", t)).toISOString(), "2027-01-01T00:00:00.000Z");
  });
});

describe("the three tiers", () => {
  const base = { allowance: weekly, paused: false, category: "research" as const, waitsForProof: true, remainingUsdc: 20 };

  it("goes through silently at or below the owner's limit", () => {
    assert.deepEqual(decide({ ...base, costUsdc: 2 }), { tier: "silent" });
    assert.deepEqual(decide({ ...base, costUsdc: 0.01 }), { tier: "silent" });
  });

  it("asks the owner above their limit", () => {
    assert.deepEqual(decide({ ...base, costUsdc: 2.01 }), { tier: "ask" });
    // …and goes through once they approved it.
    assert.deepEqual(decide({ ...base, costUsdc: 5, approved: true }), { tier: "silent" });
  });

  it("refuses beyond what is left, whatever anyone approved", () => {
    const out = decide({ ...base, costUsdc: 6, remainingUsdc: 5, approved: true });
    assert.equal(out.tier, "refuse");
    assert.equal(out.tier === "refuse" && out.code, "OVER_ALLOWANCE");
    assert.match(out.tier === "refuse" ? out.reason : "", /only \$5\.00 is left of the \$20\.00 allowance this week/);
  });

  it("refuses what is not on the list", () => {
    const out = decide({ ...base, costUsdc: 1, category: "media" });
    assert.equal(out.tier === "refuse" && out.code, "NOT_ON_LIST");
    assert.match(out.tier === "refuse" ? out.reason : "", /research services only/);
  });

  it("an empty list means anything on the approved list", () => {
    assert.deepEqual(
      decide({ ...base, allowance: { ...weekly, categories: [] }, costUsdc: 1, category: "media" }),
      { tier: "silent" },
    );
  });

  it("proof-only refuses sellers that take payment first", () => {
    const out = decide({ ...base, allowance: { ...weekly, proofOnly: true }, costUsdc: 1, waitsForProof: false });
    assert.equal(out.tier === "refuse" && out.code, "NEEDS_PROOF");
  });

  it("a paused agent spends nothing", () => {
    const out = decide({ ...base, paused: true, costUsdc: 0.01 });
    assert.equal(out.tier === "refuse" && out.code, "AGENT_PAUSED");
  });
});

describe("the live meter", () => {
  const now = Date.UTC(2026, 8, 17, 12);
  const row = (amount: number, status: string, at = "2026-09-16T10:00:00.000Z") => ({
    key: `k${Math.random()}`,
    url: "https://x",
    amountUsdc: amount,
    status: status as never,
    createdAt: at,
    updatedAt: at,
  });

  it("counts spent and held this window, and ignores what came back", () => {
    const m = meterFor({
      allowance: weekly,
      dailyLimitUsdc: 0,
      paymentHistory: [
        row(3, "settled"),
        row(1.5, "held"),
        row(4, "refunded"),
        row(2, "released"),
        row(0.5, "disputed"),
        row(9, "settled", "2026-09-10T10:00:00.000Z"), // last week
      ],
    }, now);
    assert.equal(m.spentUsdc, 3.5);
    assert.equal(m.heldUsdc, 1.5);
    assert.equal(m.remainingUsdc, 15);
    assert.equal(m.resetsAt, "2026-09-21T00:00:00.000Z");
  });

  it("older agents read their daily and per-call limits as an allowance", () => {
    const a = allowanceOf({ dailyLimitUsdc: 50, perCallLimitUsdc: 1 });
    assert.deepEqual(a, { amountUsdc: 50, window: "day", categories: [], askAboveUsdc: 1, proofOnly: false });
  });
});

describe("the loop breaker", () => {
  it("trips on the call after the limit to one endpoint inside a minute", () => {
    const t0 = 1_000_000;
    forgetCalls("agent_loop");
    for (let i = 0; i < LOOP_LIMIT; i++) {
      assert.equal(noteCall("agent_loop", `https://api.example.com/search?q=${i}`, t0 + i).trip, false);
    }
    const tripped = noteCall("agent_loop", "https://API.example.com/search/", t0 + LOOP_LIMIT);
    assert.equal(tripped.trip, true);
    assert.equal(tripped.count, LOOP_LIMIT + 1);
    assert.equal(tripped.endpoint, "https://api.example.com/search");
  });

  it("does not trip for calls spread out, or to different endpoints", () => {
    forgetCalls("agent_calm");
    for (let i = 0; i < LOOP_LIMIT * 3; i++) {
      assert.equal(noteCall("agent_calm", "https://api.example.com/a", i * (LOOP_WINDOW_MS / 4)).trip, false);
    }
    forgetCalls("agent_wide");
    for (let i = 0; i < LOOP_LIMIT * 3; i++) {
      assert.equal(noteCall("agent_wide", `https://api.example.com/p${i}`, 5).trip, false);
    }
  });

  it("an endpoint is origin and path, not the query", () => {
    assert.equal(endpointOf("https://A.com/x/?q=1"), "https://a.com/x");
    assert.equal(endpointOf("https://a.com"), "https://a.com/");
  });
});

describe("categories and wording", () => {
  it("maps sellers' own labels to ours", () => {
    assert.equal(normalizeCategory("Web Search"), "research");
    assert.equal(normalizeCategory("Crypto Prices"), "data");
    assert.equal(normalizeCategory("LLM Inference"), "ai");
    assert.equal(normalizeCategory("something odd"), "tools");
  });

  it("says the allowance the way a person would", () => {
    assert.equal(describeAllowance(weekly), "$20.00 this week, research services only");
  });

  it("rejects allowances that make no sense", () => {
    assert.match(validateAllowance({ ...weekly, askAboveUsdc: 30 }, 1000)!, /more than the allowance/);
    assert.match(validateAllowance({ ...weekly, amountUsdc: 0 }, 1000)!, /between/);
    assert.equal(validateAllowance(weekly, 1000), null);
  });
});
