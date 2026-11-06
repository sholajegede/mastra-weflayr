import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import type {
  InputProcessor,
  OutputProcessor,
} from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";

export const GATEWAY_URL = "https://gateway.weflayr.com/v1";
export const METADATA_HEADER = "x-weflayr-metadata";

/** Request context keys this package reads. Set them with `weflayr.context()`. */
export const CUSTOMER_KEY = "weflayr-customer";
export const PLAN_KEY = "weflayr-plan";
export const RUN_KEY = "weflayr-run-id";
export const TAGS_KEY = "weflayr-tags";

export const BUDGET_GUARD_ID = "weflayr-budget-guard";
export const MODEL_CAPTURE_ID = "weflayr-model-capture";
export const COST_TRACKER_ID = "weflayr-cost-tracker";
export const BUDGET_TOOL_ID = "weflayr-check-budget";

/** Dollars per million tokens, by model id. */
export type Prices = Record<
  string,
  { inputPerMillion: number; outputPerMillion: number }
>;

/** Who a call is for. All fields are optional. */
export type CallContext = {
  customer?: string;
  plan?: string;
  runId?: string;
  tags?: Record<string, string>;
};

/** Where each customer's spend for the month is kept. */
export interface SpendStore {
  get(customer: string, month: string): number | Promise<number>;
  add(customer: string, month: string, usd: number): void | Promise<void>;
}

/** Keeps spend in memory. It is reset when the process restarts and is not shared between servers. */
export class MemorySpendStore implements SpendStore {
  private totals = new Map<string, number>();

  get(customer: string, month: string): number {
    return this.totals.get(`${customer}\u0000${month}`) ?? 0;
  }

  add(customer: string, month: string, usd: number): void {
    const key = `${customer}\u0000${month}`;
    this.totals.set(key, (this.totals.get(key) ?? 0) + usd);
  }
}

/** One model step, as the cost tracker saw it. */
export type CallRecord = {
  customer?: string;
  plan?: string;
  runId?: string;
  call: string;
  feature: string;
  model: string;
  /** The step number inside the agent run, starting at 0. A tool loop makes several steps. */
  step: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** "estimated" when the model is in your price table, "none" when it is not. */
  costSource: "estimated" | "none";
  at: number;
};

/** What the budget guard puts on `result.tripwire.metadata` when it stops a run. */
export type BudgetTripwire = {
  type: "weflayr-budget";
  /** "month" for the customer's monthly budget, "run" for the budget of one run. */
  scope: "month" | "run";
  customer?: string;
  /** Set when scope is "month". */
  month?: string;
  limitUsd: number;
  spentUsd: number;
};

/** Switch a customer to a cheaper model once they have used part of their monthly budget. */
export type Downgrade = {
  /** The model to use instead. */
  model: string;
  /** The share of the budget, from 0 to 1, after which new runs use `model`. Defaults to 0.8. */
  at?: number;
};

export type BudgetStatus = {
  customer: string;
  month: string;
  limitUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  allowed: boolean;
};

export type WeflayrOptions = {
  /** Defaults to the WEFLAYR_API_KEY environment variable. */
  apiKey?: string;
  baseURL?: string;
  /** Maps each call name to the feature it belongs to. A call that is not listed is filed under `defaultFeature`. */
  features?: Record<string, string>;
  /** Defaults to "other". */
  defaultFeature?: string;
  /** Dollars per million tokens, used to price each step. */
  prices?: Prices;
  /**
   * Who the call is for. Defaults to the `weflayr-customer` request context key,
   * then to Mastra's resource id (the `resource` you pass for memory).
   */
  customer?: (requestContext: RequestContext) => string | undefined;
  /** The customer's plan. Defaults to the `weflayr-plan` request context key. */
  plan?: (requestContext: RequestContext) => string | undefined;
  /** The customer's monthly budget in dollars. Return undefined or null for no limit. */
  budget?: (
    customer: string,
    requestContext: RequestContext,
  ) => number | null | undefined | Promise<number | null | undefined>;
  /**
   * The most one run may spend, in dollars. A run is everything done with one request context, so a
   * workflow that passes its request context to several agents shares one run budget.
   */
  runBudget?:
    | number
    | ((requestContext: RequestContext) => number | null | undefined);
  /** Defaults to a MemorySpendStore. Use your own store when you run more than one server. */
  spend?: SpendStore;
  /** Called after every model step with its tokens and cost. Errors here are logged and never fail the run. */
  onCall?: (record: CallRecord) => void | Promise<void>;
  /**
   * What the budget guard does when `budget` or the spend store throws.
   * "allow" (the default) logs a warning and lets the step run. "block" stops the run.
   */
  onBudgetError?: "allow" | "block";
};

