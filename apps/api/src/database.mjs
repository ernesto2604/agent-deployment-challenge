import pg from "pg";

const { Pool } = pg;

export function createDatabasePool(connectionString) {
  if (!connectionString) return null;

  const needsSsl = process.env.DATABASE_SSL === "true" ||
    (process.env.DATABASE_SSL !== "false" && (
      connectionString.includes("dpg-") ||
      connectionString.includes("render.com") ||
      connectionString.includes("sslmode=require")
    ));

  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function checkDatabase(pool) {
  if (!pool) {
    return {
      configured: false,
      connected: false,
      database: null,
      vectorEnabled: false,
    };
  }

  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        EXISTS (
          SELECT 1
          FROM pg_extension
          WHERE extname = 'vector'
        ) AS vector_enabled
    `);

    return {
      configured: true,
      connected: true,
      database: result.rows[0].database,
      vectorEnabled: result.rows[0].vector_enabled,
    };
  } catch (error) {
    console.error("Database connection error:", error?.message || error);
    return {
      configured: true,
      connected: false,
      database: null,
      vectorEnabled: false,
    };
  }
}