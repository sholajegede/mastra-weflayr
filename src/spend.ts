import type { WeflayrApi } from "./api.js";

/** Where each customer's spend for the month is read from and added to. */
export interface SpendStore {
  get(customer: string, month: string): number | Promise<number>;
  add(customer: string, month: string, usd: number): void | Promise<void>;
}

const keyOf = (customer: string, month: string) => `${customer}\u0000${month}`;

/** Keeps spend in memory, from your price table. It is reset on restart and not shared between servers. */
export class MemorySpendStore implements SpendStore {
  private totals = new Map<string, number>();

  get(customer: string, month: string): number {
    return this.totals.get(keyOf(customer, month)) ?? 0;
  }

  add(customer: string, month: string, usd: number): void {
    const key = keyOf(customer, month);
    this.totals.set(key, (this.totals.get(key) ?? 0) + usd);
  }
}

export type WeflayrSpendOptions = {
  /** How long a cost read from Weflayr is used before it is read again. Defaults to 60 seconds. */
  refreshMs?: number;
  /**
   * How long a step's estimated cost is still added on top of Weflayr's figure, to cover the time
   * Weflayr takes to record it. Defaults to 5 minutes. A step inside this window may be counted twice,
   * so the spend can read slightly high, never low.
   */
  settleMs?: number;
};

type Cached = { usd: number; fetchedAt: number };

/**
 * Reads each customer's real cost for the month from Weflayr, the same figure its dashboard shows,
 * and adds the estimated cost of steps too recent for Weflayr to have recorded yet.
 */
export class WeflayrSpendStore implements SpendStore {
  private cache = new Map<string, Cached>();
  private inflight = new Map<string, Promise<Cached>>();
  private pending = new Map<string, { usd: number; at: number }[]>();
  private readonly refreshMs: number;
  private readonly settleMs: number;

  constructor(
    private readonly api: WeflayrApi,
    options: WeflayrSpendOptions = {},
  ) {
    this.refreshMs = options.refreshMs ?? 60_000;
    this.settleMs = options.settleMs ?? 300_000;
  }

  private async fetch(customer: string, month: string): Promise<Cached> {
    const key = keyOf(customer, month);
    const running = this.inflight.get(key);
    if (running) return running;
    const started = Date.now();
    const promise = this.api
      .customerCost(customer, month)
      .then((usd) => {
        const cached = { usd, fetchedAt: started };
        this.cache.set(key, cached);
        return cached;
      })
      .catch((error: unknown) => {
        const last = this.cache.get(key);
        if (last) return last;
        throw error;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async get(customer: string, month: string): Promise<number> {
    const key = keyOf(customer, month);
    let cached = this.cache.get(key);
    if (!cached || Date.now() - cached.fetchedAt >= this.refreshMs) {
      cached = await this.fetch(customer, month);
    }
    const since = cached.fetchedAt - this.settleMs;
    const recent = (this.pending.get(key) ?? []).filter((entry) => entry.at > since);
    this.pending.set(key, recent);
    return cached.usd + recent.reduce((sum, entry) => sum + entry.usd, 0);
  }

  add(customer: string, month: string, usd: number): void {
    const key = keyOf(customer, month);
    const list = this.pending.get(key) ?? [];
    list.push({ usd, at: Date.now() });
    this.pending.set(key, list);
  }
}
