# Changelog

## 0.1.0

- `Weflayr.model()` and `Weflayr.config()`: send an agent's model calls through
  the Weflayr gateway with the feature, call name, customer, plan and run id in
  the `x-weflayr-metadata` header
- The customer comes from the request context, or from Mastra's resource id
- `budgetGuard()`: an input processor that stops a customer's run once they have
  used their monthly budget, before the model is called, including part way
  through a tool loop
- `costTracker()`: an output processor that prices every step, adds it to the
  customer's monthly spend and calls `onCall`
- `modelCapture()`: prices a fallback model as the model that answered
- `agent()`: model, guard, model capture and tracker for one agent in one line
- `downgrade`: move a customer to a cheaper model once they have used part of
  their monthly budget
- `runBudget`: cap what one run, or one workflow sharing a request context, may
  spend; `runCost()` returns what a run has spent
- `budgetTool()`: a tool the agent can call to see what is left of its budget
- `BudgetTripwire.scope` says whether the monthly or the run budget stopped the run
- `SpendStore` interface and an in-memory store
- Needs `@mastra/core` 1.34 or later
