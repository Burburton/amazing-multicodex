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
import { CancelTaskWorkflow } from "./cancelTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class InterruptingAgent implements AgentRuntimePort {
  interrupted?: AgentExecutionRef;
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(): Promise<void> { return Promise.resolve(); }
  async interrupt(execution: AgentExecutionRef): Promise<void> { this.interrupted = execution; }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("interrupts the turn before making execution and task cancellation terminal", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  const agentRef = {
    executionId: "agent-1" as ExecutionId,
    threadId: "thread-1" as AgentThreadId,
    turnId: "turn-1" as AgentTurnId
  };
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
      baseRef: "base"
    },
    agent: agentRef,
    status: "running",
    createdAt: clock.now(),
    updatedAt: clock.now(),
    version: 0
  }, -1);
  const agent = new InterruptingAgent();
  const result = await new CancelTaskWorkflow(
    new TaskLifecycleService(tasks, clock), agent, executions, clock
  ).execute("task-1" as TaskId);
  assert.equal(result.ok, true);
  assert.equal(agent.interrupted, agentRef);
  const found = await tasks.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "cancelled");
  const execution = await executions.findById("execution-1" as TaskExecutionId);
  assert.equal(execution.ok && execution.value?.status, "cancelled");
});