type ModelChoice = string | ((requestContext: RequestContext) => string);

/** The month a timestamp falls in, in UTC, written YYYY-MM. */
export function currentMonth(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function dollars(value: number): string {
  return `$${Number(value.toFixed(6))}`;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export class Weflayr {
  private readonly spend: SpendStore;

  constructor(private readonly options: WeflayrOptions = {}) {
    this.spend = options.spend ?? new MemorySpendStore();
  }

  get baseURL(): string {
    return this.options.baseURL ?? GATEWAY_URL;
  }

  private apiKey(): string {
    const key = this.options.apiKey ?? process.env.WEFLAYR_API_KEY;
    if (!key) throw new Error("WEFLAYR_API_KEY is not set.");
    return key;
  }

  /** Puts the customer, plan, run id and tags on a request context, for `agent.generate(..., { requestContext })`. */
  context(
    meta: CallContext,
    requestContext: RequestContext = new RequestContext(),
  ): RequestContext {
    if (meta.customer !== undefined) requestContext.set(CUSTOMER_KEY, meta.customer);
    if (meta.plan !== undefined) requestContext.set(PLAN_KEY, meta.plan);
    if (meta.runId !== undefined) requestContext.set(RUN_KEY, meta.runId);
    if (meta.tags !== undefined) requestContext.set(TAGS_KEY, meta.tags);
    return requestContext;
  }

  /** The customer, plan, run id and tags this package reads from a request context. */
  read(requestContext?: RequestContext): CallContext {
    if (!requestContext) return {};
    const customer =
      (this.options.customer
        ? this.options.customer(requestContext)
        : undefined) ??
      asString(requestContext.get(CUSTOMER_KEY)) ??
      asString(requestContext.get(MASTRA_RESOURCE_ID_KEY));
    const plan =
      (this.options.plan ? this.options.plan(requestContext) : undefined) ??
      asString(requestContext.get(PLAN_KEY));
    const tags = requestContext.get(TAGS_KEY);
    return {
      customer,
      plan,
      runId: asString(requestContext.get(RUN_KEY)),
      tags:
        tags && typeof tags === "object"
          ? (tags as Record<string, string>)
          : undefined,
    };
  }

  featureOf(call: string): string {
    return (
      this.options.features?.[call] ?? this.options.defaultFeature ?? "other"
    );
  }

  /** The value of the x-weflayr-metadata header. Written as ASCII so any customer name is a valid header. */
  metadata(call: string, meta: CallContext = {}): string {
    const tags: Record<string, string> = { ...meta.tags };
    if (meta.plan) tags.plan = meta.plan;
    if (meta.runId) tags.run_id = meta.runId;
    return asciiJson({
      feature_name: this.featureOf(call),
      call_name: call,
      ...(meta.customer ? { customer_name: meta.customer } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
    });
  }

  /**
   * A fixed model config that goes through the gateway. Use it where there is no request context,
   * such as a scorer's judge model. Inside agents, use `model()` so each request names its customer.
   */
  config(
    modelId: string,
    options: { call: string } & CallContext,
  ): OpenAICompatibleConfig {
    const { call, ...meta } = options;
    return {
      providerId: "weflayr",
      modelId,
      url: this.baseURL,
      apiKey: this.apiKey(),
      headers: { [METADATA_HEADER]: this.metadata(call, meta) },
    };
  }

  /**
   * An agent model that goes through the gateway. Each request reads the customer, plan and run id
   * from its request context. `modelId` can be a function of the request context, to pick a model by plan.
   */
  model(
    modelId: ModelChoice,
    options: { call: string; downgrade?: Downgrade },
  ): (args: {
    requestContext: RequestContext;
  }) => Promise<OpenAICompatibleConfig> {
    return async ({ requestContext }) => {
      const meta = this.read(requestContext);
      const chosen = this.resolveModel(modelId, requestContext);
      const cheaper = await this.downgradeTo(
        chosen,
        options.downgrade,
        meta.customer,
        requestContext,
      );
      return this.config(cheaper ?? chosen, {
        call: options.call,
        ...meta,
        tags: cheaper ? { ...meta.tags, downgraded_from: chosen } : meta.tags,
      });
    };
  }

  private async downgradeTo(
    chosen: string,
    downgrade: Downgrade | undefined,
    customer: string | undefined,
    requestContext: RequestContext,
  ): Promise<string | undefined> {
    if (!downgrade || !customer || !this.options.budget) return undefined;
    if (downgrade.model === chosen) return undefined;
    try {
      const status = await this.budget(customer, requestContext);
      if (status.limitUsd === null) return undefined;
      const at = Math.min(Math.max(downgrade.at ?? 0.8, 0), 1);
      return status.spentUsd >= status.limitUsd * at ? downgrade.model : undefined;
    } catch (error) {
      console.warn(
        "mastra-weflayr could not check a budget, so the usual model runs:",
        describe(error),
      );
      return undefined;
    }
  }

  /** Dollars for a step, or undefined when the model is not in the price table. */
  estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number | undefined {
    const prices = this.options.prices;
    if (!prices) return undefined;
    const price =
      prices[model] ?? prices[model.slice(model.lastIndexOf("/") + 1)];
    if (!price) return undefined;
    return (
      (inputTokens * price.inputPerMillion +
        outputTokens * price.outputPerMillion) /
      1_000_000
    );
  }

  /** The customer's budget and spend for the month. A customer without a budget is always allowed. */
  async budget(
    customer: string,
    requestContext: RequestContext = new RequestContext(),
    month: string = currentMonth(),
  ): Promise<BudgetStatus> {
    const limit = this.options.budget
      ? await this.options.budget(customer, requestContext)
      : undefined;
    const limitUsd = typeof limit === "number" ? limit : null;
    const spentUsd = await this.spend.get(customer, month);
    return {
      customer,
      month,
      limitUsd,
      spentUsd,
      remainingUsd: limitUsd === null ? null : Math.max(limitUsd - spentUsd, 0),
      allowed: limitUsd === null || spentUsd < limitUsd,
    };
  }

  /**
   * An input processor that runs before every model step. When the customer has used their monthly
   * budget, it stops the run before the model is called. The result has `tripwire.metadata` set to a
   * BudgetTripwire. Because it runs before every step, it also stops a tool loop part way.
   */
  budgetGuard(): InputProcessor<BudgetTripwire> {
    return {
      id: BUDGET_GUARD_ID,
      processInputStep: async ({ requestContext, abort }) => {
        const { customer } = this.read(requestContext);
        const runLimit = this.runLimit(requestContext);
        if (runLimit !== null && requestContext) {
          const spentUsd = this.runSpend.get(requestContext) ?? 0;
          if (spentUsd >= runLimit) {
            abort(
              `This run has used ${dollars(spentUsd)} of its ${dollars(runLimit)} budget.`,
              {
                metadata: {
                  type: "weflayr-budget",
                  scope: "run",
                  customer,
                  limitUsd: runLimit,
                  spentUsd,
                },
              },
            );
          }
        }
        if (!customer || !this.options.budget) return;
        let status: BudgetStatus;
        try {
          status = await this.budget(
            customer,
            requestContext ?? new RequestContext(),
          );
        } catch (error) {
          if (this.options.onBudgetError === "block") {
            abort(`Could not check the AI budget for ${customer}.`);
          }
          console.warn(
            "mastra-weflayr could not check a budget, so the step runs:",
            describe(error),
          );
          return;
        }
        if (status.allowed || status.limitUsd === null) return;
        abort(
          `${customer} has used ${dollars(status.spentUsd)} of its ${dollars(status.limitUsd)} monthly AI budget.`,
          {
            metadata: {
              type: "weflayr-budget",
              scope: "month",
              customer,
              month: status.month,
              limitUsd: status.limitUsd,
              spentUsd: status.spentUsd,
            },
          },
        );
      },
    };
  }

  /**
   * An input processor that notes which model answered each step, so a fallback model is priced as
   * itself. Needs @mastra/core 1.34 or later (the supported range).
   */
  modelCapture(): InputProcessor {
    return {
      id: MODEL_CAPTURE_ID,
      processLLMResponse: async ({ model, requestContext }) => {
        const id = (model as { modelId?: unknown } | undefined)?.modelId;
        if (requestContext && typeof id === "string" && id !== "") {
          this.answered.set(requestContext, id);
        }
      },
    };
  }

  /**
   * An output processor that runs after every model step. It prices the step's tokens, adds the cost
   * to the customer's monthly spend and calls `onCall`. It never fails the run.
   */
  costTracker(options: { call: string; model: ModelChoice }): OutputProcessor {
    return {
      id: COST_TRACKER_ID,
      processOutputStep: async ({
        usage,
        stepNumber,
        requestContext,
        messages,
      }) => {
        try {
          const meta = this.read(requestContext);
          const answered = requestContext
            ? this.answered.get(requestContext)
            : undefined;
          const model =
            answered ??
            this.resolveModel(
                  options.model,
                  requestContext ?? new RequestContext(),
                );
          const inputTokens = usage?.inputTokens ?? 0;
          const outputTokens = usage?.outputTokens ?? 0;
          const estimated = this.estimateCost(model, inputTokens, outputTokens);
          const at = Date.now();
          const record: CallRecord = {
            customer: meta.customer,
            plan: meta.plan,
            runId: meta.runId,
            call: options.call,
            feature: this.featureOf(options.call),
            model,
            step: stepNumber,
            inputTokens,
            outputTokens,
            costUsd: estimated ?? 0,
            costSource: estimated === undefined ? "none" : "estimated",
            at,
          };
          if (requestContext && record.costUsd > 0) {
            this.runSpend.set(
              requestContext,
              (this.runSpend.get(requestContext) ?? 0) + record.costUsd,
            );
          }
          if (meta.customer && record.costUsd > 0) {
            await this.spend.add(meta.customer, currentMonth(at), record.costUsd);
          }
          await this.options.onCall?.(record);
        } catch (error) {
          console.warn(
            "mastra-weflayr could not record a step:",
            describe(error),
          );
        }
        return messages;
      },
    };
  }

  /**
   * The model, budget guard and cost tracker for one agent, with the same call name in all three.
   * Spread it into `new Agent({ ... })`.
   */
  agent(options: { call: string; model: ModelChoice; downgrade?: Downgrade }) {
    return {
      model: this.model(options.model, {
        call: options.call,
        downgrade: options.downgrade,
      }),
      inputProcessors: [this.budgetGuard(), this.modelCapture()],
      outputProcessors: [this.costTracker(options)],
    };
  }

  /**
   * A tool the agent can call to see how much of its budget is left, so it can plan around it.
   * Add it to the agent's `tools`.
   */
  budgetTool() {
    return createTool({
      id: BUDGET_TOOL_ID,
      description:
        "Shows how much of the AI budget is left for this customer this month and for this run, in US dollars. Call it before expensive work.",
      execute: async (_input, context) => {
        const requestContext = context?.requestContext ?? new RequestContext();
        const { customer } = this.read(requestContext);
        const runLimit = this.runLimit(requestContext);
        const runSpent = this.runSpend.get(requestContext) ?? 0;
        const month = customer ? await this.budget(customer, requestContext) : null;
        return {
          customer: customer ?? null,
          month: month && {
            limitUsd: month.limitUsd,
            spentUsd: month.spentUsd,
            remainingUsd: month.remainingUsd,
          },
          run: {
            limitUsd: runLimit,
            spentUsd: runSpent,
            remainingUsd:
              runLimit === null ? null : Math.max(runLimit - runSpent, 0),
          },
        };
      },
    });
  }

  /** What this run has spent so far, in dollars. A run is everything done with one request context. */
  runCost(requestContext: RequestContext): number {
    return this.runSpend.get(requestContext) ?? 0;
  }

  private runLimit(requestContext: RequestContext | undefined): number | null {
    const option = this.options.runBudget;
    if (option === undefined) return null;
    const limit =
      typeof option === "function"
        ? option(requestContext ?? new RequestContext())
        : option;
    return typeof limit === "number" ? limit : null;
  }

  private readonly answered = new WeakMap<object, string>();
  private readonly runSpend = new WeakMap<object, number>();

  private resolveModel(modelId: ModelChoice, requestContext: RequestContext) {
    return typeof modelId === "function" ? modelId(requestContext) : modelId;
  }
}
