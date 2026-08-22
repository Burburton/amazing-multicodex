import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKeyValueState } from "./sqliteKeyValueState";
import { SqliteApprovalRepository } from "./sqliteApprovalRepository";
import { Approval, ApprovalId } from "../../modules/approvals/public";
import { TaskId } from "../../modules/tasks/public";
import { SqliteTaskRepository } from "./sqliteTaskRepository";

test("round-trips pending approvals through SQLite rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-approval-"));
  const state = new SqliteKeyValueState(join(root, "state.db"));
  const repository = new SqliteApprovalRepository(state.databasePort());
  const tasks = new SqliteTaskRepository(state.databasePort());
  const task = (await import("../../modules/tasks/public")).Task.create({ id: "task-1" as TaskId, title: "Task", now: new Date("2026-08-21T00:00:00Z") });
  assert.equal(task.ok, true);
  if (task.ok) await tasks.save(task.value, -1);
  const created = Approval.create({ id: "approval-1" as ApprovalId, taskId: "task-1" as TaskId, runtimeRequestId: "request-1", runtimeMethod: "approval", risk: "write", title: "Write file", payload: {}, now: new Date("2026-08-21T00:00:00Z") });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal((await repository.save(created.value, -1)).ok, true);
  const pending = await repository.findPendingByTask("task-1" as TaskId);
  assert.equal(pending.ok && pending.value.length, 1);
  state.close();
  rmSync(root, { recursive: true, force: true });
});
