import { Agent } from "@mastra/core/agent";
import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  type BudgetTripwire,
  type CallRecord,
  GATEWAY_URL,
  MemorySpendStore,
  Weflayr,
  currentMonth,
} from "../src/index.js";
import { fakeGateway, metadataOf } from "./gateway.js";

const PRICES = {
  "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
};

function newAgent(weflayr: Weflayr, call = "support-reply", model = "claude-haiku-5-5") {
  return new Agent({
    id: call,
    name: call,
    instructions: "Answer in one word.",
    ...weflayr.agent({ call, model }),
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WEFLAYR_API_KEY;
});

describe("routing through the gateway", () => {
  test("sends the call to the gateway with the key, the model and the metadata header", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      features: { "support-reply": "support" },
    });
    const result = await newAgent(weflayr).generate("hi", {
      requestContext: weflayr.context({ customer: "acme", plan: "pro", runId: "run-1" }),
    });

    expect(result.text).toBe("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${GATEWAY_URL}/chat/completions`);
    expect(seen[0]!.headers.authorization).toBe("Bearer wf-test");
    expect(seen[0]!.body.model).toBe("claude-haiku-5-5");
    expect(metadataOf(seen[0])).toEqual({
      feature_name: "support",
      call_name: "support-reply",
      customer_name: "acme",
      tags: { plan: "pro", run_id: "run-1" },
    });
  });

  test("streaming goes through the gateway with the same header", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({ apiKey: "wf-test" });
    const stream = await newAgent(weflayr).stream("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
    });
    expect(await stream.text).toBe("hello");
    expect(seen[0]!.body.stream).toBe(true);
    expect(metadataOf(seen[0]).customer_name).toBe("acme");
  });

  test("each request names its own customer", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({ apiKey: "wf-test" });
    const agent = newAgent(weflayr);
    await agent.generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });
    await agent.generate("hi", { requestContext: weflayr.context({ customer: "globex" }) });
    expect(seen.map((request) => metadataOf(request).customer_name)).toEqual([
      "acme",
      "globex",
    ]);
  });

  test("the customer falls back to Mastra's resource id, and can come from your own function", async () => {
    const seen = fakeGateway();
    const fromResource = new Weflayr({ apiKey: "wf-test" });
    const context = new RequestContext();
    context.set(MASTRA_RESOURCE_ID_KEY, "user-42");
    await newAgent(fromResource).generate("hi", { requestContext: context });

    const fromFunction = new Weflayr({
      apiKey: "wf-test",
      customer: (requestContext) => `org:${String(requestContext.get("orgId"))}`,
    });
    const orgContext = new RequestContext();
    orgContext.set("orgId", "7");
    await newAgent(fromFunction).generate("hi", { requestContext: orgContext });

    expect(metadataOf(seen[0]).customer_name).toBe("user-42");
    expect(metadataOf(seen[1]).customer_name).toBe("org:7");
  });

  test("without a customer the header has no customer name", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({ apiKey: "wf-test" });
    await newAgent(weflayr).generate("hi");
    expect(metadataOf(seen[0])).toEqual({
      feature_name: "other",
      call_name: "support-reply",
    });
  });

  test("the model can be picked from the request context, and model ids with a slash are kept", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({ apiKey: "wf-test" });
    const agent = new Agent({
      id: "draft",
      name: "draft",
      instructions: "Write.",
      ...weflayr.agent({
        call: "draft-post",
        model: (requestContext) =>
          requestContext.get("weflayr-plan") === "pro" ? "claude-opus-5-5" : "openai/gpt-6.1-mini",
      }),
    });
    await agent.generate("hi", { requestContext: weflayr.context({ customer: "a", plan: "pro" }) });
    await agent.generate("hi", { requestContext: weflayr.context({ customer: "b", plan: "free" }) });
    expect(seen.map((request) => request.body.model)).toEqual([
      "claude-opus-5-5",
      "openai/gpt-6.1-mini",
    ]);
  });

  test("a customer name with non ASCII characters is sent as a valid header", async () => {
    const seen = fakeGateway();
    const weflayr = new Weflayr({ apiKey: "wf-test" });
    await newAgent(weflayr).generate("hi", {
      requestContext: weflayr.context({ customer: "Café Lagos 🚀" }),
    });
    const header = seen[0]!.headers["x-weflayr-metadata"]!;
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
    expect(metadataOf(seen[0]).customer_name).toBe("Café Lagos 🚀");
  });

  test("the key comes from WEFLAYR_API_KEY, and a missing key fails with a clear message", async () => {
    const seen = fakeGateway();
    process.env.WEFLAYR_API_KEY = "wf-env";
    await newAgent(new Weflayr()).generate("hi");
    expect(seen[0]!.headers.authorization).toBe("Bearer wf-env");

    delete process.env.WEFLAYR_API_KEY;
    await expect(newAgent(new Weflayr()).generate("hi")).rejects.toThrow(
      "WEFLAYR_API_KEY is not set.",
    );
  });

  test("config() is a fixed model for places without a request context", () => {
    const weflayr = new Weflayr({ apiKey: "wf-test", features: { judge: "evals" } });
    const config = weflayr.config("claude-haiku-5-5", { call: "judge", customer: "acme" });
    expect(config).toMatchObject({
      providerId: "weflayr",
      modelId: "claude-haiku-5-5",
      url: GATEWAY_URL,
      apiKey: "wf-test",
    });
    expect(JSON.parse(config.headers!["x-weflayr-metadata"]!)).toEqual({
      feature_name: "evals",
      call_name: "judge",
      customer_name: "acme",
    });
  });
});

