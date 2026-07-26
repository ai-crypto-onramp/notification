import { buildApp } from "./app.js";
import { consumer } from "./consumer.js";
import { KafkaBus } from "./kafka-bus.js";
import { initAuditEmitterFromEnv } from "./audit.js";
import { store } from "./store.js";
import { initPg, applyMigrations, pgHydrate, closePg, pgEnabled } from "./pgstore.js";
import { startTracing, shutdownTracing } from "./tracing.js";
import { createProviders } from "./providers.js";
import { emailChannel, smsChannel, pushChannel } from "./channels.js";
import { initRedis, closeRedis } from "./redis-runtime.js";

function parseKafkaBrokersFromUrl(url?: string): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "kafka:") return [];
    const host = parsed.hostname;
    const port = parsed.port || "9092";
    return host ? [`${host}:${port}`] : [];
  } catch {
    return [];
  }
}

startTracing();

const app = buildApp({ logger: true });

export const start = async () => {
  const port = Number(process.env.PORT ?? 8080);
  const devMode = process.env.DEV_MODE === "1";
  initAuditEmitterFromEnv();
  initPg();
  initRedis();
  if (pgEnabled()) {
    app.log.info("DB_URL set; applying migrations and hydrating from Postgres");
    await applyMigrations();
    await pgHydrate(store);
  } else {
    if (!devMode) {
      app.log.error("DB_URL not set and DEV_MODE!=1; refusing to start in production mode");
      process.exit(1);
    }
    app.log.info("DEV_MODE=1: DB_URL unset; running in-memory (NOT FOR PRODUCTION)");
  }
  // Wire real providers from env (stubs when DEV_MODE=1, fatal otherwise).
  const providers = createProviders({ devMode, logger: app.log });
  emailChannel.setProvider(providers.ses);
  smsChannel.setProviders(providers.sns, providers.twilio);
  pushChannel.setProviders(providers.fcm, providers.apns);
  try {
    const brokers = process.env.KAFKA_BROKERS
      ? process.env.KAFKA_BROKERS.split(",").map((s) => s.trim()).filter(Boolean)
      : parseKafkaBrokersFromUrl(process.env.EVENT_BUS_URL);
    if (brokers.length > 0) {
      app.log.info(`KAFKA_BROKERS/EVENT_BUS_URL set; wiring KafkaBus (${brokers.join(",")})`);
      const bus = new KafkaBus({ brokers });
      await consumer.replaceBus(bus);
      await consumer.start();
    } else if (!devMode) {
      app.log.error("EVENT_BUS_URL (or KAFKA_BROKERS) required in production mode; in-memory bus is not safe for production");
      process.exit(1);
    } else {
      app.log.warn("DEV_MODE=1: EVENT_BUS_URL unset — using InMemoryEventBus (NOT FOR PRODUCTION)");
      await consumer.start();
    }
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1)
  }
};

const shutdown = async () => {
  try {
    await consumer.stop();
    await app.close();
  } finally {
    await shutdownTracing();
    await closePg();
    await closeRedis();
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default app;