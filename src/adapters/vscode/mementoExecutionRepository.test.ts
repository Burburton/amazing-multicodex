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
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
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
  assert.equal(found.value.createdAt instanceof Date, true);
});

test("returns a typed error for malformed stored execution state", async () => {
  const repository = new MementoExecutionRepository(new FakeState([{ id: "execution-1" }]));
  const listed = await repository.listActive();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "execution.state-invalid");
});