describe("cost tracking", () => {
  test("each step is priced, added to the customer's spend and passed to onCall", async () => {
    fakeGateway([{ text: "ok", input: 1000, output: 200 }]);
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      prices: PRICES,
      features: { "support-reply": "support" },
      onCall: (record) => {
        calls.push(record);
      },
    });
    await newAgent(weflayr).generate("hi", {
      requestContext: weflayr.context({ customer: "acme", plan: "pro", runId: "run-9" }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      customer: "acme",
      plan: "pro",
      runId: "run-9",
      call: "support-reply",
      feature: "support",
      model: "claude-haiku-5-5",
      step: 0,
      inputTokens: 1000,
      outputTokens: 200,
      costSource: "estimated",
    });
    // 1000 * 0.1 / 1M + 200 * 0.5 / 1M
    expect(calls[0]!.costUsd).toBeCloseTo(0.0002, 10);
    expect((await weflayr.budget("acme")).spentUsd).toBeCloseTo(0.0002, 10);
  });

  test("a streamed call is recorded too", async () => {
    fakeGateway([{ text: "ok", input: 1000, output: 200 }]);
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, onCall: (record) => void calls.push(record) });
    const stream = await newAgent(weflayr).stream("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
    });
    await stream.text;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200, costSource: "estimated" });
  });

  test("a model missing from the price table is recorded with cost none and adds no spend", async () => {
    fakeGateway();
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({ apiKey: "wf-test", onCall: (record) => void calls.push(record) });
    await newAgent(weflayr).generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });
    expect(calls[0]).toMatchObject({ costUsd: 0, costSource: "none" });
    expect((await weflayr.budget("acme")).spentUsd).toBe(0);
  });

  test("an error in onCall never fails the run", async () => {
    fakeGateway();
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      onCall: () => {
        throw new Error("database down");
      },
    });
    const result = await newAgent(weflayr).generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
    });
    expect(result.text).toBe("hello");
    expect(console.warn).toHaveBeenCalledWith(
      "mastra-weflayr could not record a step:",
      "database down",
    );
  });

  test("a tool loop records one entry per model step", async () => {
    fakeGateway([
      { toolCall: { name: "lookup", args: { id: "1" } }, input: 500, output: 50 },
      { text: "done", input: 700, output: 30 },
    ]);
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, onCall: (record) => void calls.push(record) });
    const agent = new Agent({
      id: "support",
      name: "support",
      instructions: "Use the tool.",
      tools: { lookup },
      ...weflayr.agent({ call: "support-reply", model: "claude-haiku-5-5" }),
    });
    const result = await agent.generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
      maxSteps: 5,
    });
    expect(result.text).toBe("done");
    expect(calls.map((record) => [record.step, record.inputTokens])).toEqual([
      [0, 500],
      [1, 700],
    ]);
  });
});

const lookup = createTool({
  id: "lookup",
  description: "Looks up an order.",
  inputSchema: z.object({ id: z.string() }),
  execute: async () => ({ status: "shipped" }),
});

