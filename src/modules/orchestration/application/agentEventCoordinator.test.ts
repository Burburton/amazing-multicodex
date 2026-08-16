import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import {
  AgentApprovalHandler,
  AgentEventListener,
  AgentExecutionRef,
  AgentRuntimeHealth,
  AgentRuntimePort,
  AgentThreadId,
  AgentTurnId,
  ExecutionId,
  ResumeExecutionInput,
  StartExecutionInput
} from "../../agents/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { AgentEventCoordinator } from "./agentEventCoordinator";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class FakeAgent implements AgentRuntimePort {
  listener?: AgentEventListener;
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(listener: AgentEventListener): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("moves a task to validation when its agent turn completes", async () => {
  const clock = new FixedClock();
  const taskRepository = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await taskRepository.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
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
    createdAt: clock.now(),
    updatedAt: clock.now(),
    version: 0
  }, -1);
  const agents = new FakeAgent();
  new AgentEventCoordinator(
    agents, executions, new TaskLifecycleService(taskRepository, clock), clock
  ).start();
  agents.listener?.({
    type: "turnCompleted",
    threadId: "thread-1" as AgentThreadId,
    turnId: "turn-1" as AgentTurnId,
    status: "completed"
  });
  await new Promise(resolve => setImmediate(resolve));
  const found = await taskRepository.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "validating");
});

