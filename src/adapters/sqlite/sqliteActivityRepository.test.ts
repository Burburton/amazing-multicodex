import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKeyValueState } from "./sqliteKeyValueState";
import { SqliteActivityRepository } from "./sqliteActivityRepository";
import { SqliteTaskRepository } from "./sqliteTaskRepository";
import { Task, TaskId } from "../../modules/tasks/public";
import { ActivityId } from "../../modules/activity/public";

test("assigns and reads activity sequences from SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-activity-"));
  const state = new SqliteKeyValueState(join(root, "state.db"));
  const tasks = new SqliteTaskRepository(state.databasePort());
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: new Date("2026-08-21T00:00:00Z") });
  assert.equal(task.ok, true);
  if (task.ok) await tasks.save(task.value, -1);
  const repository = new SqliteActivityRepository(state.databasePort());
  await repository.append({ id: "activity-1" as ActivityId, taskId: "task-1" as TaskId, kind: "lifecycle", summary: "Queued", occurredAt: new Date("2026-08-21T00:00:00Z") });
  await repository.append({ id: "activity-2" as ActivityId, taskId: "task-1" as TaskId, kind: "lifecycle", summary: "Running", occurredAt: new Date("2026-08-21T00:01:00Z") });
  const listed = await repository.listByTask("task-1" as TaskId);
  assert.deepEqual(listed.ok && listed.value.map(item => item.sequence), [2, 1]);
  state.close();
  rmSync(root, { recursive: true, force: true });
});
