import assert from "node:assert/strict";
import test from "node:test";
import { ActivityDeletionRepository } from "../../activity/public";
import { ApprovalDeletionRepository } from "../../approvals/public";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { SystemClock } from "../../../shared/core/clock";
import { InMemoryTaskDependencyRepository } from "../../tasks/adapters/inMemoryTaskDependencyRepository";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService, TaskProps } from "../../tasks/public";
import { ChangeSet, PrepareWorkspaceInput, ReleaseWorkspaceInput, WorkspacePort, WorkspaceRef, WorkspaceSnapshot } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { DeleteTaskWorkflow } from "./deleteTaskWorkflow";

class CleanupMemory implements ActivityDeletionRepository, ApprovalDeletionRepository {
  readonly deleted: TaskId[] = [];
  async deleteByTask(taskId: TaskId): Promise<Result<void>> {
    this.deleted.push(taskId);
    return ok(undefined);
  }
}

class WorkspaceMemory implements WorkspacePort {
  releases = 0;
  lastForce?: boolean;
  releaseFailure?: AppError;
  prepare(_input: PrepareWorkspaceInput): Promise<Result<WorkspaceRef>> { throw new Error("unused"); }
  inspect(_workspace: WorkspaceRef): Promise<Result<WorkspaceSnapshot>> { throw new Error("unused"); }
  diff(_workspace: WorkspaceRef): Promise<Result<ChangeSet>> { throw new Error("unused"); }
  async release(input: ReleaseWorkspaceInput): Promise<Result<void>> {
    this.releases += 1;
    this.lastForce = input.force;
    return this.releaseFailure ? err(this.releaseFailure) : ok(undefined);
  }
}

test("deletes a task and all task-owned records", async () => {
  const tasks = new InMemoryTaskRepository();
  const dependencies = new InMemoryTaskDependencyRepository();
  const executions = new InMemoryExecutionRepository();
  const cleanup = new CleanupMemory();
  const workspaces = new WorkspaceMemory();
  await saveTask(tasks, taskProps("task", "completed"));
  await saveTask(tasks, taskProps("dependent", "draft"));
  await dependencies.replace([{ taskId: "dependent" as TaskId, prerequisiteId: "task" as TaskId }]);
  await executions.save({
    id: "execution" as TaskExecutionId,
    taskId: "task" as TaskId,
    workspace: workspace("task" as TaskId),
    status: "completed",
    createdAt: new Date(0), updatedAt: new Date(0), version: 0
  }, -1);

  const deleted = await new DeleteTaskWorkflow(
    tasks, new TaskLifecycleService(tasks, new SystemClock()), dependencies, executions, cleanup, cleanup, workspaces
  ).execute("task" as TaskId);

  assert.equal(deleted.ok, true);
  const missingTask = await tasks.findById("task" as TaskId);
  assert.equal(missingTask.ok && missingTask.value, undefined);
  assert.deepEqual(await dependencies.list(), { ok: true, value: [] });
  const missingExecution = await executions.findLatestByTask("task" as TaskId);
  assert.equal(missingExecution.ok && missingExecution.value, undefined);
  assert.deepEqual(cleanup.deleted, ["task", "task"]);
  assert.equal(workspaces.releases, 1);
  assert.equal(workspaces.lastForce, false);
});

test("passes an explicitly confirmed force option to worktree cleanup", async () => {
  const tasks = new InMemoryTaskRepository();
  const executions = new InMemoryExecutionRepository();
  await saveTask(tasks, taskProps("task", "failed"));
  await executions.save({
    id: "execution" as TaskExecutionId, taskId: "task" as TaskId,
    workspace: workspace("task" as TaskId), status: "failed",
    createdAt: new Date(0), updatedAt: new Date(0), version: 0
  }, -1);
  const workspaces = new WorkspaceMemory();
  const cleanup = new CleanupMemory();
  const result = await new DeleteTaskWorkflow(
    tasks, new TaskLifecycleService(tasks, new SystemClock()), new InMemoryTaskDependencyRepository(),
    executions, cleanup, cleanup, workspaces
  ).execute("task" as TaskId, true);
  assert.equal(result.ok, true);
  assert.equal(workspaces.lastForce, true);
});

test("refuses to delete active task states", async () => {
  const tasks = new InMemoryTaskRepository();
  await saveTask(tasks, taskProps("task", "running"));
  const cleanup = new CleanupMemory();
  const deleted = await new DeleteTaskWorkflow(
    tasks, new TaskLifecycleService(tasks, new SystemClock()),
    new InMemoryTaskDependencyRepository(), new InMemoryExecutionRepository(),
    cleanup, cleanup, new WorkspaceMemory()
  ).execute("task" as TaskId);
  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.equal(deleted.error.code, "task.delete-not-allowed");
  assert.equal((await tasks.findById("task" as TaskId)).ok, true);
});

test("keeps task history when its worktree cannot be released safely", async () => {
  const tasks = new InMemoryTaskRepository();
  const executions = new InMemoryExecutionRepository();
  await saveTask(tasks, taskProps("task", "cancelled"));
  await executions.save({
    id: "execution" as TaskExecutionId, taskId: "task" as TaskId,
    workspace: workspace("task" as TaskId), status: "cancelled",
    createdAt: new Date(0), updatedAt: new Date(0), version: 0
  }, -1);
  const workspaces = new WorkspaceMemory();
  workspaces.releaseFailure = {
    code: "workspace.dirty", category: "conflict", message: "Workspace is dirty.", retryable: false
  };
  const cleanup = new CleanupMemory();

  const deleted = await new DeleteTaskWorkflow(
    tasks, new TaskLifecycleService(tasks, new SystemClock()), new InMemoryTaskDependencyRepository(),
    executions, cleanup, cleanup, workspaces
  ).execute("task" as TaskId);

  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.equal(deleted.error.code, "workspace.dirty");
  const retained = await tasks.findById("task" as TaskId);
  assert.equal(retained.ok && !!retained.value, true);
  if (retained.ok && retained.value) assert.equal(retained.value.snapshot().status, "deleting");
  assert.deepEqual(cleanup.deleted, []);

  workspaces.releaseFailure = undefined;
  const retried = await new DeleteTaskWorkflow(
    tasks, new TaskLifecycleService(tasks, new SystemClock()), new InMemoryTaskDependencyRepository(),
    executions, cleanup, cleanup, workspaces
  ).execute("task" as TaskId);
  assert.equal(retried.ok, true);
  const missing = await tasks.findById("task" as TaskId);
  assert.equal(missing.ok && missing.value, undefined);
});

async function saveTask(repository: InMemoryTaskRepository, props: TaskProps): Promise<void> {
  assert.equal((await repository.save(Task.restore(props), -1)).ok, true);
}

function taskProps(id: string, status: TaskProps["status"]): TaskProps {
  return {
    id: id as TaskId, title: id, acceptanceCriteria: [], priority: "normal", status,
    createdAt: new Date(0), updatedAt: new Date(0), version: 0
  };
}

function workspace(taskId: TaskId): WorkspaceRef {
  return {
    id: "workspace" as WorkspaceRef["id"], taskId,
    repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
    branch: "task", baseRef: "main"
  };
}
