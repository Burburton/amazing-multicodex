import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { ok } from "../../../shared/core/result";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId, WorkspaceRef } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { ReleaseTaskWorkspaceWorkflow } from "./releaseTaskWorkspaceWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }

test("releases only a terminal task workspace without forcing dirty changes", async () => {
  const clock = new FixedClock();
  const repository = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "Task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  for (const status of ["queued", "preparing", "running", "validating", "readyForReview", "integrating", "completed"] as const) {
    created.value.transition(status, clock.now());
  }
  await repository.save(created.value, -1);
  const workspace: WorkspaceRef = {
    id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
    repositoryRoot: "/repo", worktreeRoot: "/trees", path: "/trees/task",
    branch: "multicodex/task", baseRef: "base"
  };
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution" as TaskExecutionId, taskId: "task" as TaskId, workspace,
    status: "completed", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const releases: unknown[] = [];
  const workspaces = { release: async (input: unknown) => { releases.push(input); return ok(undefined); } };
  const workflow = new ReleaseTaskWorkspaceWorkflow(
    new TaskLifecycleService(repository, clock), executions, workspaces as never
  );

  const result = await workflow.execute("task" as TaskId);
  assert.equal(result.ok, true);
  assert.deepEqual(releases, [{ workspace, force: false }]);
});

test("rejects release while task work remains reviewable", async () => {
  const clock = new FixedClock();
  const repository = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "Task", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await repository.save(created.value, -1);
  const workflow = new ReleaseTaskWorkspaceWorkflow(
    new TaskLifecycleService(repository, clock), new InMemoryExecutionRepository(), {} as never
  );

  const result = await workflow.execute("task" as TaskId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "workspace.task-not-terminal");
});
