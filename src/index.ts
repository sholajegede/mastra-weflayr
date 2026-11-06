import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import type {
  InputProcessor,
  OutputProcessor,
} from "@mastra/core/processors";
import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { type RiskStatus, WeflayrApi } from "./api.js";
import {
  MemorySpendStore,
  type SpendStore,
  WeflayrSpendStore,
  type WeflayrSpendOptions,
} from "./spend.js";

export * from "./api.js";
export * from "./spend.js";

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
  /** Weflayr's feature run id: 32 lowercase hex characters. Made for you when you leave it out. */
  runId?: string;
  tags?: Record<string, string>;
};

/** One model step, as the cost tracker saw it. */
export type CallRecord = {
  customer?: string;
  plan?: string;
  /** The Weflayr feature run this step belongs to. */
  runId?: string;
  call: string;
  feature: string;
  /** The model that answered. With a routing strategy, the model the strategy picked. */
  model: string;
  /** The step number inside the agent run, starting at 0. A tool loop makes several steps. */
  step: number;
  inputTokens: number;
  outputTokens: number;
  /** An estimate from your price table, used between reads of Weflayr's real cost. */
  costUsd: number;
  costSource: "estimated" | "none";
  /** Changes the gateway made to the request, from `weflayr_warnings`. */
  warnings?: unknown[];
  at: number;
};

/** What the budget guard puts on `result.tripwire.metadata` when it stops a run. */
export type BudgetTripwire = {
  type: "weflayr-budget";
  /** "month" for the customer's monthly budget, "run" for one run's budget, "margin" for a margin status. */
  scope: "month" | "run" | "margin";
  customer?: string;
  /** Set when scope is "month" or "margin". */
  month?: string;
  /** Set when scope is "month" or "run". */
  limitUsd?: number;
  spentUsd?: number;
  /** Set when scope is "margin". */
  riskStatus?: RiskStatus;
};

export type BudgetStatus = {
  customer: string;
  month: string;
  limitUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  allowed: boolean;
};

export type MarginStatus = {
  customer: string;
  month: string;
  riskStatus: RiskStatus | null;
  revenue: number | null;
  cost: number | null;
  marginPct: number | null;
};

export type WeflayrOptions = {
  /** The gateway key. Defaults to WEFLAYR_API_KEY. */
  apiKey?: string;
  baseURL?: string;
  /** The key for Weflayr's management API (cost, margin, revenue, tags). Defaults to WEFLAYR_MANAGEMENT_KEY, then WEFLAYR_API_KEY. */
  managementKey?: string;
  managementURL?: string;
  /** Maps each call name to the feature it belongs to. A call that is not listed is filed under `defaultFeature`. */
  features?: Record<string, string>;
  /** Defaults to "other". */
  defaultFeature?: string;
  /** Dollars per million tokens, used to estimate each step until Weflayr's real cost is read. */
  prices?: Prices;
  /**
   * Who the call is for. Defaults to the `weflayr-customer` request context key,
   * then to Mastra's resource id.
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
  /**
   * Where monthly spend comes from. "weflayr" reads each customer's real cost from Weflayr (needs a
   * management key). "memory" (the default) adds up estimates from `prices` in this process. Or pass
   * your own store.
   */
  spend?: "weflayr" | "memory" | SpendStore;
  /** Tuning for `spend: "weflayr"`. */
  weflayrSpend?: WeflayrSpendOptions;
  /** Margin statuses that stop a customer's run, for example ["unprofitable"]. Needs a management key. */
  stopOnMargin?: RiskStatus[];
  /** How long a margin status read from Weflayr is used. Defaults to 5 minutes. */
  marginRefreshMs?: number;
  /** Called after every model step with its tokens and estimated cost. Errors here are logged and never fail the run. */
  onCall?: (record: CallRecord) => void | Promise<void>;
  /** Called when the gateway changed a request. Defaults to a console warning. */
  onWarnings?: (warnings: unknown[], record: CallRecord) => void;
  /**
   * What the budget guard does when a budget, spend or margin check throws.
   * "allow" (the default) logs a warning and lets the step run. "block" stops the run.
   */
  onBudgetError?: "allow" | "block";
};

type ModelChoice = string | ((requestContext: RequestContext) => string);

const RUN_ID = /^[0-9a-f]{32}$/;

/** A new Weflayr feature run id: 32 lowercase hex characters. */
export function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** The model id for a Weflayr routing strategy, optionally pinned to one version. */
export function strategy(id: string, version?: number | string): string {
  return version === undefined ? `strategy/${id}` : `strategy/${id}:${version}`;
}

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

