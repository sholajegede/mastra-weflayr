/**
 * A live run through the Weflayr gateway. It costs a fraction of a cent.
 *
 *   WEFLAYR_API_KEY=<your key> npm run example
 *
 * It sends one real call for two customers, then gives one of them a tiny budget
 * and shows the next call being stopped before the model runs.
 */
import { Agent } from "@mastra/core/agent";
import { type CallRecord, MemorySpendStore, Weflayr } from "../src/index.js";

const MODEL = "claude-haiku-5-5";
const budgets: Record<string, number> = {};
const records: CallRecord[] = [];

const weflayr = new Weflayr({
  features: { "classify-ticket": "support" },
  prices: { [MODEL]: { inputPerMillion: 0.1, outputPerMillion: 0.5 } },
  budget: (customer) => budgets[customer],
  spend: new MemorySpendStore(),
  onCall: (record) => {
    records.push(record);
  },
});

const classifier = new Agent({
  id: "classify-ticket",
  name: "Ticket classifier",
  instructions: "Classify the support ticket as billing, bug or question. Answer with one word.",
  ...weflayr.agent({ call: "classify-ticket", model: MODEL }),
});

const ticket = "I was charged twice for my March invoice.";

for (const customer of ["plausible", "cal-com"]) {
  const result = await classifier.generate(ticket, {
    requestContext: weflayr.context({ customer, plan: "pro" }),
  });
  const record = records.at(-1);
  console.log(
    `${customer}: "${result.text.trim()}", ${record?.inputTokens} in, ${record?.outputTokens} out, $${record?.costUsd.toFixed(6)}`,
  );
}

// Give Plausible a budget smaller than what it has already spent this month.
budgets["plausible"] = 0.000001;
const blocked = await classifier.generate(ticket, {
  requestContext: weflayr.context({ customer: "plausible", plan: "pro" }),
});
console.log(`plausible with a budget: ${blocked.tripwire ? `stopped: ${blocked.tripwire.reason}` : "ran"}`);
console.log(`model calls made: ${records.length} (the stopped call made none)`);
