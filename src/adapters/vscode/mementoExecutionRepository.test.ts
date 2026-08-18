import assert from "node:assert/strict";
import test from "node:test";
import { AgentThreadId, AgentTurnId, ExecutionId } from "../../modules/agents/public";
import { TaskExecutionId } from "../../modules/orchestration/public";
import { TaskId } from "../../modules/tasks/public";
import { WorkspaceId } from "../../modules/workspaces/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoExecutionRepository } from "./mementoExecutionRepository";

class FakeState implements KeyValueState {
  private readonly values = new Map<string, unknown>();
  constructor(value?: unknown) { if (value !== undefined) this.values.set("amazingMultiCodex.executions.v1", value); }
  get<T>(key: string, defaultValue: T): T { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  update(key: string, value: unknown): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
  stored(): readonly unknown[] { return this.get("amazingMultiCodex.executions.v1", []); }
}

test("persists and resolves execution by agent identity", async () => {
  const repository = new MementoExecutionRepository(new FakeState());
  const saved = await repository.save({
    id: "execution-1" as TaskExecutionId,
    taskId: "task-1" as TaskId,
    workspace: {
      id: "workspace-1" as WorkspaceId,
      taskId: "task-1" as TaskId,
      repositoryRoot: "/repo",
      worktreeRoot: "/worktrees",
      path: "/worktrees/one",
      branch: "branch",
      baseRef: "main"
    },
    agent: {
      executionId: "agent-2" as ExecutionId,
      threadId: "thread-2" as AgentThreadId,
      turnId: "turn-2" as AgentTurnId
    },
    previousAgents: [{ executionId: "agent-1" as ExecutionId, threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId }],
    stage: { index: 1, total: 2, role: "reviewer" },
    model: "gpt-test",
    reviewCycles: 2,
    status: "running",
    createdAt: new Date("2026-08-15T12:00:00Z"),
    updatedAt: new Date("2026-08-15T12:00:00Z"),
    version: 0
  }, -1);
  assert.equal(saved.ok, true);
  const found = await repository.findByAgent("thread-1" as AgentThreadId, "turn-1" as AgentTurnId);
  assert.equal(found.ok, true);
  if (!found.ok || !found.value) return;
  assert.equal(found.value.id, "execution-1");
  assert.equal(found.value.stage?.role, "reviewer");
  assert.equal(found.value.model, "gpt-test");
  assert.equal(found.value.reviewCycles, 2);
  assert.equal(found.value.createdAt instanceof Date, true);
});

test("returns a typed error for malformed stored execution state", async () => {
  const repository = new MementoExecutionRepository(new FakeState([{ id: "execution-1" }]));
  const listed = await repository.listActive();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "execution.state-invalid");
});

test("rejects duplicate persisted execution identities", async () => {
  const record = {
    id: "execution-1", taskId: "task-1",
    workspace: {
      id: "workspace-1", taskId: "task-1", repositoryRoot: "/repo",
      worktreeRoot: "/worktrees", path: "/worktrees/one", branch: "branch", baseRef: "main"
    },
    status: "completed", createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  };
  const listed = await new MementoExecutionRepository(new FakeState([record, record])).listActive();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "execution.state-invalid");
});

test("rejects multiple active executions for one task", async () => {
  const base = {
    taskId: "task-1",
    workspace: {
      id: "workspace-1", taskId: "task-1", repositoryRoot: "/repo",
      worktreeRoot: "/worktrees", path: "/worktrees/one", branch: "branch", baseRef: "main"
    },
    status: "running", createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  };
  const repository = new MementoExecutionRepository(new FakeState([
    { ...base, id: "execution-1" },
    { ...base, id: "execution-2", workspace: { ...base.workspace, id: "workspace-2" } }
  ]));

  const active = await repository.listActive();
  assert.equal(active.ok, false);
  if (!active.ok) assert.equal(active.error.code, "execution.state-invalid");
});

test("rejects duplicate persisted Codex turn associations", async () => {
  const base = {
    taskId: "task-1",
    workspace: {
      id: "workspace-1", taskId: "task-1", repositoryRoot: "/repo",
      worktreeRoot: "/worktrees", path: "/worktrees/one", branch: "branch", baseRef: "main"
    },
    agent: { executionId: "agent-1", threadId: "thread-1", turnId: "turn-1" },
    status: "completed", createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  };
  const repository = new MementoExecutionRepository(new FakeState([
    { ...base, id: "execution-1" },
    { ...base, id: "execution-2", taskId: "task-2", workspace: {
      ...base.workspace, id: "workspace-2", taskId: "task-2"
    } }
  ]));

  const active = await repository.listActive();
  assert.equal(active.ok, false);
  if (!active.ok) assert.equal(active.error.code, "execution.state-invalid");
});

