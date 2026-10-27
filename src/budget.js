// Keeps Claude spending under a monthly limit. The cost of every reply is worked
// out from the tokens and web searches Claude reports, and saved per month.
// When the month's limit is reached, the app stops calling Claude until the
// next month starts.

// Dollars per million tokens: [input, output]. From Anthropic's price list.
const PRICES = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const FALLBACK_PRICE = [10, 50]; // An unknown model is counted at a high price, to be safe.
const WEB_SEARCH_EACH = 0.01; // $10 per 1,000 searches.

export const monthOf = (date = new Date()) => date.toISOString().slice(0, 7);

/** What one reply cost, in dollars. */
export function costOf(usage, model) {
  if (!usage) return 0;
  const [input, output] = PRICES[model] ?? FALLBACK_PRICE;
  const tokensIn =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (tokensIn * input + (usage.output_tokens ?? 0) * output) / 1e6 + searches * WEB_SEARCH_EACH;
}

function nextMonthName(date) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

export function createBudget({ store, limit, now = () => new Date() }) {
  return {
    /** Throws if this month's limit is used up, so no more money is spent. */
    check() {
      if (!limit) return;
      const spent = store.spent(monthOf(now()));
      if (spent >= limit) {
        throw new Error(
          `This month's AI budget of $${limit.toFixed(2)} is used up, so no more posts will be written until ${nextMonthName(now())}. You can raise MONTHLY_BUDGET_USD in .env.`,
        );
      }
    },
    record(usage, model) {
      const cost = costOf(usage, model);
      if (cost > 0) store.addSpend(monthOf(now()), cost);
      return cost;
    },
    status: () => ({ spent: store.spent(monthOf(now())), limit }),
  };
}
