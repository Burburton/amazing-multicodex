import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKeyValueState } from "./sqliteKeyValueState";

test("persists JSON state across SQLite connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-sqlite-"));
  const path = join(root, "state.db");
  const first = new SqliteKeyValueState(path);
  await first.update("tasks", [{ id: "task-1", status: "queued" }]);
  first.close();
  const second = new SqliteKeyValueState(path);
  assert.deepEqual(second.get("tasks", []), [{ id: "task-1", status: "queued" }]);
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test("rolls back a failed SQLite transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-sqlite-tx-"));
  const state = new SqliteKeyValueState(join(root, "state.db"));
  const database = state.databasePort();
  assert.throws(() => database.transaction(() => {
    database.run("INSERT INTO projects (id, name, repository_root, base_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["project-1", "Project", "/repo", "HEAD", "now", "now"]);
    throw new Error("rollback");
  }));
  assert.equal(database.query("SELECT id FROM projects WHERE id = ?", ["project-1"]).length, 0);
  state.close();
  rmSync(root, { recursive: true, force: true });
});
