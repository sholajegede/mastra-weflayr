# mastra-weflayr

Run your [Mastra](https://mastra.ai) agents on [Weflayr](https://weflayr.com)
routing strategies, with every call tagged by the customer it serves, and stop a
customer's run when their real AI cost or margin says so.

Weflayr is a gateway that decides which model answers each call. You benchmark
your own calls on other models, save the result as a routing strategy, and your
code sends `model: "strategy/<id>"`. Weflayr then picks the model per call, and
its routing overrides can treat a customer differently by their cost or their
margin. All of that depends on each call saying which customer, feature and call
it belongs to, and which run it is part of. This package does that for Mastra
agents, and brings Weflayr's cost and margin back into the run so the agent can
act on them.

![Request flow: budget guard, model step on a strategy, Weflayr gateway, cost tracker, and real cost and margin from Weflayr](https://raw.githubusercontent.com/sholajegede/mastra-weflayr/main/docs/images/flow.png)

## What it does

- **Strategies instead of model names.** `strategy("production", 3)` pins a
  version in production and `strategy("production")` follows the latest. Changing
  which model answers is a change in the Weflayr dashboard, not a deploy. Each
  step is recorded as the model the strategy picked.
- **The customer on every call.** Read from your login (Mastra's resource id) or
  the request context, so Weflayr's per-customer routing overrides, cost and
  margin all work.
- **One Mastra run is one Weflayr run.** Every step of a request context, tool
  loops and workflows included, carries the same feature run id, so Weflayr
  prices the whole run, not only single calls.
- **Stops based on real numbers.** Before every step, the guard can stop a run
  when the customer's real cost this month, read from Weflayr, has reached their
  budget, when their margin status is one you list (for example
  `unprofitable`), or when the run has spent its own cap. It stops a tool loop
  part way.
- **Revenue and plan into Weflayr.** Push revenue from any billing system and
  tag customers with their plan, so margin and per-plan views work.
- **The gateway's warnings in your logs.** When the gateway changes a request,
  for example by removing a setting the chosen model does not take, you hear
  about it.

## Why a package for this

Weflayr's own Node SDK adds its metadata to clients made with the `openai`
package. Mastra calls models through its own model router, so those calls need
the metadata added another way, and a Mastra run has no Weflayr run id unless
something gives it one. This package uses Mastra's own hooks for that: a model
function that reads the request context, and input and output processors that
run around every step. There is nothing to deploy.

## Install

```sh
npm install mastra-weflayr
```

You need `@mastra/core` 1.34 or later and Node 22.13 or later. Create a key at
[app.weflayr.com](https://app.weflayr.com):

```sh
export WEFLAYR_API_KEY=<your key>
```

Give the key the Gateway scope for model calls, and the Management scope as well
for real cost, margin, revenue and tags. To use a separate management key, set
`WEFLAYR_MANAGEMENT_KEY`. You don't need a key from the model provider.

## Use it

```ts
import { Agent } from "@mastra/core/agent";
import { Weflayr, strategy } from "mastra-weflayr";

export const weflayr = new Weflayr({
  // Which feature each call belongs to. Keep call names stable: benchmarks are set up per call name.
  features: { "classify-ticket": "support" },
  // Read each customer's real cost this month from Weflayr.
  spend: "weflayr",
  // A monthly budget in dollars per customer. Return nothing for no limit.
  budget: (customer) => plans.budgetFor(customer),
  // Stop a customer whose margin is in one of these states.
  stopOnMargin: ["unprofitable"],
});

export const classifier = new Agent({
  id: "classify-ticket",
  name: "Ticket classifier",
  instructions: "Classify the ticket as billing, bug or question.",
  ...weflayr.agent({
    call: "classify-ticket",
    model: strategy("support-default", process.env.NODE_ENV === "production" ? 4 : undefined),
  }),
});
```

`weflayr.agent()` returns the model and the processors for one agent. Spread it
into `new Agent({ ... })`. Say who each run is for with the request context:

```ts
const result = await classifier.generate(ticketText, {
  requestContext: weflayr.context({ customer: workspace.id, plan: workspace.plan }),
});

if (result.tripwire?.metadata?.type === "weflayr-budget") {
  // metadata.scope is "month", "run" or "margin"
  return showUpgradePrompt(result.tripwire.reason);
}
```

In Weflayr the run shows under the feature `support`, the call
`classify-ticket`, the customer, and one feature run.

### Set the customer from the login

Set the customer once in Mastra's server middleware, and every agent call in that
request is tagged without passing a request context by hand:

```ts
import { Mastra } from "@mastra/core";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

export const mastra = new Mastra({
  agents: { classifier },
  server: {
    middleware: [
      async (c, next) => {
        const workspaceId = await workspaceFromToken(c.req.header("authorization"));
        c.get("requestContext").set(MASTRA_RESOURCE_ID_KEY, workspaceId);
        await next();
      },
    ],
  },
});
```

`workspaceFromToken` is your own lookup. Mastra also keeps each resource's memory
separate by this id. To keep the two apart, set the `weflayr-customer` key
instead.

### Push revenue and plan

Weflayr computes margin from revenue. If you bill with Stripe, connect it in
Weflayr and skip this. For any other billing system, push revenue from your
billing webhook or a nightly job:

```ts
await weflayr.api.setRevenue([
  { customer_name: workspace.id, amount: 49, month: "2026-11", revenue_id: invoice.id },
]);

await weflayr.tagCustomers({ [workspace.id]: { plan: "pro" } });
```

Rows are sent as upserts keyed by `revenue_id`, so a retried webhook does not
book the same invoice twice. Use one revenue source per customer and month:
Weflayr adds sources together.

### Cap one run

```ts
new Weflayr({ runBudget: (rc) => (rc.get("weflayr-plan") === "free" ? 0.05 : 0.5) });
```

A run is everything done with one request context, so a workflow that passes one
request context to several agents shares one cap. The run's spend is estimated
from `prices` as it happens, since Weflayr's figure arrives after the run.

### Let the agent check its budget

```ts
tools: { checkBudget: weflayr.budgetTool() },
```

The tool returns the customer's monthly limit, spend and what is left, the same
for the run, and the margin status.

### Group the calls of a run across processes

A run id is made for each request context. To continue a run in another process,
pass its id along: `weflayr.runId(requestContext)` on one side,
`weflayr.context({ runId })` on the other. Ids are 32 lowercase hex characters;
`newRunId()` makes one.

### Track your scorers

A scorer's judge has no request context, so give it a fixed config. Its calls
show under their own call name:

```ts
judge: {
  model: weflayr.config(strategy("judges"), { call: "judge-tone" }),
  instructions: "You rate the tone of support replies.",
},
```

### Keep a call alive if the gateway fails

Weflayr already falls back across models and providers inside a strategy. For
the gateway itself being unreachable, list a direct model after it in Mastra's
model list:

```ts
model: [
  { model: weflayr.model(strategy("support-default"), { call: "reply" }), maxRetries: 1 },
  { model: "anthropic/claude-haiku-5-5", maxRetries: 1 },
],
inputProcessors: [weflayr.budgetGuard(), weflayr.modelCapture()],
outputProcessors: [weflayr.costTracker({ call: "reply", model: "claude-haiku-5-5" })],
```

Calls that go direct do not appear in Weflayr.

## Options

| Option            | What it does                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `apiKey`          | Gateway key. Defaults to `WEFLAYR_API_KEY`                                                    |
| `managementKey`   | Management key. Defaults to `WEFLAYR_MANAGEMENT_KEY`, then `WEFLAYR_API_KEY`                  |
| `features`        | Call name to feature name. Unlisted calls use `defaultFeature` (default `"other"`)            |
| `customer(rc)`    | Who the run is for. Default: the `weflayr-customer` context key, then Mastra's resource id    |
| `plan(rc)`        | The customer's plan, sent as a tag on each call                                               |
| `spend`           | `"weflayr"` for real cost, `"memory"` (default) for estimates in this process, or your store  |
| `budget(c, rc)`   | Monthly dollars for a customer, or nothing for no limit                                       |
| `stopOnMargin`    | Margin statuses that stop a run: `healthy`, `watch`, `at_risk`, `unprofitable`                |
| `runBudget`       | The most one run may spend, in dollars, or a function of the request context                  |
| `prices`          | Dollars per million tokens, for estimates between reads of Weflayr's real cost                |
| `onCall(record)`  | Called after every step with customer, run, call, the model that answered, tokens and estimate|
| `onWarnings`      | Called with the gateway's `weflayr_warnings`. Defaults to a console warning                   |
| `onBudgetError`   | `"allow"` (default) runs the step if a check fails, `"block"` stops it                        |

`weflayrSpend: { refreshMs, settleMs }` and `marginRefreshMs` tune how often
Weflayr is read. `weflayr.api` is a small client for Weflayr's management API:
`getCosts`, `getMargin`, `setRevenue`, `setCustomerTags`, `customerCost` and
`customerMargin`.

## How spend is counted

With `spend: "weflayr"`, the guard reads the customer's cost for the month from
Weflayr, the same figure its dashboard shows, at most once a minute. Steps that
ran since then are added from your `prices`, for five minutes, to cover the time
Weflayr takes to record them. In that window a step can be counted twice, so the
spend reads slightly high, never low. Without `prices`, only Weflayr's figure
counts.

With `spend: "memory"`, spend is your `prices` estimate, kept in this process. It
resets on restart and is not shared between servers. For your own database, pass
an object with `get(customer, month)` and `add(customer, month, usd)`.

## Limitations

- Checks run before each step and spend is added after it, so a step already
  running can take a customer or a run past its limit.
- Margin needs revenue in Weflayr, from Stripe, a CSV or `setRevenue`. On an
  internal project Weflayr has no margin, so the margin check fails and
  `onBudgetError` decides whether the step runs.
- For a streamed response that the gateway changed, the warnings are not
  available to the package. The model that answered still is.
- Calls that do not go through a Mastra agent are not seen.
- Customer ids are sent to Weflayr as written. Use an id, not an email address.

## Troubleshooting

**Nothing shows in Weflayr.** The agent's model is not the one from
`weflayr.model()`. Spread `weflayr.agent(...)` last, so nothing overrides
`model`.

**`unknown_routing_strategy` or `invalid_routing_strategy_version`.** The
strategy id or version does not exist in the project of your key. List them in
the Weflayr dashboard.

**Routing overrides don't apply to a customer.** The call has no customer. Set it
from the login or the request context.

**A budget never stops anyone.** It needs a customer on the run, and either
`spend: "weflayr"` with a management key or `prices`.

**A stopped run logs `TripWire` as an error.** That is Mastra logging the stop.
The run did not crash; the reason is on `result.tripwire`.

**The gateway returns 402.** Your Weflayr balance is empty.

## Try it

```sh
npm install
WEFLAYR_API_KEY=<key> npm run example
```

`examples/live.ts` sends one ticket for two customers, each as its own Weflayr
run, then stops one customer over a tiny budget before the model is called, and
reads the real cost and margin back from Weflayr. Set `WEFLAYR_STRATEGY` to
route through one of your strategies.

## Contributing

```sh
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
and [docs/OPERATIONS.md](./docs/OPERATIONS.md). To publish, see
[PUBLISHING.md](./PUBLISHING.md). Changes are in [CHANGELOG.md](./CHANGELOG.md).

## License

Apache-2.0
