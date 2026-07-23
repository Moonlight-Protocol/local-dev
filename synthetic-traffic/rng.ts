/**
 * Deterministic randomness for the synthetic-traffic engine.
 *
 * Every random draw derives from (masterSeed, purpose string) so the whole
 * timeline — council formation, provider joins, entity lifecycles, traffic
 * arrivals — is a pure function of the master secret and the genesis
 * timestamp. Restarts and catch-up runs replay the exact same schedule.
 */

/** 32-bit FNV-1a over a string, for seeding. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;

  /**
   * @param seedHex hex of the engine master seed (any long stable string)
   * @param purpose a stable label, e.g. `entity-join:meli:AR:17`
   */
  constructor(seedHex: string, purpose: string) {
    this.next = mulberry32(fnv1a(`${seedHex}|${purpose}`));
  }

  /** Uniform in [0, 1). */
  random(): number {
    return this.next();
  }

  /** Uniform in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.uniform(min, max + 1));
  }

  /** Pick one element. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Standard normal via Box–Muller. */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Lognormal sample around a median with shape sigma, clamped.
   * median=5, sigma=0.9 gives a natural "many small, few large" spread.
   */
  lognormal(median: number, sigma: number, min: number, max: number): number {
    const x = median * Math.exp(sigma * this.normal());
    return Math.min(max, Math.max(min, x));
  }

  /** Poisson sample (Knuth); fine for the small lambdas a tick produces. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  /** Weighted pick: entries of [item, weight]. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of entries) {
      r -= w;
      if (r <= 0) return item;
    }
    return entries[entries.length - 1][0];
  }
}
