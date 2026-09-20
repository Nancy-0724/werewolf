import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDir)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
const pool = new Pool({ connectionString });
try {
  for (const name of migrationFiles) {
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    await pool.query(sql);
    console.log(`Migration ${name} applied.`);
  }
} finally {
  await pool.end();
}
