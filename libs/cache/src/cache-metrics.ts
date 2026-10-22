import type { CacheMetrics } from './cache.types.js';

/** 进程内指标累加器；只做原子自增和快照，不引入 Prometheus 等额外依赖。 */
export class CacheMetricsCollector {
  private readonly counters: CacheMetrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    readErrors: 0,
    writeErrors: 0,
    deleteErrors: 0,
    decodeErrors: 0,
    coalesced: 0,
  };

  increment(counter: keyof CacheMetrics, amount = 1): void {
    this.counters[counter] += amount;
  }

  snapshot(): Readonly<CacheMetrics> {
    return { ...this.counters };
  }

  reset(): void {
    for (const key of Object.keys(this.counters) as (keyof CacheMetrics)[]) {
      this.counters[key] = 0;
    }
  }
}
