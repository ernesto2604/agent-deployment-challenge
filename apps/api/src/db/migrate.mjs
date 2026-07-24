import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createDatabasePool } from "../database.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../../..");
const migrationsDirectory = path.join(currentDirectory, "migrations");

dotenv.config({
  path: path.join(projectRoot, ".env"),
  quiet: true,
});

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const pool = createDatabasePool(databaseUrl);

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const existingMigration = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [migrationFile],
      );

      if (existingMigration.rowCount > 0) {
        console.log(`Skipping ${migrationFile}`);
        continue;
      }

      const migrationPath = path.join(
        migrationsDirectory,
        migrationFile,
      );

      const migrationSql = await fs.readFile(
        migrationPath,
        "utf8",
      );

      console.log(`Running ${migrationFile}`);

      await client.query("BEGIN");

      try {
        await client.query(migrationSql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [migrationFile],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Database migrations completed");
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
});