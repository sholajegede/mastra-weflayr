# Architecture

`mastra-weflayr` is one file of glue between three things: a Mastra agent, the
Weflayr gateway, and a place to keep spend. It adds no server and no database.

## The pieces

| Piece            | Mastra hook                       | What it does                                            |
| ---------------- | --------------------------------- | ------------------------------------------------------- |
| `model()`        | `model: ({ requestContext }) => …`| Builds the gateway config for each request, with the customer in the header |
| `budgetGuard()`  | input processor, `processInputStep` | Before every model step, stops the run if the customer is over budget |
| `modelCapture()` | input processor, `processLLMResponse` | Notes which model answered, so a fallback model is priced as itself |
| `costTracker()`  | output processor, `processOutputStep` | After every step, prices the tokens and adds them to the customer's spend |
| `budgetTool()`   | agent tool                        | Lets the agent read what is left of its budget          |
| `SpendStore`     | none                              | `get` and `add` for (customer, month). Memory by default |

`agent()` returns the model and all three processors together.

## One request

1. `agent.generate(prompt, { requestContext })`. The request context carries the
   customer (set with `weflayr.context()`, or Mastra's resource id).
2. Mastra calls the model function. `model()` reads the customer from the
   request context. If a `downgrade` is set and the customer has used that share
   of their budget, it picks the cheaper model. It returns a config whose `url`
   is the gateway and whose `x-weflayr-metadata` header names the feature, call
   and customer.
3. `budgetGuard` runs. It compares the run's spend with `runBudget`, then the
   customer's monthly spend from the `SpendStore` with your `budget` function.
   If either is used up it calls `abort`, and `result.tripwire` is set.
4. The model call goes to the gateway, which forwards it and records it in
   Weflayr.
5. `modelCapture` stores the id of the model that answered.
6. `costTracker` prices the step (`prices` table), adds it to the run's spend
   and to the `SpendStore`, and calls `onCall`.

A tool loop repeats steps 2 to 6, so the guard can stop a run part way.

## Decisions

- **Processors, not wrappers.** The guard and tracker use Mastra's own processor
  hooks, so they work with `generate`, `stream`, workflows and any agent
  configuration, and Mastra owns the lifecycle.
- **Fail open for recording, configurable for budgets.** A failed cost record
  never fails a run. A failed budget check lets the step run by default
  (`onBudgetError: "block"` flips that).
- **Estimates, not invoices.** The gateway does not return a price, so cost is
  tokens times your `prices` table. Weflayr's dashboard is the source of truth.
- **Per-process spend by default.** `MemorySpendStore` resets on restart and is
  not shared between servers. Production setups pass a `SpendStore` backed by a
  database.
- **State lives outside the processors.** Mastra gives each processor its own
  `state`, so the answering model and the run's spend are kept in `WeakMap`s
  keyed by the request context. They are freed with it.
- **A run is a request context.** That makes a workflow that shares one context
  a single run, and needs no run id.

## Known limits

- The budget is checked before each step and spend is added after it, so a step
  already running can push a customer past the limit.
- A model missing from `prices` is recorded with cost 0 and `costSource: "none"`.
- Requests that bypass the agent (direct `fetch`) are not seen.
