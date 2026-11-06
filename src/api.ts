export const MANAGEMENT_URL = "https://app.weflayr.com/api";

/** A customer's margin status in Weflayr. The thresholds behind each one are set in the Weflayr dashboard. */
export type RiskStatus =
  | "healthy"
  | "watch"
  | "at_risk"
  | "unprofitable"
  | (string & {});

export type Aggregate = "day" | "week" | "month" | "quarter" | "year" | "all";

export type CostsInput = {
  date_from: string;
  date_to?: string;
  aggregate?: Aggregate;
  group_by?: "customer" | "feature" | "model" | "provider" | "call_name";
  customers?: string[];
  features?: string[];
  call_names?: string[];
  models?: string[];
  providers?: string[];
  customer_tags?: Record<string, string | string[]>;
  run_tags?: Record<string, string | string[]>;
  apply_credits?: boolean;
  limit?: number;
  cursor?: string;
};

export type CostRow = {
  date_from: string;
  date_to: string;
  customer?: string;
  feature?: string;
  model?: string;
  provider?: string;
  call_name?: string;
  cost: number;
  avg_feature_run_cost?: number;
  max_feature_run_cost?: number;
};

export type MarginInput = {
  date_from: string;
  date_to?: string;
  aggregate?: Aggregate;
  group_by?: "customer";
  customers?: string[];
  call_names?: string[];
  filter_customers_based_on_features?: string[];
  apply_credits?: boolean;
  limit?: number;
  cursor?: string;
};

export type MarginRow = {
  date_from: string;
  date_to: string;
  customer?: string;
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number | null;
  risk_status: RiskStatus;
};

export type Page<T> = { rows: T[]; next_cursor: string | null; has_more: boolean };

export type RevenueRow = {
  /** The same customer name your model calls carry. */
  customer_name: string;
  amount: number;
  /** "YYYY-MM". Or set month_start and month_end for a period longer than a month. */
  month?: string;
  month_start?: string;
  month_end?: string;
  /** An id from your billing system. With `upsert`, sending the same id again overwrites the row instead of adding to it. */
  revenue_id?: string;
};

export type CustomerTags = {
  customer_name: string;
  /** A string sets the tag, null deletes it. Keys you leave out are not changed. */
  tags: Record<string, string | null>;
};

export class WeflayrApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WeflayrApiError";
  }
}

const MAX_ROWS = 1000;

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_ROWS) out.push(items.slice(i, i + MAX_ROWS));
  return out;
}

/** The first and last day of a "YYYY-MM" month. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, monthIndex] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * A small client for Weflayr's management API: cost, margin, revenue and customer tags.
 * It needs a key with the Management scope.
 */
export class WeflayrApi {
  constructor(
    private readonly options: { apiKey?: string; baseURL?: string } = {},
  ) {}

  private key(): string {
    const key =
      this.options.apiKey ??
      process.env.WEFLAYR_MANAGEMENT_KEY ??
      process.env.WEFLAYR_API_KEY;
    if (!key) {
      throw new Error("Set WEFLAYR_MANAGEMENT_KEY, or WEFLAYR_API_KEY with the Management scope.");
    }
    return key;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseURL ?? MANAGEMENT_URL}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.key()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Set WEFLAYR_")) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const code = (cause as { code?: string }).code;
      throw new Error(
        `Could not reach Weflayr's management API (${this.options.baseURL ?? MANAGEMENT_URL}${path}): ${
          cause instanceof Error ? cause.message : String(cause)
        }${code ? ` [${code}]` : ""}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
        message = String(parsed.error ?? JSON.stringify(parsed.detail ?? parsed)).slice(0, 300);
      } catch {
        // keep the raw text
      }
      throw new WeflayrApiError(
        response.status,
        `Weflayr ${path} answered ${response.status}: ${message}`,
      );
    }
    return JSON.parse(text) as T;
  }

  getCosts(input: CostsInput): Promise<Page<CostRow>> {
    return this.post("/costs/", input);
  }

  getMargin(input: MarginInput): Promise<Page<MarginRow>> {
    return this.post("/margin/", input);
  }

  /** Books revenue per customer and month. Sends 1,000 rows per request. */
  async setRevenue(rows: RevenueRow[], options: { upsert?: boolean } = {}) {
    let inserted = 0;
    for (const part of chunk(rows)) {
      const result = await this.post<{ rows_inserted?: number }>("/revenue/", {
        rows: part,
        upsert: options.upsert ?? true,
      });
      inserted += result.rows_inserted ?? part.length;
    }
    return { rowsInserted: inserted };
  }

  /** Sets tags such as the plan on customers. Sends 1,000 customers per request. */
  async setCustomerTags(customers: CustomerTags[], options: { upsert?: boolean } = {}) {
    let updated = 0;
    for (const part of chunk(customers)) {
      const result = await this.post<{ customers_updated?: number }>("/customer-tags/", {
        customers: part,
        upsert: options.upsert ?? true,
      });
      updated += result.customers_updated ?? part.length;
    }
    return { customersUpdated: updated };
  }

  /** What Weflayr has recorded for one customer in one month, in dollars, at list price. */
  async customerCost(customer: string, month: string): Promise<number> {
    const { from, to } = monthRange(month);
    const page = await this.getCosts({
      date_from: from,
      date_to: to,
      aggregate: "all",
      group_by: "customer",
      customers: [customer],
    });
    return page.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  }

  /** One customer's margin for one month, or null when Weflayr has no row for them. */
  async customerMargin(customer: string, month: string): Promise<MarginRow | null> {
    const { from, to } = monthRange(month);
    const page = await this.getMargin({
      date_from: from,
      date_to: to,
      aggregate: "all",
      group_by: "customer",
      customers: [customer],
    });
    return page.rows[0] ?? null;
  }
}
