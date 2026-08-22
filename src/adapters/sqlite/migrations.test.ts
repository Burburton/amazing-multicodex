import assert from "node:assert/strict";
import test from "node:test";
import { sqliteMigrations } from "./migrations";
import { applySqliteMigrations, SqliteDatabase } from "../../shared/ports/sqlite";

class FakeDatabase implements SqliteDatabase {
  readonly statements: string[] = [];
  versions: number[] = [];
  exec(sql: string): void { this.statements.push(sql); }
  run(sql: string): void { this.statements.push(sql); }
  query<T extends Record<string, unknown>>(): readonly T[] { return this.versions.map(version => ({ version } as unknown as T)); }
}

test("applies the core SQLite schema once and records the latest version", () => {
  const database = new FakeDatabase();
  const first = applySqliteMigrations(database, sqliteMigrations);
  assert.equal(first.ok && first.value, 1);
  assert.match(database.statements[1] ?? "", /CREATE TABLE IF NOT EXISTS projects/);
  database.versions = [1];
  const count = database.statements.length;
  const second = applySqliteMigrations(database, sqliteMigrations);
  assert.equal(second.ok && second.value, 1);
  assert.equal(database.statements.length, count + 1);
});