describe("budgets", () => {
  test("a customer over their budget is stopped before the model is called", async () => {
    const seen = fakeGateway();
    const spend = new MemorySpendStore();
    spend.add("acme", currentMonth(), 5.2);
    const weflayr = new Weflayr({ apiKey: "wf-test", spend, budget: () => 5 });

    const result = await newAgent(weflayr).generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
    });

    expect(seen).toHaveLength(0);
    expect(result.text).toBe("");
    expect(result.tripwire?.reason).toBe("acme has used $5.2 of its $5 monthly AI budget.");
    expect(result.tripwire?.processorId).toBe("weflayr-budget-guard");
    expect(result.tripwire?.metadata as BudgetTripwire).toEqual({
      type: "weflayr-budget",
      scope: "month",
      customer: "acme",
      month: currentMonth(),
      limitUsd: 5,
      spentUsd: 5.2,
    });
  });

  test("only the customer over budget is stopped, and customers without a budget always run", async () => {
    const seen = fakeGateway();
    const spend = new MemorySpendStore();
    spend.add("acme", currentMonth(), 10);
    spend.add("globex", currentMonth(), 10);
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      spend,
      budget: (customer) => (customer === "acme" ? 5 : undefined),
    });
    const agent = newAgent(weflayr);
    const acme = await agent.generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });
    const globex = await agent.generate("hi", { requestContext: weflayr.context({ customer: "globex" }) });
    const nobody = await agent.generate("hi");

    expect(acme.tripwire).toBeDefined();
    expect(globex.text).toBe("hello");
    expect(nobody.text).toBe("hello");
    expect(seen).toHaveLength(2);
  });

  test("spend from real calls fills the budget, and the next call is stopped", async () => {
    const seen = fakeGateway([{ text: "ok", input: 100_000, output: 10_000 }]);
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, budget: () => 0.02 });
    const agent = newAgent(weflayr);
    const context = () => weflayr.context({ customer: "acme" });

    // Each call costs 100000 * 0.1 / 1M + 10000 * 0.5 / 1M = $0.015
    const first = await agent.generate("hi", { requestContext: context() });
    const second = await agent.generate("hi", { requestContext: context() });
    const third = await agent.generate("hi", { requestContext: context() });

    expect(first.tripwire).toBeUndefined();
    expect(second.tripwire).toBeUndefined();
    expect(third.tripwire?.reason).toBe("acme has used $0.03 of its $0.02 monthly AI budget.");
    expect(seen).toHaveLength(2);
  });

  test("the guard stops a tool loop part way, before the next model step", async () => {
    const seen = fakeGateway([
      { toolCall: { name: "lookup", args: { id: "1" } }, input: 100_000, output: 10_000 },
      { text: "done" },
    ]);
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, budget: () => 0.01 });
    const agent = new Agent({
      id: "support",
      name: "support",
      instructions: "Use the tool.",
      tools: { lookup },
      ...weflayr.agent({ call: "support-reply", model: "claude-haiku-5-5" }),
    });
    const result = await agent.generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
      maxSteps: 5,
    });
    expect(seen).toHaveLength(1);
    expect(result.tripwire?.processorId).toBe("weflayr-budget-guard");
  });

  test("when the budget check fails the step runs by default, or is stopped with onBudgetError block", async () => {
    const seen = fakeGateway();
    const failing = () => {
      throw new Error("plans table unavailable");
    };
    const open = new Weflayr({ apiKey: "wf-test", budget: failing });
    const closed = new Weflayr({ apiKey: "wf-test", budget: failing, onBudgetError: "block" });

    const allowed = await newAgent(open).generate("hi", { requestContext: open.context({ customer: "acme" }) });
    const blocked = await newAgent(closed).generate("hi", { requestContext: closed.context({ customer: "acme" }) });

    expect(allowed.text).toBe("hello");
    expect(blocked.tripwire?.reason).toBe("Could not check the AI budget for acme.");
    expect(seen).toHaveLength(1);
  });

  test("budget() reports limit, spend and what is left", async () => {
    const spend = new MemorySpendStore();
    spend.add("acme", "2026-11", 3);
    const weflayr = new Weflayr({ spend, budget: () => 10 });
    expect(await weflayr.budget("acme", undefined, "2026-11")).toEqual({
      customer: "acme",
      month: "2026-11",
      limitUsd: 10,
      spentUsd: 3,
      remainingUsd: 7,
      allowed: true,
    });
    expect(await weflayr.budget("acme", undefined, "2026-12")).toMatchObject({ spentUsd: 0 });
    expect(await new Weflayr().budget("acme")).toMatchObject({ limitUsd: null, allowed: true });
  });
});

