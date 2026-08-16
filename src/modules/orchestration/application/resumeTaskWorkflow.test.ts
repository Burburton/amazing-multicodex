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
import { ResumeTaskWorkflow } from "./resumeTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class ResumingAgent implements AgentRuntimePort {
  resumed?: ResumeExecutionInput;
  interrupted?: AgentExecutionRef;
  failInterrupt = false;
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  async resume(input: ResumeExecutionInput): Promise<AgentExecutionRef> {
    this.resumed = input;
    return {
      executionId: "agent-2" as ExecutionId,
      threadId: input.threadId,
      turnId: "turn-2" as AgentTurnId
    };
  }
  steer(): Promise<void> { return Promise.resolve(); }
  async interrupt(execution: AgentExecutionRef): Promise<void> {
    this.interrupted = execution;
    if (this.failInterrupt) throw new Error("interrupt unavailable");
  }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("resumes the persisted thread in its existing worktree", async () => {
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
  const agent = new ResumingAgent();
  const result = await new ResumeTaskWorkflow(
    new TaskLifecycleService(tasks, clock), agent, executions, clock
  ).execute({ taskId: "task-1" as TaskId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(agent.resumed?.threadId, "thread-1");
  assert.equal(agent.resumed?.cwd, "/worktrees/one");
  assert.equal(result.value.agent?.turnId, "turn-2");
  assert.equal(result.value.version, 1);
});

test("interrupts a resumed turn when its new binding cannot be persisted", async () => {
  const { clock, tasks, record } = await runningState("task-save-failure");
  const persistenceError = {
    code: "execution.persistence-failed", category: "unavailable" as const,
    message: "failed", retryable: true
  };
  const executions = {
    findActiveByTask: async () => ({ ok: true as const, value: record }),
    save: async () => ({ ok: false as const, error: persistenceError })
  };
  const agent = new ResumingAgent();

  const result = await new ResumeTaskWorkflow(
    new TaskLifecycleService(tasks, clock), agent, executions as never, clock
  ).execute({ taskId: record.taskId });

  assert.equal(result.ok, false);
  assert.equal(agent.interrupted?.turnId, "turn-2");
});

test("blocks retry when an unpersisted resumed turn cannot be interrupted", async () => {
  const { clock, tasks, record } = await runningState("task-orphan-turn");
  const executions = {
    findActiveByTask: async () => ({ ok: true as const, value: record }),
    save: async () => ({ ok: false as const, error: {
      code: "execution.persistence-failed", category: "unavailable" as const,
      message: "failed", retryable: true
    } })
  };
  const agent = new ResumingAgent();
  agent.failInterrupt = true;

  const result = await new ResumeTaskWorkflow(
    new TaskLifecycleService(tasks, clock), agent, executions as never, clock
  ).execute({ taskId: record.taskId });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "execution.resume-compensation-failed");
  const found = await tasks.findById(record.taskId);
  assert.equal(found.ok && found.value?.snapshot().status, "blocked");
});

async function runningState(idValue: string) {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const id = idValue as TaskId;
  const task = Task.create({ id, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) throw new Error("setup failed");
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const record = {
    id: `${idValue}-execution` as TaskExecutionId,
    taskId: id,
    workspace: {
      id: `${idValue}-workspace` as WorkspaceId, taskId: id,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: `/worktrees/${idValue}`,
      branch: "branch", baseRef: "main"
    },
    agent: {
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
    status: "running" as const,
    createdAt: clock.now(), updatedAt: clock.now(), version: 0
  };
  return { clock, tasks, record };
}
