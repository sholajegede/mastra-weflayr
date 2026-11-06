/**
 * A live run through the Weflayr gateway. It costs well under a cent.
 *
 *   WEFLAYR_API_KEY=<key> npm run example
 *
 * The key needs the Gateway scope, and the Management scope to read the real cost and margin back.
 * Optional:
 *   WEFLAYR_STRATEGY=<strategy id>   route through one of your routing strategies instead of a fixed model
 *
 * 1. Two customers each send one ticket, each as its own Weflayr feature run.
 * 2. One customer gets a budget they have already used, and their next run is stopped before the model runs.
 * 3. It waits for Weflayr to record the calls and reads the real cost and margin back.
 */
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { type CallRecord, Weflayr, currentMonth, strategy } from "../src/index.js";

const model = process.env.WEFLAYR_STRATEGY
  ? strategy(process.env.WEFLAYR_STRATEGY)
  : "claude-haiku-5-5";
const budgets: Record<string, number> = {};
const records: CallRecord[] = [];

const weflayr = new Weflayr({
  features: { "classify-ticket": "support" },
  prices: {
    "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
    "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  },
  budget: (customer) => budgets[customer],
  onCall: (record) => {
    records.push(record);
  },
});

const classifier = new Agent({
  id: "classify-ticket",
  name: "Ticket classifier",
  instructions: "Classify the support ticket as billing, bug or question. Answer with one word.",
  ...weflayr.agent({ call: "classify-ticket", model }),
});

// Mastra logs a stopped run as an error. The result carries the stop, so the log is turned off here.
new Mastra({ agents: { classifier }, logger: false });

const ticket = "I was charged twice for my March invoice.";

async function run(customer: string) {
  const requestContext = weflayr.context({ customer, plan: "pro" });
  const before = records.length;
  const result = await classifier.generate(ticket, { requestContext });
  if (result.tripwire) {
    console.log(`${customer}: stopped. ${result.tripwire.reason}`);
    return;
  }
  const record = records.at(-1);
  if (records.length === before || !record) return;
  console.log(
    `${customer}: "${result.text.trim()}" answered by ${record.model}, run ${record.runId}, ${record.inputTokens} in, ${record.outputTokens} out, about $${record.costUsd.toFixed(6)}`,
  );
}

console.log(`1. Two customers, model ${model}`);
await run("plausible");
await run("cal-com");

budgets["plausible"] = 0.000001;
console.log("\n2. plausible is over a $0.000001 budget");
await run("plausible");
console.log(`Model calls made: ${records.length}. The stopped run made none.`);

{
  console.log("\n3. Reading the real cost back from Weflayr");
  const started = Date.now();
  let cost = 0;
  try {
    while (Date.now() - started < 120_000) {
      cost = await weflayr.api.customerCost("cal-com", currentMonth());
      if (cost > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } catch (error) {
    console.log(`Could not read cost: ${error instanceof Error ? error.message : String(error)}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    cost < 0
      ? "Skipped: the key needs the Management scope."
      : cost > 0
      ? `cal-com this month in Weflayr: $${cost.toFixed(6)} (seen after ${seconds}s)`
      : "Weflayr had not recorded cal-com's cost after 120s.",
  );
  try {
    const margin = await weflayr.margin("cal-com");
    console.log(`cal-com margin status: ${margin.riskStatus ?? "no revenue booked yet"}`);
  } catch (error) {
    console.log(`Margin: ${error instanceof Error ? error.message : String(error)}`);
  }
}
