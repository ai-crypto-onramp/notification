import { Pool, type PoolClient } from "pg";

export const pool = new Pool({
  connectionString: process.env.DB_URL ?? "postgres://postgres:postgres@localhost:5432/notification",
});

export const query = (text: string, params?: ReadonlyArray<unknown>) =>
  pool.query(text, params as unknown[] | undefined);

export const withTransaction = async <T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export const closePool = async (): Promise<void> => {
  await pool.end();
};