# Changelog

## 0.1.1

- A failed request to Weflayr's management API now says why (for example a DNS or TLS error) and gives up after 30 seconds
- Releases publish with npm trusted publishing instead of a stored token

## 0.1.0

- Run agents on Weflayr routing strategies: `strategy(id, version)` as the model,
  and each step recorded as the model the strategy picked
- Every call carries the feature, call name, customer and plan, with the customer
  read from the request context or Mastra's resource id
- One Weflayr feature run per request context, so a Mastra run, tool loop or
  workflow is priced as one run; `runId()`, `newRunId()` and `context({ runId })`
  continue a run across processes
- `budgetGuard()` stops a run before the model is called when the run has spent
  its `runBudget`, the customer has used their monthly `budget`, or their margin
  status is in `stopOnMargin`, including part way through a tool loop
- `spend: "weflayr"` reads each customer's real monthly cost from Weflayr, with
  recent steps estimated from `prices` until Weflayr records them
- `weflayr.api`: a client for Weflayr's management API (costs, margin, revenue,
  customer tags), plus `margin()` and `tagCustomers()`
- `modelCapture()` records the model that answered and the gateway's
  `weflayr_warnings`, passed to `onWarnings`
- `costTracker()` prices each step, adds it to the run and the customer, and
  calls `onCall`
- `budgetTool()`: a tool the agent can call to see its budget and margin status
- `agent()`: model and processors for one agent in one line
- Needs `@mastra/core` 1.34 or later
