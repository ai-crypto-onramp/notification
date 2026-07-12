export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private rps: number,
    private capacity?: number,
  ) {
    this.tokens = capacity ?? rps;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity ?? this.rps, this.tokens + elapsed * this.rps);
    this.lastRefill = now;
  }

  /** Returns true if a token is available, false otherwise (throttle). */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait until a token is available (cooperative throttle without dropping). */
  async consume(): Promise<void> {
    let waited = 0;
    while (!this.tryConsume()) {
      const delay = Math.min(50 * (waited + 1), 1000);
      await new Promise((r) => setTimeout(r, delay));
      waited += 1;
    }
  }
}

export class RateLimiter {
  private buckets: Record<string, TokenBucket> = {};

  configure(channel: string, rps: number): void {
    this.buckets[channel] = new TokenBucket(rps);
  }

  get(channel: string): TokenBucket | undefined {
    return this.buckets[channel];
  }

  async consume(channel: string): Promise<void> {
    const bucket = this.buckets[channel];
    if (!bucket) return;
    await bucket.consume();
  }
}

export function envRps(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}