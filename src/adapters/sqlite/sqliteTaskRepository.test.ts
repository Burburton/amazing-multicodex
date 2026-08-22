import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKeyValueState } from "./sqliteKeyValueState";
import { SqliteTaskRepository } from "./sqliteTaskRepository";
import { Task, TaskId } from "../../modules/tasks/public";

test("round-trips task aggregates through relational SQLite rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-task-"));
  const state = new SqliteKeyValueState(join(root, "state.db"));
  const repository = new SqliteTaskRepository(state.databasePort());
  const created = Task.create({ id: "task-1" as TaskId, title: "SQLite task", description: "persist me", acceptanceCriteria: ["works"], now: new Date("2026-08-21T00:00:00Z") });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal((await repository.save(created.value, -1)).ok, true);
  const found = await repository.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().description, "persist me");
  state.close();
  rmSync(root, { recursive: true, force: true });
});
