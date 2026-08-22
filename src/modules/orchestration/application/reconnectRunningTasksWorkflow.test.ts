import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { AgentApprovalHandler, AgentEventListener, AgentExecutionRef, AgentRuntimeHealth, AgentRuntimePort, AgentThreadId, AgentTurnId, ExecutionId, ResumeExecutionInput, StartExecutionInput } from "../../agents/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { ReconnectRunningTasksWorkflow } from "./reconnectRunningTasksWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-21T12:00:00Z"); } }
class FakeAgent implements AgentRuntimePort {
  resumed: AgentThreadId[] = [];
  initialize(): Promise<void> { return Promise.resolve(); }
  start(_input: StartExecutionInput): Promise<AgentExecutionRef> { throw new Error("unused"); }
  async resume(input: ResumeExecutionInput): Promise<AgentExecutionRef> {
    this.resumed.push(input.threadId);
    return { executionId: "reconnected" as ExecutionId, threadId: input.threadId, turnId: "new-turn" as AgentTurnId };
  }
  steer(): Promise<void> { return Promise.resolve(); }
  interrupt(): Promise<void> { return Promise.resolve(); }
  subscribe(_listener: AgentEventListener): () => void { return () => undefined; }
  handleApprovals(_handler: AgentApprovalHandler): () => void { return () => undefined; }
  health(): AgentRuntimeHealth { return { status: "ready" }; }
}

test("reconnects every disconnected running task and reports connected tasks separately", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const executions = new InMemoryExecutionRepository();
  for (const id of ["one", "two"] as const) {
    const created = Task.create({ id: id as TaskId, title: id, now: clock.now() });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    for (const status of ["queued", "preparing", "running"] as const) created.value.transition(status, clock.now());
    await tasks.save(created.value, -1);
    await executions.save({
      id: `${id}-execution` as TaskExecutionId, taskId: id as TaskId,
      workspace: { id: `${id}-workspace` as WorkspaceId, taskId: id as TaskId, repositoryRoot: "/repo", worktreeRoot: "/trees", path: `/trees/${id}`, branch: id, baseRef: "main" },
      agent: { executionId: `${id}-agent` as ExecutionId, threadId: `${id}-thread` as AgentThreadId, turnId: `${id}-turn` as AgentTurnId },
      status: "running", createdAt: clock.now(), updatedAt: clock.now(), version: 0
    }, -1);
  }
  const agent = new FakeAgent();
  const result = await new ReconnectRunningTasksWorkflow(
    tasks, new TaskLifecycleService(tasks, clock), agent, executions, clock
  ).execute(new Set(["two" as TaskId]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.resumed, ["one"]);
  assert.deepEqual(result.value.skipped, ["two"]);
  assert.deepEqual(result.value.failed, []);
  assert.deepEqual(agent.resumed, ["one-thread"]);
});

test("reports a running task without a resumable execution instead of aborting the batch", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "missing" as TaskId, title: "missing", now: clock.now() });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  for (const status of ["queued", "preparing", "running"] as const) created.value.transition(status, clock.now());
  await tasks.save(created.value, -1);
  const result = await new ReconnectRunningTasksWorkflow(
    tasks, new TaskLifecycleService(tasks, clock), new FakeAgent(), new InMemoryExecutionRepository(), clock
  ).execute();

  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.value.failed[0]?.message ?? "", /resumable/);
});
