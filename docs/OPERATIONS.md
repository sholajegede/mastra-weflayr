# Operations

## Run it in production

1. Set `WEFLAYR_API_KEY` on every server.
2. Give `Weflayr` a `SpendStore` backed by your database. The default memory
   store counts per process, so with two servers a customer can spend twice
   their budget.
3. Fill `prices` for every model you use, in dollars per million tokens.
4. Name every call and list it in `features`. Weflayr benchmarks are set up per
   call name, so keep names stable.

A `SpendStore` is two methods:

```ts
const spend: SpendStore = {
  get: async (customer, month) => (await db.spend.find(customer, month)) ?? 0,
  add: async (customer, month, usd) => db.spend.increment(customer, month, usd),
};
```

Make `add` an atomic increment.

## What to watch

| Signal | Meaning | Action |
| ------ | ------- | ------ |
| `result.tripwire.metadata.type === "weflayr-budget"` | A customer (`scope: "month"`) or a run (`scope: "run"`) hit its budget | Show an upgrade prompt, or a shorter answer for a run |
| Header tag `downgraded_from` in Weflayr | A customer near their budget was moved to the cheaper model | Check whether the cheaper model still answers well |
| Warning `could not check a budget` | Budget function or store failed; steps ran | Fix the store; consider `onBudgetError: "block"` |
| Warning `could not record a step` | `onCall` or the store failed; the run was fine | Fix the sink |
| Records with `costSource: "none"` | Model missing from `prices` | Add the price |
| Gateway 402 | Weflayr balance is empty | Add credit in the dashboard |

## Gateway outage

List a direct model after the gateway model in Mastra's model list:

```ts
model: [
  { model: weflayr.model("claude-haiku-5-5", { call: "reply" }), maxRetries: 1 },
  { model: { id: "anthropic/claude-haiku-5-5" }, maxRetries: 1 },
],
```

Mastra moves to the next entry if the gateway fails, and `modelCapture` prices
the step as the model that answered. Calls that go direct do not appear in
Weflayr.

## Upgrades

CI tests against `@mastra/core` 1.34.0, 1.50.0 and the latest release. When
Mastra ships a processor change, the `latest` job fails first.
