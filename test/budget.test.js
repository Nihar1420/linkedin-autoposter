import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../src/db.js";
import { costOf, createBudget } from "../src/budget.js";

test("works out a reply's cost from tokens and web searches", () => {
  const usage = { input_tokens: 3000, output_tokens: 2000 };
  assert.equal(costOf(usage, "claude-sonnet-5-5").toFixed(3), "0.026");
  const researched = { input_tokens: 20000, output_tokens: 2000, server_tool_use: { web_search_requests: 2 } };
  assert.equal(costOf(researched, "claude-sonnet-5-5").toFixed(3), "0.080");
  assert.ok(costOf(usage, "some-new-model") > costOf(usage, "claude-opus-5-5"), "unknown models are counted high");
});

test("stops Claude calls once the month's limit is reached, and starts again next month", () => {
  const store = openStore(":memory:");
  let today = new Date("2026-11-20T10:00:00Z");
  const budget = createBudget({ store, limit: 3, now: () => today });

  budget.check();
  budget.record({ input_tokens: 0, output_tokens: 290000 }, "claude-sonnet-5-5"); // $2.90
  budget.check();
  budget.record({ input_tokens: 0, output_tokens: 10000 }, "claude-sonnet-5-5"); // $3.00
  assert.throws(() => budget.check(), /budget of \$3\.00 is used up.*1 December/);
  assert.deepEqual(budget.status(), { spent: 3, limit: 3 });

  today = new Date("2026-12-01T00:00:00Z");
  budget.check();
  assert.equal(budget.status().spent, 0);
});

test("a limit of 0 turns the cap off", () => {
  const store = openStore(":memory:");
  const budget = createBudget({ store, limit: 0 });
  budget.record({ output_tokens: 10_000_000 }, "claude-sonnet-5-5");
  budget.check();
});
