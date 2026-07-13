import { buildApp } from "./app.js";
import { consumer } from "./consumer.js";
import { initAuditEmitterFromEnv } from "./audit.js";

const app = buildApp({ logger: true });

export const start = async () => {
  const port = Number(process.env.PORT ?? 8080);
  initAuditEmitterFromEnv();
  try {
    await consumer.start();
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async () => {
  try {
    await consumer.stop();
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default app;