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
import { AgentPlan, AgentPlanRepository, agentPlanTemplate } from "../../agents/public";
import { Result, ok } from "../../../shared/core/result";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { AgentEventCoordinator } from "./agentEventCoordinator";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class FakeAgent implements AgentRuntimePort {
  listener?: AgentEventListener;
  starts: StartExecutionInput[] = [];
  initialize(): Promise<void> { return Promise.resolve(); }
  start(input: StartExecutionInput): Promise<AgentExecutionRef> {
    this.starts.push(input);
    const index = this.starts.length + 1;
    return Promise.resolve({ executionId: `agent-${index}` as ExecutionId, threadId: `thread-${index}` as AgentThreadId, turnId: `turn-${index}` as AgentTurnId });
  }
  resume(_input: ResumeExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  steer(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(listener: AgentEventListener): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

class Plans implements AgentPlanRepository {
  constructor(private readonly plan: AgentPlan) {}
  async findByTask(): Promise<Result<AgentPlan | undefined>> { return ok(this.plan); }
  async save(): Promise<Result<void>> { return ok(undefined); }
  async deleteByTask(): Promise<Result<void>> { return ok(undefined); }
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

test("starts the next configured role in the same worktree before validation", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-2" as TaskId, title: "Pipeline", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution-2" as TaskExecutionId, taskId: "task-2" as TaskId,
    workspace: { id: "workspace-2" as WorkspaceId, taskId: "task-2" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/two", branch: "branch", baseRef: "main" },
    agent: { executionId: "agent-1" as ExecutionId, threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId },
    stage: { index: 0, total: 2, role: "implementer" }, status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
  }, -1);
  const plan = AgentPlan.create({ taskId: "task-2" as TaskId, stages: agentPlanTemplate("reviewed"), updatedAt: clock.now() });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const agents = new FakeAgent();
  new AgentEventCoordinator(agents, executions, new TaskLifecycleService(tasks, clock), clock, undefined, new Plans(plan.value)).start();
  agents.listener?.({ type: "agentMessageDelta", threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId, delta: "Implementation complete." });
  agents.listener?.({ type: "turnCompleted", threadId: "thread-1" as AgentThreadId, turnId: "turn-1" as AgentTurnId, status: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  const execution = await executions.findActiveByTask("task-2" as TaskId);
  assert.equal(execution.ok && execution.value?.stage?.role, "reviewer");
  assert.equal(execution.ok && execution.value?.previousAgents?.length, 1);
  assert.equal(agents.starts[0]?.cwd, "/worktrees/two");
  assert.match(agents.starts[0]?.prompt ?? "", /Implementation complete/);
  const found = await tasks.findById("task-2" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "running");
  agents.listener?.({ type: "agentMessageDelta", threadId: "thread-2" as AgentThreadId, turnId: "turn-2" as AgentTurnId, delta: "Fix edge case.\nVERDICT: CHANGES_REQUESTED" });
  agents.listener?.({ type: "turnCompleted", threadId: "thread-2" as AgentThreadId, turnId: "turn-2" as AgentTurnId, status: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  const returned = await executions.findActiveByTask("task-2" as TaskId);
  assert.equal(returned.ok && returned.value?.stage?.role, "implementer");
  assert.equal(returned.ok && returned.value?.reviewCycles, 1);
  assert.match(agents.starts[1]?.prompt ?? "", /Fix edge case/);
  agents.listener?.({ type: "agentMessageDelta", threadId: "thread-3" as AgentThreadId, turnId: "turn-3" as AgentTurnId, delta: "Edge case fixed." });
  agents.listener?.({ type: "turnCompleted", threadId: "thread-3" as AgentThreadId, turnId: "turn-3" as AgentTurnId, status: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  const reviewingAgain = await executions.findActiveByTask("task-2" as TaskId);
  assert.equal(reviewingAgain.ok && reviewingAgain.value?.stage?.role, "reviewer");
  assert.match(agents.starts[2]?.prompt ?? "", /VERDICT: APPROVED/);
  agents.listener?.({ type: "agentMessageDelta", threadId: "thread-4" as AgentThreadId, turnId: "turn-4" as AgentTurnId, delta: "Looks good.\nVERDICT: APPROVED" });
  agents.listener?.({ type: "turnCompleted", threadId: "thread-4" as AgentThreadId, turnId: "turn-4" as AgentTurnId, status: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  const completed = await tasks.findById("task-2" as TaskId);
  assert.equal(completed.ok && completed.value?.snapshot().status, "validating");
});

test("fails a pipeline after three requested-change review cycles", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "limited" as TaskId, title: "Limited", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) task.value.transition(status, clock.now());
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({ id: "limited-execution" as TaskExecutionId, taskId: "limited" as TaskId,
    workspace: { id: "limited-workspace" as WorkspaceId, taskId: "limited" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/limited", branch: "branch", baseRef: "main" },
    agent: { executionId: "limited-agent" as ExecutionId, threadId: "limited-thread" as AgentThreadId, turnId: "limited-turn" as AgentTurnId },
    stage: { index: 1, total: 2, role: "reviewer" }, reviewCycles: 3, status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0 }, -1);
  const plan = AgentPlan.create({ taskId: "limited" as TaskId, stages: agentPlanTemplate("reviewed"), updatedAt: clock.now() });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const agents = new FakeAgent();
  new AgentEventCoordinator(agents, executions, new TaskLifecycleService(tasks, clock), clock, undefined, new Plans(plan.value)).start();
  agents.listener?.({ type: "agentMessageDelta", threadId: "limited-thread" as AgentThreadId, turnId: "limited-turn" as AgentTurnId, delta: "Still wrong.\nVERDICT: CHANGES_REQUESTED" });
  agents.listener?.({ type: "turnCompleted", threadId: "limited-thread" as AgentThreadId, turnId: "limited-turn" as AgentTurnId, status: "completed" });
  await new Promise(resolve => setImmediate(resolve));
  const failed = await tasks.findById("limited" as TaskId);
  assert.equal(failed.ok && failed.value?.snapshot().status, "failed");
  assert.equal(failed.ok && failed.value?.snapshot().statusReason, "agent-plan.review-limit");
  assert.equal(agents.starts.length, 0);
});
