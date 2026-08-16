import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import {
  AgentApprovalHandler,
  AgentEventListener,
  AgentExecutionRef,
  AgentRuntimeHealth,
  AgentRuntimePort,
  ExecutionId,
  ResumeExecutionInput,
  StartExecutionInput
} from "../../agents/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { InMemoryTaskDependencyRepository } from "../../tasks/adapters/inMemoryTaskDependencyRepository";
import { Task, TaskDependencyService, TaskId, TaskLifecycleService } from "../../tasks/public";
import {
  ChangeSet,
  PrepareWorkspaceInput,
  ReleaseWorkspaceInput,
  WorkspaceId,
  WorkspacePort,
  WorkspaceRef,
  WorkspaceSnapshot
} from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { ExecutionCapacityGate } from "../domain/executionCapacityGate";
import { StartTaskWorkflow } from "./startTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class SequenceIds implements IdGenerator {
  private current = 0;
  next(): string { return `id-${++this.current}`; }
}
class FakeAgent implements AgentRuntimePort {
  started?: StartExecutionInput;
  failStart = false;
  initialize(): Promise<void> { return Promise.resolve(); }
  async start(input: StartExecutionInput): Promise<AgentExecutionRef> {
    this.started = input;
    if (this.failStart) throw new Error("unavailable");
    return { executionId: "agent-1" as ExecutionId, threadId: "thread-1" as never, turnId: "turn-1" as never };
  }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}
class FakeWorkspaces implements WorkspacePort {
  prepared?: PrepareWorkspaceInput;
  released?: ReleaseWorkspaceInput;
  releaseError?: AppError;
  async prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceRef>> {
    this.prepared = input;
    return ok({ ...input, path: `${input.worktreeRoot}/${input.id}` });
  }
  inspect(_workspace: WorkspaceRef): Promise<Result<WorkspaceSnapshot>> { throw new Error("unused"); }
  diff(_workspace: WorkspaceRef): Promise<Result<ChangeSet>> { throw new Error("unused"); }
  async release(input: ReleaseWorkspaceInput): Promise<Result<void>> {
    this.released = input;
    return this.releaseError ? err(this.releaseError) : ok(undefined);
  }
}

test("coordinates queued task, workspace, agent, and execution record", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({
    id: "task-12345678" as TaskId,
    title: "Build feature",
    acceptanceCriteria: ["Tests pass"],
    now: clock.now()
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await tasks.save(created.value, -1);
  const workspaces = new FakeWorkspaces();
  const agents = new FakeAgent();
  const executions = new InMemoryExecutionRepository();
  const workflow = new StartTaskWorkflow(
    new TaskLifecycleService(tasks, clock),
    workspaces,
    agents,
    executions,
    clock,
    new SequenceIds(),
    new ExecutionCapacityGate(),
    new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks)
  );
  const result = await workflow.execute({
    taskId: "task-12345678" as TaskId,
    repositoryRoot: "/repo",
    worktreeRoot: "/worktrees",
    baseRef: "main",
    concurrencyLimit: 2,
    model: "gpt-test"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "running");
  assert.equal(workspaces.prepared?.branch, "multicodex/build-feature-12345678-id2");
  assert.equal(agents.started?.cwd, "/worktrees/id-2");
  assert.equal(agents.started?.model, "gpt-test");
  assert.match(agents.started?.prompt ?? "", /Acceptance criteria/);
  const task = await tasks.findById("task-12345678" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().status, "running");
});

test("marks a prepared execution failed when Codex cannot start", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task-failed" as TaskId, title: "Failure", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await tasks.save(created.value, -1);
  const agents = new FakeAgent();
  agents.failStart = true;
  const executions = new InMemoryExecutionRepository();
  const workflow = new StartTaskWorkflow(
    new TaskLifecycleService(tasks, clock), new FakeWorkspaces(), agents, executions, clock,
    new SequenceIds(), new ExecutionCapacityGate(),
    new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks)
  );

  const result = await workflow.execute({
    taskId: "task-failed" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees",
    baseRef: "main", concurrencyLimit: 1
  });

  assert.equal(result.ok, false);
  const active = await executions.listActive();
  assert.equal(active.ok && active.value.length, 0);
  const task = await tasks.findById("task-failed" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().status, "blocked");
});

test("reports when a startup failure cannot close its active execution record", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task-compensation" as TaskId, title: "Failure", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await tasks.save(created.value, -1);
  const agent = new FakeAgent();
  agent.failStart = true;
  let saves = 0;
  const persistenceError: AppError = {
    code: "execution.persistence-failed", category: "unavailable", message: "failed", retryable: true
  };
  const executions = {
    findActiveByTask: async () => ok(undefined),
    listActive: async () => ok([]),
    save: async () => ++saves === 1 ? ok(undefined) : err(persistenceError)
  };

  const result = await new StartTaskWorkflow(
    new TaskLifecycleService(tasks, clock), new FakeWorkspaces(), agent, executions as never, clock,
    new SequenceIds(), new ExecutionCapacityGate(),
    new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks)
  ).execute({
    taskId: "task-compensation" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees",
    baseRef: "main", concurrencyLimit: 1
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "execution.compensation-failed");
    assert.match(result.error.message, /Reload the window/);
  }
});

test("releases a newly prepared worktree when execution persistence fails", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task-failed" as TaskId, title: "Failure", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await tasks.save(created.value, -1);
  const workspaces = new FakeWorkspaces();
  const persistenceError = {
    code: "execution.persistence-failed", category: "unavailable" as const,
    message: "failed", retryable: true
  };
  const executions = {
    findActiveByTask: async () => ok(undefined),
    listActive: async () => ok([]),
    save: async () => err(persistenceError)
  };
  const workflow = new StartTaskWorkflow(
    new TaskLifecycleService(tasks, clock), workspaces, new FakeAgent(), executions as never, clock,
    new SequenceIds(), new ExecutionCapacityGate(),
    new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks)
  );

  const result = await workflow.execute({
    taskId: "task-failed" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees",
    baseRef: "main", concurrencyLimit: 1
  });

  assert.equal(result.ok, false);
  assert.equal(workspaces.released?.force, false);
  assert.equal(workspaces.released?.workspace.id, "id-2");
});

test("reports the retained worktree path when persistence cleanup also fails", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task-failed" as TaskId, title: "Failure", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  created.value.transition("queued", clock.now());
  await tasks.save(created.value, -1);
  const workspaces = new FakeWorkspaces();
  workspaces.releaseError = {
    code: "git.command-failed", category: "unavailable", message: "cleanup failed", retryable: false
  };
  const executions = {
    findActiveByTask: async () => ok(undefined), listActive: async () => ok([]),
    save: async () => err({
      code: "execution.persistence-failed", category: "unavailable" as const,
      message: "failed", retryable: true
    })
  };
  const result = await new StartTaskWorkflow(
    new TaskLifecycleService(tasks, clock), workspaces, new FakeAgent(), executions as never, clock,
    new SequenceIds(), new ExecutionCapacityGate(),
    new TaskDependencyService(new InMemoryTaskDependencyRepository(), tasks)
  ).execute({
    taskId: "task-failed" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees",
    baseRef: "main", concurrencyLimit: 1
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "workspace.cleanup-failed");
    assert.equal(result.error.context?.path, "/worktrees/id-2");
  }
  const task = await tasks.findById("task-failed" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().statusReason, "workspace.cleanup-failed");
});
