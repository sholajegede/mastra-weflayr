/**
 * A live run through the Weflayr gateway. It costs well under a cent.
 *
 *   WEFLAYR_API_KEY=<your key> npm run example
 *
 * 1. Two customers each send one ticket. Both runs go through the gateway on Claude Opus 5.5.
 * 2. cal-com gets a budget it has almost used, so its next run is downgraded to Claude Haiku 5.5.
 * 3. plausible gets a budget it has already used, so its next run is stopped before the model runs.
 */
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { type CallRecord, MemorySpendStore, Weflayr } from "../src/index.js";

const budgets: Record<string, number> = {};
const records: CallRecord[] = [];

const weflayr = new Weflayr({
  features: { "classify-ticket": "support" },
  prices: {
    "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
    "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  },
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
  ...weflayr.agent({
    call: "classify-ticket",
    model: "claude-opus-5-5",
    downgrade: { model: "claude-haiku-5-5", at: 0.8 },
  }),
});

// Mastra logs a stopped run as an error. The result carries the stop, so the log is turned off here.
new Mastra({ agents: { classifier }, logger: false });

const ticket = "I was charged twice for my March invoice.";

async function run(customer: string) {
  const before = records.length;
  const result = await classifier.generate(ticket, {
    requestContext: weflayr.context({ customer, plan: "pro" }),
  });
  if (result.tripwire) {
    console.log(`${customer}: stopped. ${result.tripwire.reason}`);
    return;
  }
  const record = records.at(-1);
  if (records.length === before || !record) return;
  console.log(
    `${customer}: "${result.text.trim()}" on ${record.model}, ${record.inputTokens} in, ${record.outputTokens} out, $${record.costUsd.toFixed(6)}`,
  );
}

console.log("1. No budgets yet");
await run("plausible");
await run("cal-com");

const spent = records.find((record) => record.customer === "cal-com")?.costUsd ?? 0;
budgets["cal-com"] = spent / 0.9;
console.log(`\n2. cal-com has used 90% of a $${budgets["cal-com"].toFixed(6)} budget`);
await run("cal-com");

budgets["plausible"] = 0.000001;
console.log("\n3. plausible is over a $0.000001 budget");
await run("plausible");

console.log(`\nModel calls made: ${records.length}. The stopped run made none.`);
