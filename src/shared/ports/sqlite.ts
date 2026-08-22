import { Result, err, ok } from "../core/result";

/** Minimal driver surface so the domain never depends on a SQLite vendor. */
export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, parameters?: readonly unknown[]): void;
  query<T extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): readonly T[];
  transaction<T>(work: () => T): T;
}

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export function applySqliteMigrations(
  database: SqliteDatabase,
  migrations: readonly SqliteMigration[]
): Result<number> {
  if (!migrations.length) return ok(0);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (ordered.some((migration, index) => migration.version <= 0 || (index > 0 && migration.version === ordered[index - 1]?.version))) {
    return err({ code: "sqlite.migrations-invalid", category: "validation", message: "SQLite migrations must have unique positive versions.", retryable: false });
  }
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(database.query<{ version: number }>("SELECT version FROM schema_migrations").map(row => row.version));
  let latest = 0;
  for (const migration of ordered) {
    if (applied.has(migration.version)) { latest = migration.version; continue; }
    database.exec(migration.sql);
    database.exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${escapeSql(migration.name)}', '${new Date().toISOString()}')`);
    latest = migration.version;
  }
  return ok(latest);
}

function escapeSql(value: string): string { return value.replace(/'/g, "''"); }
