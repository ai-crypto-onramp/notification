import { buildApp } from "./app.js";
import { consumer, EventBusConsumer } from "./consumer.js";
import { KafkaBus } from "./kafka-bus.js";
import { initAuditEmitterFromEnv } from "./audit.js";
import { store } from "./store.js";
import { initPg, applyMigrations, pgHydrate, closePg, pgEnabled } from "./pgstore.js";
import { startTracing, shutdownTracing } from "./tracing.js";
import { createProviders } from "./providers.js";
import { emailChannel, smsChannel, pushChannel } from "./channels.js";
import { initRedis, closeRedis } from "./redis-runtime.js";

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
    if (process.env.KAFKA_BROKERS) {
      app.log.info(`KAFKA_BROKERS set; wiring KafkaBus (${process.env.KAFKA_BROKERS})`);
      const bus = new KafkaBus({ brokers: process.env.KAFKA_BROKERS.split(",").map((s) => s.trim()) });
      const realConsumer = new EventBusConsumer(bus, { group: process.env.EVENT_CONSUMER_GROUP ?? "notification" });
      // Replace the singleton consumer's bus by re-binding start/stop to the real bus.
      await realConsumer.start();
      // Keep the imported `consumer` singleton subscribed for /readyz parity in dev mode.
      if (devMode) await consumer.start();
    } else if (process.env.EVENT_BUS_URL) {
      app.log.info("EVENT_BUS_URL set; real event bus client not yet wired — keeping in-memory bus");
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