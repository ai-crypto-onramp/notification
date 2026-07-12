import { buildApp } from "./app.js";

const app = buildApp({ logger: true });

export const start = async () => {
  const port = Number(process.env.PORT ?? 8080);
  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export default app;