describe("downgrade, run budgets and the budget tool", () => {
  test("a customer past the downgrade point gets the cheaper model, priced as itself and tagged", async () => {
    const seen = fakeGateway([{ text: "ok", input: 1000, output: 100 }]);
    const spend = new MemorySpendStore();
    spend.add("acme", currentMonth(), 8.5);
    spend.add("globex", currentMonth(), 1);
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      prices: PRICES,
      spend,
      budget: () => 10,
      onCall: (record) => void calls.push(record),
    });
    const agent = new Agent({
      id: "draft",
      name: "draft",
      instructions: "Answer.",
      ...weflayr.agent({
        call: "draft-reply",
        model: "claude-opus-5-5",
        downgrade: { model: "claude-haiku-5-5", at: 0.8 },
      }),
    });

    await agent.generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });
    await agent.generate("hi", { requestContext: weflayr.context({ customer: "globex" }) });

    expect(seen.map((request) => request.body.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(metadataOf(seen[0]).tags).toEqual({ downgraded_from: "claude-opus-5-5" });
    expect(metadataOf(seen[1]).tags).toBeUndefined();
    expect(calls.map((record) => record.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(calls[0]!.costUsd).toBeCloseTo(0.00015, 10);
  });

  test("no downgrade without a budget, and a failed budget check keeps the usual model", async () => {
    const seen = fakeGateway();
    const plain = new Weflayr({ apiKey: "wf-test" });
    const broken = new Weflayr({
      apiKey: "wf-test",
      budget: () => {
        throw new Error("plans table unavailable");
      },
    });
    for (const weflayr of [plain, broken]) {
      const agent = new Agent({
        id: "draft",
        name: "draft",
        instructions: "Answer.",
        ...weflayr.agent({ call: "draft-reply", model: "claude-opus-5-5", downgrade: { model: "claude-haiku-5-5" } }),
      });
      await agent.generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });
    }
    expect(seen.map((request) => request.body.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
  });

  test("a run budget stops a tool loop once the run has spent it, and the next run starts fresh", async () => {
    const seen = fakeGateway([
      { toolCall: { name: "lookup", args: { id: "1" } }, input: 100_000, output: 10_000 },
      { text: "done" },
    ]);
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, runBudget: 0.01 });
    const agent = new Agent({
      id: "support",
      name: "support",
      instructions: "Use the tool.",
      tools: { lookup },
      ...weflayr.agent({ call: "support-reply", model: "claude-haiku-5-5" }),
    });

    const first = weflayr.context({ customer: "acme" });
    const result = await agent.generate("hi", { requestContext: first, maxSteps: 5 });

    expect(seen).toHaveLength(1);
    expect(weflayr.runCost(first)).toBeCloseTo(0.015, 10);
    expect(result.tripwire?.reason).toBe("This run has used $0.015 of its $0.01 budget.");
    expect(result.tripwire?.metadata as BudgetTripwire).toEqual({
      type: "weflayr-budget",
      scope: "run",
      customer: "acme",
      limitUsd: 0.01,
      spentUsd: 0.015,
    });

    const second = await agent.generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
      maxSteps: 5,
    });
    expect(second.tripwire).toBeUndefined();
  });

  test("agents that share one request context share one run budget, and the limit can depend on the request", async () => {
    const seen = fakeGateway([{ text: "ok", input: 100_000, output: 0 }]);
    const weflayr = new Weflayr({
      apiKey: "wf-test",
      prices: PRICES,
      runBudget: (rc) => (rc.get("weflayr-plan") === "pro" ? 1 : 0.005),
    });
    const research = newAgent(weflayr, "research");
    const summarise = newAgent(weflayr, "summarise");

    const free = weflayr.context({ customer: "acme", plan: "free" });
    await research.generate("hi", { requestContext: free });
    const stopped = await summarise.generate("hi", { requestContext: free });

    const pro = weflayr.context({ customer: "acme", plan: "pro" });
    await research.generate("hi", { requestContext: pro });
    const ran = await summarise.generate("hi", { requestContext: pro });

    expect(stopped.tripwire?.metadata).toMatchObject({ scope: "run" });
    expect(ran.tripwire).toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  test("the budget tool tells the agent what is left for the month and the run", async () => {
    const seen = fakeGateway([
      { toolCall: { name: "checkBudget", args: {} }, input: 1000, output: 100 },
      { text: "plenty left" },
    ]);
    const spend = new MemorySpendStore();
    spend.add("acme", currentMonth(), 4);
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, spend, budget: () => 10, runBudget: 1 });
    const agent = new Agent({
      id: "support",
      name: "support",
      instructions: "Check the budget first.",
      tools: { checkBudget: weflayr.budgetTool() },
      ...weflayr.agent({ call: "support-reply", model: "claude-haiku-5-5" }),
    });

    const result = await agent.generate("hi", {
      requestContext: weflayr.context({ customer: "acme" }),
      maxSteps: 3,
    });

    expect(result.text).toBe("plenty left");
    const toolResult = result.steps[0]?.toolResults[0] as { payload?: { result?: unknown }; result?: unknown } | undefined;
    expect(toolResult?.payload?.result ?? toolResult?.result).toEqual({
      customer: "acme",
      month: { limitUsd: 10, spentUsd: 4.00015, remainingUsd: 5.99985 },
      run: { limitUsd: 1, spentUsd: 0.00015, remainingUsd: 0.99985 },
    });
    expect(JSON.stringify(seen[1]?.body)).toContain("remainingUsd");
  });
});

