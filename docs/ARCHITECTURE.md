# Architecture

`mastra-weflayr` connects a Mastra agent to two Weflayr APIs: the gateway, which
answers model calls and picks the model through a routing strategy, and the
management API, which holds each customer's cost, revenue and margin. It adds no
server and no database.

## The pieces

| Piece             | Mastra hook                              | What it does |
| ----------------- | ---------------------------------------- | ------------ |
| `model()`         | `model: ({ requestContext }) => config`   | Builds the gateway config for each request: the model or strategy, and the `x-weflayr-metadata` header with feature, call, customer, run id and tags |
| `budgetGuard()`   | input processor, `processInputStep`       | Before every step, checks the run's cap, the customer's monthly budget and their margin status |
| `modelCapture()`  | input processor, `processLLMResponse`     | Notes the model that answered (from the response) and the gateway's warnings |
| `costTracker()`   | output processor, `processOutputStep`     | After every step, estimates its cost, adds it to the run and the customer, calls `onCall` |
| `budgetTool()`    | agent tool                               | Lets the agent read its budget and margin status |
| `WeflayrApi`      | none                                     | `fetch` client for costs, margin, revenue and customer tags |
| `WeflayrSpendStore` | none                                   | The customer's real monthly cost from Weflayr, plus estimates of steps Weflayr has not recorded yet |

## One request

1. `agent.generate(prompt, { requestContext })`. The customer comes from the
   request context or Mastra's resource id. The first time a request context is
   seen, it gets a feature run id.
2. `budgetGuard` runs. It compares the run's estimated spend with `runBudget`,
   the customer's monthly spend (from the spend store) with `budget`, and their
   margin status (from Weflayr, cached) with `stopOnMargin`. Any of them can call
   `abort`, and the result carries `tripwire`.
3. Mastra calls the model function. The request goes to the gateway with
   `model: "strategy/<id>[:<version>]"` or a model name, and the metadata header.
4. The gateway picks the model, answers, and records the call in Weflayr under
   that customer, feature, call and run.
5. `modelCapture` reads the answering model from the response metadata, and
   `weflayr_warnings` from the response body when it is not streamed.
6. `costTracker` estimates the step from `prices`, adds it to the run and to the
   spend store, reports warnings and calls `onCall`.

A tool loop repeats steps 2 to 6, so the guard can stop a run part way.

## Decisions

- **Processors, not wrappers.** They work with `generate`, `stream`, workflows
  and any agent configuration, and Mastra owns their lifecycle.
- **Weflayr decides the model.** The package never switches models itself.
  Per-customer routing belongs to Weflayr's routing overrides, which see real
  cost and margin. The package only decides whether a step runs at all.
- **Real cost for budgets, estimates in between.** Weflayr is the source of truth
  for cost. Reading it on every step would be slow, so it is cached for
  `refreshMs`, and recent steps are estimated for `settleMs`. The total errs high.
- **A run is a request context.** A workflow that shares one context is one run,
  in the budget and in Weflayr, with no run id to pass around.
- **State outside the processors.** Mastra gives each processor its own `state`,
  so the answering model, run spend and run id live in `WeakMap`s keyed by the
  request context, and are freed with it.
- **Fail open by default.** A failed record never fails a run. A failed budget
  or margin check lets the step run unless `onBudgetError` is `"block"`.
- **No SDK dependency.** The management client is plain `fetch`, so the package
  adds no OpenTelemetry or provider SDK to an app.

## Known limits

- Checks run before a step and spend is added after it, so a running step can
  pass a limit.
- Warnings on streamed responses are not visible to processors.
- Requests that bypass the agent are not seen.
