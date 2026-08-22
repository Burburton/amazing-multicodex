import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { applySqliteMigrations } from "../../shared/ports/sqlite";
import { sqliteMigrations } from "./migrations";

/** SQLite-backed implementation of the existing state port.
 *
 * Keeping the state port means every repository can migrate without changing
 * its domain contract; records remain JSON-shaped until dedicated relational
 * repositories are introduced.
 */
export class SqliteKeyValueState implements KeyValueState {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const { DatabaseSync } = createRequire(__filename)("node:sqlite") as typeof import("node:sqlite");
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    const migrated = applySqliteMigrations(new DatabaseAdapter(this.database), sqliteMigrations);
    if (!migrated.ok) throw new Error(migrated.error.message);
  }

  get<T>(key: string, defaultValue: T): T {
    const row = this.database.prepare("SELECT value_json FROM kv_state WHERE key = ?").get(key) as { value_json?: unknown } | undefined;
    if (!row || typeof row.value_json !== "string") return defaultValue;
    try { return JSON.parse(row.value_json) as T; } catch { return defaultValue; }
  }

  update(key: string, value: unknown): Thenable<void> {
    this.write(key, value);
    return Promise.resolve();
  }

  importFrom(source: KeyValueState, keys: readonly string[]): void {
    for (const key of keys) {
      const value = source.get<unknown | undefined>(key, undefined);
      if (value !== undefined && this.get<unknown | undefined>(key, undefined) === undefined) this.write(key, value);
    }
  }

  close(): void { this.database.close(); }

  databasePort(): import("../../shared/ports/sqlite").SqliteDatabase { return new DatabaseAdapter(this.database); }

  private write(key: string, value: unknown): void {
    this.database.prepare("INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}

class DatabaseAdapter {
  constructor(private readonly database: DatabaseSync) {}
  exec(sql: string): void { this.database.exec(sql); }
  run(sql: string, parameters: readonly unknown[] = []): void { this.database.prepare(sql).run(...parameters as any[]); }
  query<T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): readonly T[] {
    return this.database.prepare(sql).all(...parameters as any[]) as T[];
  }
}
