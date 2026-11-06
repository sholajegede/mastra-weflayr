# Operations

## Run it in production

1. Set `WEFLAYR_API_KEY` (Gateway scope) and `WEFLAYR_MANAGEMENT_KEY`
   (Management scope) on every server. One key with both scopes also works.
2. Pin a strategy version in production: `strategy("support-default", 4)`.
   Follow the latest in development.
3. Set the customer from your login, so every call carries it.
4. Bring revenue into Weflayr: connect Stripe in Weflayr, or call
   `weflayr.api.setRevenue` from your billing webhook with `revenue_id` set. Use
   one source per customer and month.
5. Use `spend: "weflayr"` for budgets. With several servers, each one reads the
   same figure from Weflayr, so budgets hold across servers.
6. Name every call and list it in `features`. Benchmarks are set up per call
   name, so keep names stable.

## What to watch

| Signal | Meaning | Action |
| ------ | ------- | ------ |
| `result.tripwire.metadata.scope === "month"` | A customer used their monthly budget | Show an upgrade prompt |
| `scope === "margin"` | A customer's margin status is one you stop on | Review their plan or price |
| `scope === "run"` | One run hit its cap | Give a shorter answer, or ask the user to narrow the task |
| `onWarnings` called | The gateway changed a request for the model it picked | Remove the setting, or check the strategy's models |
| Warning `could not check a budget` | Weflayr or your budget function failed; the step ran | Check the management key; consider `onBudgetError: "block"` |
| `unknown_routing_strategy` | The strategy id or version is not in this key's project | Fix the id or the pinned version |
| Gateway 402 | Weflayr balance is empty | Add credit |

Weflayr can also email or post to Slack when cost or margin crosses a threshold.
Set that up in Weflayr rather than in your app.

## Gateway outage

Inside a strategy, Weflayr already falls back across models, providers and
regions. For the gateway itself being unreachable, list a direct model after the
gateway model in Mastra's model list (see the README). Those calls do not reach
Weflayr.

## Upgrades

CI tests against `@mastra/core` 1.34.0, 1.50.0 and the latest release. When
Mastra ships a processor change, the `latest` job fails first.