test("rejects execution state beyond the persistence safety limit", async () => {
  const oversized = Array.from({ length: 10_001 }, () => null);
  const active = await new MementoExecutionRepository(new FakeState(oversized)).listActive();
  assert.equal(active.ok, false);
  if (!active.ok) assert.equal(active.error.code, "execution.state-invalid");
});

test("serializes concurrent writes so different executions are not lost", async () => {
  const repository = new MementoExecutionRepository(new FakeState());
  const base = {
    workspace: {
      id: "workspace-1" as WorkspaceId, taskId: "task-1" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/one",
      branch: "branch", baseRef: "main"
    },
    status: "prepared" as const,
    createdAt: new Date("2026-08-15T12:00:00Z"),
    updatedAt: new Date("2026-08-15T12:00:00Z"), version: 0
  };
  const [first, second] = await Promise.all([
    repository.save({ ...base, id: "execution-1" as TaskExecutionId, taskId: "task-1" as TaskId }, -1),
    repository.save({
      ...base, id: "execution-2" as TaskExecutionId, taskId: "task-2" as TaskId,
      workspace: { ...base.workspace, id: "workspace-2" as WorkspaceId, taskId: "task-2" as TaskId, path: "/worktrees/two" }
    }, -1)
  ]);
  assert.equal(first.ok && second.ok, true);
  const active = await repository.listActive();
  assert.equal(active.ok && active.value.length, 2);
});

test("bounds terminal history while preserving active and latest task executions", async () => {
  const stored = Array.from({ length: 1_002 }, (_, index) => ({
    id: `old-${index}`,
    taskId: index === 0 ? "task-with-active" : "task-with-history",
    workspace: {
      id: `workspace-${index}`,
      taskId: index === 0 ? "task-with-active" : "task-with-history",
      repositoryRoot: "/repo",
      worktreeRoot: "/worktrees",
      path: `/worktrees/${index}`,
      branch: `branch-${index}`,
      baseRef: "main"
    },
    status: index === 0 ? "running" : "completed",
    createdAt: new Date(index * 1_000).toISOString(),
    updatedAt: new Date(index * 1_000).toISOString(),
    version: 0
  }));
  const state = new FakeState(stored);
  const repository = new MementoExecutionRepository(state);
  const saved = await repository.save({
    id: "new-history" as TaskExecutionId,
    taskId: "another-task" as TaskId,
    workspace: {
      id: "new-workspace" as WorkspaceId,
      taskId: "another-task" as TaskId,
      repositoryRoot: "/repo",
      worktreeRoot: "/worktrees",
      path: "/worktrees/new",
      branch: "new-branch",
      baseRef: "main"
    },
    status: "completed",
    createdAt: new Date("2026-08-16T00:00:00Z"),
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    version: 0
  }, -1);
  assert.equal(saved.ok, true);
  assert.equal(state.stored().length, 1_000);
  assert.equal((await repository.findById("old-0" as TaskExecutionId)).ok, true);
  const latestHistory = await repository.findLatestByTask("task-with-history" as TaskId);
  const latestNew = await repository.findLatestByTask("another-task" as TaskId);
  assert.equal(latestHistory.ok && latestHistory.value?.id, "old-1001");
  assert.equal(latestNew.ok && latestNew.value?.id, "new-history");
});

test("deletes every execution owned by a task", async () => {
  const state = new FakeState();
  const repository = new MementoExecutionRepository(state);
  const base = {
    taskId: "task" as TaskId,
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "branch", baseRef: "main"
    },
    status: "completed" as const,
    createdAt: new Date(0), updatedAt: new Date(0), version: 0
  };
  assert.equal((await repository.save({ ...base, id: "first" as TaskExecutionId }, -1)).ok, true);
  assert.equal((await repository.save({ ...base, id: "second" as TaskExecutionId }, -1)).ok, true);
  assert.equal((await repository.deleteByTask("task" as TaskId)).ok, true);
  const latest = await repository.findLatestByTask("task" as TaskId);
  assert.equal(latest.ok && latest.value, undefined);
});
