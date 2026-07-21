/**
 * Redis runtime wiring: construct an ioredis client from REDIS_URL when set
 * and register it as the active RedisClient. Falls back to the in-memory
 * fake when REDIS_URL is unset (allowed only under DEV_MODE=1).
 */
import { Redis as Ioredis } from "ioredis";
import { setRedis, type RedisClient, inMemoryRedis } from "./redis.js";

class IoredisAdapter implements RedisClient {
  private client: Ioredis;
  constructor(url: string) {
    this.client = new Ioredis(url);
  }
  async set(key: string, value: string, ttlMs: number): Promise<string> {
    return this.client.set(key, value, "PX", ttlMs);
  }
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
  async setNxTtl(key: string, value: string, ttlMs: number): Promise<number> {
    const r = await this.client.set(key, value, "PX", ttlMs, "NX");
    return r === "OK" ? 1 : 0;
  }
  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }
  async ping(): Promise<string> {
    return this.client.ping();
  }
  async quit(): Promise<void> {
    await this.client.quit();
  }
}

let active: IoredisAdapter | null = null;

export function initRedis(url?: string): void {
  const u = url ?? process.env.REDIS_URL;
  if (!u) return;
  active = new IoredisAdapter(u);
  setRedis(active);
}

export async function closeRedis(): Promise<void> {
  if (active) {
    await active.quit();
    active = null;
    setRedis(inMemoryRedis);
  }
}