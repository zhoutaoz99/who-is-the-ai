import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createClient } from "redis";

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client = createClient({
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  });
  private connected = false;

  constructor() {
    this.client.on("error", (error) => {
      this.logger.error(`Redis error: ${(error as Error).message}`);
    });
  }

  async onModuleInit() {
    await this.client.connect();
    this.connected = true;
    await this.client.ping();
  }

  async onModuleDestroy() {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  async get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, { EX: ttlSeconds });
      return;
    }

    await this.client.set(key, value);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      await this.del(key);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number) {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async del(key: string) {
    await this.client.del(key);
  }
}
