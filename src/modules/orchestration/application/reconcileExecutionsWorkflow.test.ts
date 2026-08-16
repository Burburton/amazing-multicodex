import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId, WorkspaceRef, WorkspaceSnapshot } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { ReconcileExecutionsWorkflow } from "./reconcileExecutionsWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }

test("keeps running executions resumable and blocks interrupted preparation", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const executions = new InMemoryExecutionRepository();
  for (const [id, executionStatus] of [["running", "running"], ["preparing", "prepared"]] as const) {
    const created = Task.create({ id: id as TaskId, title: id, now: clock.now() });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    created.value.transition("queued", clock.now());
    created.value.transition("preparing", clock.now());
    if (id === "running") created.value.transition("running", clock.now());
    await tasks.save(created.value, -1);
    await executions.save({
      id: `${id}-execution` as TaskExecutionId,
      taskId: id as TaskId,
      workspace: workspace(id),
      status: executionStatus,
      createdAt: clock.now(), updatedAt: clock.now(), version: 0
    }, -1);
  }
  const workspaces = { inspect: async (value: WorkspaceRef): Promise<Result<WorkspaceSnapshot>> => ok({ ...value, headCommit: "head", dirty: false }) };
  const result = await new ReconcileExecutionsWorkflow(
    executions, new TaskLifecycleService(tasks, clock), workspaces as never, clock
  ).execute();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.resumable, ["running"]);
  assert.deepEqual(result.value.blocked, ["preparing"]);
  const blocked = await tasks.findById("preparing" as TaskId);
  assert.equal(blocked.ok && blocked.value?.snapshot().status, "blocked");
  const active = await executions.listActive();
  assert.equal(active.ok && active.value.length, 1);
});

test("blocks a running execution whose persisted worktree is unavailable", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) created.value.transition(status, clock.now());
  await tasks.save(created.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution" as TaskExecutionId, taskId: "task" as TaskId, workspace: workspace("task"),
    status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const unavailable: AppError = { code: "workspace.missing", category: "unavailable", message: "missing", retryable: false };
  const workspaces = { inspect: async () => err(unavailable) };
  const result = await new ReconcileExecutionsWorkflow(
    executions, new TaskLifecycleService(tasks, clock), workspaces as never, clock
  ).execute();

  assert.equal(result.ok, true);
  const task = await tasks.findById("task" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().status, "blocked");
});

function workspace(id: string): WorkspaceRef {
  return {
    id: `${id}-workspace` as WorkspaceId, taskId: id as TaskId,
    repositoryRoot: "/repo", worktreeRoot: "/trees", path: `/trees/${id}`,
    branch: `multicodex/${id}`, baseRef: "base"
  };
}
