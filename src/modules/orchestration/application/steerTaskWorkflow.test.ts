import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import {
  AgentApprovalHandler, AgentEventListener, AgentExecutionRef, AgentRuntimeHealth,
  AgentRuntimePort, AgentThreadId, AgentTurnId, ExecutionId, ResumeExecutionInput,
  StartExecutionInput
} from "../../agents/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { SteerTaskWorkflow } from "./steerTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-16T12:00:00Z"); } }

class SteeringAgent implements AgentRuntimePort {
  steered?: { execution: AgentExecutionRef; prompt: string };
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(execution: AgentExecutionRef, prompt: string): Promise<void> {
    this.steered = { execution, prompt };
    return Promise.resolve();
  }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("sends bounded follow-up instructions to the active persisted turn", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution-1" as TaskExecutionId,
    taskId: "task-1" as TaskId,
    workspace: {
      id: "workspace-1" as WorkspaceId, taskId: "task-1" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/one",
      branch: "branch", baseRef: "main"
    },
    agent: {
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
    status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const agent = new SteeringAgent();

  const result = await new SteerTaskWorkflow(
    new TaskLifecycleService(tasks, clock), executions, agent
  ).execute({ taskId: "task-1" as TaskId, prompt: "  Focus on tests  " });

  assert.equal(result.ok, true);
  assert.equal(agent.steered?.prompt, "Focus on tests");
  assert.equal(agent.steered?.execution.turnId, "turn-1");
});

test("rejects oversized follow-up instructions before calling Codex", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const agent = new SteeringAgent();
  const result = await new SteerTaskWorkflow(
    new TaskLifecycleService(tasks, clock), new InMemoryExecutionRepository(), agent
  ).execute({ taskId: "task-1" as TaskId, prompt: "x".repeat(20_001) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "task.follow-up-invalid");
  assert.equal(agent.steered, undefined);
});