describe("helpers", () => {
  test("spend is kept per customer and per month", () => {
    const spend = new MemorySpendStore();
    spend.add("acme", "2026-11", 1);
    spend.add("acme", "2026-11", 2);
    spend.add("acme", "2026-12", 5);
    spend.add("globex", "2026-11", 7);
    expect(spend.get("acme", "2026-11")).toBe(3);
    expect(spend.get("acme", "2026-12")).toBe(5);
    expect(spend.get("globex", "2026-11")).toBe(7);
    expect(spend.get("initech", "2026-11")).toBe(0);
  });

  test("months are UTC", () => {
    expect(currentMonth(Date.UTC(2026, 10, 30, 23, 59))).toBe("2026-11");
    expect(currentMonth(Date.UTC(2026, 11, 1, 0, 0))).toBe("2026-12");
  });

  test("cost is estimated with or without a provider prefix", () => {
    const weflayr = new Weflayr({ prices: PRICES });
    expect(weflayr.estimateCost("claude-opus-5-5", 4529, 1703)).toBeCloseTo(0.052176, 10);
    expect(weflayr.estimateCost("anthropic/claude-opus-5-5", 4529, 1703)).toBeCloseTo(0.052176, 10);
    expect(weflayr.estimateCost("unknown", 10, 10)).toBeUndefined();
    expect(new Weflayr().estimateCost("claude-opus-5-5", 10, 10)).toBeUndefined();
  });
});

describe("fallback", () => {
  test("with Mastra's model list, a gateway failure moves to the next model and the step is still recorded", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith(GATEWAY_URL)) {
        return new Response(JSON.stringify({ error: { message: "gateway down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "direct" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const calls: CallRecord[] = [];
    const weflayr = new Weflayr({ apiKey: "wf-test", prices: PRICES, onCall: (record) => void calls.push(record) });
    const agent = new Agent({
      id: "support",
      name: "support",
      instructions: "Answer.",
      model: [
        { model: weflayr.model("claude-haiku-5-5", { call: "support-reply" }), maxRetries: 0 },
        {
          model: { providerId: "direct", modelId: "claude-opus-5-5", url: "https://direct.example.com/v1", apiKey: "k" },
          maxRetries: 0,
        },
      ],
      inputProcessors: [weflayr.budgetGuard(), weflayr.modelCapture()],
      outputProcessors: [weflayr.costTracker({ call: "support-reply", model: "claude-haiku-5-5" })],
    });
    const result = await agent.generate("hi", { requestContext: weflayr.context({ customer: "acme" }) });

    expect(result.text).toBe("direct");
    expect(seen[0]).toBe(`${GATEWAY_URL}/chat/completions`);
    expect(seen.at(-1)).toBe("https://direct.example.com/v1/chat/completions");
    // The model that answered is recorded, so the cost uses its price.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", costSource: "estimated" });
    expect(calls[0]!.costUsd).toBeCloseTo(0.006, 10);
  }, 60_000);
});