/** The model that answered, from the response, and the gateway's warnings when the response body is available. */
function readResponse(args: { chunks?: unknown[]; rawResponse?: unknown }) {
  let model: string | undefined;
  for (const chunk of args.chunks ?? []) {
    const item = chunk as { type?: string; payload?: { modelId?: unknown }; modelId?: unknown };
    if (item.type !== "response-metadata") continue;
    model = asString(item.payload?.modelId) ?? asString(item.modelId);
    if (model) break;
  }
  const body = (args.rawResponse as { body?: { weflayr_warnings?: unknown } } | undefined)?.body;
  const warnings = Array.isArray(body?.weflayr_warnings) ? body.weflayr_warnings : undefined;
  return { model, warnings };
}

export class Weflayr {
  private readonly spend: SpendStore;
  private apiClient?: WeflayrApi;
  private readonly answered = new WeakMap<object, { model?: string; warnings?: unknown[] }>();
  private readonly runSpend = new WeakMap<object, number>();
  private readonly runIds = new WeakMap<object, string>();
  private readonly margins = new Map<string, { status: MarginStatus; fetchedAt: number }>();

  constructor(private readonly options: WeflayrOptions = {}) {
    const spend = options.spend ?? "memory";
    this.spend =
      spend === "memory"
        ? new MemorySpendStore()
        : spend === "weflayr"
          ? new WeflayrSpendStore(this.api, options.weflayrSpend)
          : spend;
  }

  get baseURL(): string {
    return this.options.baseURL ?? GATEWAY_URL;
  }

  /** Weflayr's management API: cost, margin, revenue and customer tags. */
  get api(): WeflayrApi {
    this.apiClient ??= new WeflayrApi({
      apiKey: this.options.managementKey,
      baseURL: this.options.managementURL,
    });
    return this.apiClient;
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
    if (meta.runId !== undefined && !RUN_ID.test(meta.runId)) {
      throw new Error("A Weflayr run id is 32 lowercase hex characters. Make one with newRunId().");
    }
    if (meta.customer !== undefined) requestContext.set(CUSTOMER_KEY, meta.customer);
    if (meta.plan !== undefined) requestContext.set(PLAN_KEY, meta.plan);
    if (meta.runId !== undefined) requestContext.set(RUN_KEY, meta.runId);
    if (meta.tags !== undefined) requestContext.set(TAGS_KEY, meta.tags);
    return requestContext;
  }

