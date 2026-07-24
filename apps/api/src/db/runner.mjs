import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(currentDirectory, "migrations");

export async function performMigrations(pool) {
  if (!pool) return;

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'users'
        ) AS users_exist
      `);
      const usersExist = tableCheck.rows[0]?.users_exist;

      const migrationFiles = (await fs.readdir(migrationsDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();

      for (const migrationFile of migrationFiles) {
        if (usersExist && migrationFile === "001_initial_schema.sql") {
          const existingMigration = await client.query(
            "SELECT 1 FROM schema_migrations WHERE name = $1",
            [migrationFile],
          );
          if (existingMigration.rowCount > 0) continue;
        }

        const migrationPath = path.join(migrationsDirectory, migrationFile);
        const migrationSql = await fs.readFile(migrationPath, "utf8");

        console.log(`Running migration: ${migrationFile}`);
        await client.query("BEGIN");
        try {
          await client.query(migrationSql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
            [migrationFile],
          );
          await client.query("COMMIT");
          console.log(`Migration ${migrationFile} applied successfully`);
        } catch (error) {
          await client.query("ROLLBACK");
          console.error(`Migration ${migrationFile} error:`, error.message);
          throw error;
        }
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Auto-migration connection error:", error.message);
    throw error;
  }
}
