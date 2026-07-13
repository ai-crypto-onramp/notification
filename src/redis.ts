/**
 * Stage 9: Redis interface for dedup keys + rate-limit token buckets.
 *
 * The runtime can wire `ioredis` via `RedisAdapter`; tests use the
 * `InMemoryRedis` fake so no real Redis is required.
 */

export interface RedisClient {
  /** SET key value EX ttl; returns "OK". */
  set(key: string, value: string, ttlMs: number): Promise<string>;
  /** GET key; returns null when missing. */
  get(key: string): Promise<string | null>;
  /** SETNX-style conditional set with TTL. Returns 1 if set, 0 if already present. */
  setNxTtl(key: string, value: string, ttlMs: number): Promise<number>;
  /** DEL one or more keys; returns count removed. */
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
}

interface Entry {
  value: string;
  expires: number;
}

export class InMemoryRedis implements RedisClient {
  private store = new Map<string, Entry>();

  private gc(key: string): void {
    const e = this.store.get(key);
    if (e && e.expires <= Date.now()) this.store.delete(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<string> {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    this.gc(key);
    return this.store.get(key)?.value ?? null;
  }
  async setNxTtl(key: string, value: string, ttlMs: number): Promise<number> {
    this.gc(key);
    if (this.store.has(key)) return 0;
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    return 1;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async ping(): Promise<string> {
    return "PONG";
  }

  size(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  has(key: string): boolean {
    this.gc(key);
    return this.store.has(key);
  }
}

export const inMemoryRedis = new InMemoryRedis();

/** Active Redis client (defaults to the in-memory fake). */
let activeClient: RedisClient = inMemoryRedis;

export function getRedis(): RedisClient {
  return activeClient;
}

export function setRedis(client: RedisClient): void {
  activeClient = client;
}

export function dedupKey(eventId: string, channel: string, recipient: string): string {
  return `dedup:${eventId}|${channel}|${recipient}`;
}