import { buildApp } from "./app.js";
import { consumer } from "./consumer.js";
import { initAuditEmitterFromEnv } from "./audit.js";
import { store } from "./store.js";
import { initPg, applyMigrations, pgHydrate, closePg, pgEnabled } from "./pgstore.js";

const app = buildApp({ logger: true });

export const start = async () => {
  const port = Number(process.env.PORT ?? 8080);
  const devMode = process.env.DEV_MODE === "1";
  initAuditEmitterFromEnv();
  initPg();
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
  try {
    if (process.env.EVENT_BUS_URL || process.env.KAFKA_BROKERS) {
      app.log.info("EVENT_BUS_URL set; real event bus client not yet wired — keeping in-memory bus");
    } else if (!devMode) {
      app.log.error("EVENT_BUS_URL (or KAFKA_BROKERS) required in production mode; in-memory bus is not safe for production");
      process.exit(1);
    } else {
      app.log.warn("DEV_MODE=1: EVENT_BUS_URL unset — using InMemoryEventBus (NOT FOR PRODUCTION)");
    }
    await consumer.start();
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
    await closePg();
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default app;