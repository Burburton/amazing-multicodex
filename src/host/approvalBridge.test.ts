import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../shared/core/clock";
import { IdGenerator } from "../shared/core/idGenerator";
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
} from "../modules/agents/public";
import { InMemoryApprovalRepository } from "../modules/approvals/adapters/inMemoryApprovalRepository";
import { ApprovalService } from "../modules/approvals/public";
import { InMemoryExecutionRepository } from "../modules/orchestration/adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../modules/orchestration/public";
import { InMemoryTaskRepository } from "../modules/tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../modules/tasks/public";
import { WorkspaceId } from "../modules/workspaces/public";
import { ApprovalBridge } from "./approvalBridge";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class FixedIds implements IdGenerator { next(): string { return "approval-1"; } }
class ApprovalAgent implements AgentRuntimePort {
  handler?: AgentApprovalHandler;
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(handler: AgentApprovalHandler): () => void { this.handler = handler; return () => { this.handler = undefined; }; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("persists a decision and returns the protocol approval payload", async () => {
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
      baseRef: "base"
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
  const approvalRepository = new InMemoryApprovalRepository();
  const agent = new ApprovalAgent();
  const changed: TaskId[] = [];
  const bridge = new ApprovalBridge(
    agent,
    executions,
    new ApprovalService(approvalRepository, clock, new FixedIds()),
    new TaskLifecycleService(tasks, clock),
    { decide: async () => new Promise<"approved">(() => undefined) },
    { error: () => undefined, taskChanged: taskId => changed.push(taskId) }
  );
  bridge.start();
  const responsePromise = agent.handler?.({
    requestId: "request-1",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1" as AgentThreadId,
    turnId: "turn-1" as AgentTurnId,
    payload: { command: "npm test" }
  });
  await new Promise(resolve => setImmediate(resolve));
  const captured = await approvalRepository.findPendingByTask("task-1" as TaskId);
  assert.equal(captured.ok && captured.value.length, 1);
  if (!captured.ok || !captured.value[0]) return;
  assert.equal(bridge.decidePending(captured.value[0].snapshot().id, "approved"), true);
  const response = await responsePromise;
  assert.deepEqual(response, { decision: "accept" });
  const found = await tasks.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "running");
  const pending = await approvalRepository.findPendingByTask("task-1" as TaskId);
  assert.equal(pending.ok && pending.value.length, 0);
  assert.deepEqual(changed, ["task-1", "task-1"]);
});

test("cancels a captured approval when the task cannot await a decision", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution-1" as TaskExecutionId,
    taskId: "task-1" as TaskId,
    workspace: {
      id: "workspace-1" as WorkspaceId, taskId: "task-1" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/one",
      branch: "branch", baseRef: "base"
    },
    agent: {
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
    status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const approvals = new InMemoryApprovalRepository();
  const agent = new ApprovalAgent();
  const bridge = new ApprovalBridge(
    agent, executions, new ApprovalService(approvals, clock, new FixedIds()),
    new TaskLifecycleService(tasks, clock), { decide: async () => "approved" }
  );
  bridge.start();

  const response = await agent.handler?.({
    requestId: "request-1", method: "item/fileChange/requestApproval",
    threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId, payload: {}
  });

  assert.deepEqual(response, { decision: "cancel" });
  const pending = await approvals.findPendingByTask("task-1" as TaskId);
  assert.equal(pending.ok && pending.value.length, 0);
});

test("cancels and closes an approval when prompting fails", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution-1" as TaskExecutionId, taskId: "task-1" as TaskId,
    workspace: {
      id: "workspace-1" as WorkspaceId, taskId: "task-1" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/one",
      branch: "branch", baseRef: "base"
    },
    agent: {
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
    status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const approvals = new InMemoryApprovalRepository();
  const agent = new ApprovalAgent();
  new ApprovalBridge(
    agent, executions, new ApprovalService(approvals, clock, new FixedIds()),
    new TaskLifecycleService(tasks, clock), { decide: async () => { throw new Error("UI closed"); } }
  ).start();

  const response = await agent.handler?.({
    requestId: "request-1", method: "item/commandExecution/requestApproval",
    threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId, payload: {}
  });

  assert.deepEqual(response, { decision: "cancel" });
  const pending = await approvals.findPendingByTask("task-1" as TaskId);
  assert.equal(pending.ok && pending.value.length, 0);
  const found = await tasks.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "running");
});
