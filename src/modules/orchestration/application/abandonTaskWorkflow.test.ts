import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { AbandonTaskWorkflow } from "./abandonTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }

test("cancels persisted task and execution state without a runtime connection", async () => {
  const clock = new FixedClock();
  const repository = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "Task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) created.value.transition(status, clock.now());
  await repository.save(created.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution" as TaskExecutionId, taskId: "task" as TaskId,
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/trees", path: "/trees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);

  const result = await new AbandonTaskWorkflow(
    new TaskLifecycleService(repository, clock), executions, clock
  ).execute("task" as TaskId);

  assert.equal(result.ok, true);
  const task = await repository.findById("task" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().status, "cancelled");
  const active = await executions.listActive();
  assert.equal(active.ok && active.value.length, 0);
});

test("refuses to abandon a task that is not running", async () => {
  const clock = new FixedClock();
  const repository = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "Task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await repository.save(created.value, -1);
  const result = await new AbandonTaskWorkflow(
    new TaskLifecycleService(repository, clock), new InMemoryExecutionRepository(), clock
  ).execute("task" as TaskId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "task.not-abandonable");
});