  /** The Weflayr feature run of a request context. One is made the first time it is needed. */
  runId(requestContext: RequestContext): string {
    const given = asString(requestContext.get(RUN_KEY));
    if (given && RUN_ID.test(given)) return given;
    let id = this.runIds.get(requestContext);
    if (!id) {
      id = newRunId();
      this.runIds.set(requestContext, id);
    }
    return id;
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
      runId: this.runId(requestContext),
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
    return asciiJson({
      feature_name: this.featureOf(call),
      call_name: call,
      ...(meta.customer ? { customer_name: meta.customer } : {}),
      ...(meta.runId ? { feature_run_uuid: meta.runId } : {}),
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
   * An agent model that goes through the gateway. Each request reads the customer, plan and run from
   * its request context. `modelId` is a model name or `strategy(id, version)`, or a function of the
   * request context that returns one.
   */
  model(
    modelId: ModelChoice,
    options: { call: string },
  ): (args: { requestContext: RequestContext }) => OpenAICompatibleConfig {
    return ({ requestContext }) =>
      this.config(this.resolveModel(modelId, requestContext), {
        call: options.call,
        ...this.read(requestContext),
      });
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

  /** The customer's margin status for the month, from Weflayr. Cached for `marginRefreshMs`. */
  async margin(customer: string, month: string = currentMonth()): Promise<MarginStatus> {
    const key = `${customer}\u0000${month}`;
    const cached = this.margins.get(key);
    if (cached && Date.now() - cached.fetchedAt < (this.options.marginRefreshMs ?? 300_000)) {
      return cached.status;
    }
    const row = await this.api.customerMargin(customer, month);
    const status: MarginStatus = {
      customer,
      month,
      riskStatus: row?.risk_status ?? null,
      revenue: row?.revenue ?? null,
      cost: row?.cost ?? null,
      marginPct: row?.margin_pct ?? null,
    };
    this.margins.set(key, { status, fetchedAt: Date.now() });
    return status;
  }

  /** Sets tags such as the plan on customers in Weflayr, so its dashboards and margin views can split by them. */
  tagCustomers(customers: Record<string, Record<string, string | null>>) {
    return this.api.setCustomerTags(
      Object.entries(customers).map(([customer_name, tags]) => ({ customer_name, tags })),
    );
  }

  /** What this run has spent so far, in dollars, from your price table. */
  runCost(requestContext: RequestContext): number {
    return this.runSpend.get(requestContext) ?? 0;
  }

  /**
   * An input processor that runs before every model step. It stops the run before the model is
   * called when the run has used its run budget, the customer has used their monthly budget, or the
   * customer's margin status is in `stopOnMargin`. The result has `tripwire.metadata` set to a
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
        if (!customer) return;
        const context = requestContext ?? new RequestContext();
        let status: BudgetStatus | null = null;
        let margin: MarginStatus | null = null;
        try {
          if (this.options.budget) status = await this.budget(customer, context);
          if (this.options.stopOnMargin?.length) margin = await this.margin(customer);
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
        if (status && !status.allowed && status.limitUsd !== null) {
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
        }
        if (margin?.riskStatus && this.options.stopOnMargin?.includes(margin.riskStatus)) {
          abort(`${customer} is ${margin.riskStatus.replace("_", " ")} on AI margin this month.`, {
            metadata: {
              type: "weflayr-budget",
              scope: "margin",
              customer,
              month: margin.month,
              riskStatus: margin.riskStatus,
            },
          });
        }
      },
    };
  }

  /**
   * An input processor that notes which model answered each step, so a strategy's pick or a fallback
   * model is recorded and priced as itself, and keeps the gateway's warnings.
   */
  modelCapture(): InputProcessor {
    return {
      id: MODEL_CAPTURE_ID,
      processLLMResponse: async ({ model, chunks, rawResponse, requestContext }) => {
        if (!requestContext) return;
        const read = readResponse({ chunks, rawResponse });
        const declared = asString((model as { modelId?: unknown } | undefined)?.modelId);
        this.answered.set(requestContext, {
          model: read.model ?? declared,
          warnings: read.warnings,
        });
      },
    };
  }

  /**
   * An output processor that runs after every model step. It prices the step from your price table,
   * adds it to the run's and the customer's spend, and calls `onCall`. It never fails the run.
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
          const answered = requestContext ? this.answered.get(requestContext) : undefined;
          if (requestContext) this.answered.delete(requestContext);
          const model =
            answered?.model ??
            this.resolveModel(options.model, requestContext ?? new RequestContext());
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
            ...(answered?.warnings?.length ? { warnings: answered.warnings } : {}),
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
          if (record.warnings) {
            (this.options.onWarnings ??
              ((warnings) =>
                console.warn("The Weflayr gateway changed a request:", JSON.stringify(warnings))))(
              record.warnings,
              record,
            );
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
   * The model, budget guard, model capture and cost tracker for one agent, with the same call name in
   * all of them. Spread it into `new Agent({ ... })`.
   */
  agent(options: { call: string; model: ModelChoice }) {
    return {
      model: this.model(options.model, { call: options.call }),
      inputProcessors: [this.budgetGuard(), this.modelCapture()],
      outputProcessors: [this.costTracker(options)],
    };
  }

  /**
   * A tool the agent can call to see how much of its budget is left and its margin status, so it can
   * plan around it. Add it to the agent's `tools`.
   */
  budgetTool() {
    return createTool({
      id: BUDGET_TOOL_ID,
      description:
        "Shows how much of the AI budget is left for this customer this month and for this run, in US dollars, and the customer's margin status. Call it before expensive work.",
      execute: async (_input, context) => {
        const requestContext = context?.requestContext ?? new RequestContext();
        const { customer } = this.read(requestContext);
        const runLimit = this.runLimit(requestContext);
        const runSpent = this.runSpend.get(requestContext) ?? 0;
        const month = customer ? await this.budget(customer, requestContext) : null;
        let marginStatus: RiskStatus | null = null;
        if (customer && this.options.stopOnMargin?.length) {
          marginStatus = await this.margin(customer)
            .then((margin) => margin.riskStatus)
            .catch(() => null);
        }
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
          marginStatus,
        };
      },
    });
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

  private resolveModel(modelId: ModelChoice, requestContext: RequestContext) {
    return typeof modelId === "function" ? modelId(requestContext) : modelId;
  }
}
