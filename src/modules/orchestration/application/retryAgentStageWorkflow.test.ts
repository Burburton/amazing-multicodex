import assert from "node:assert/strict";
import test from "node:test";
import { AgentPlan, AgentPlanRepository, AgentRuntimePort, AgentExecutionRef, ExecutionId, agentPlanTemplate } from "../../agents/public";
import { Result, ok } from "../../../shared/core/result";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { RetryAgentStageWorkflow } from "./retryAgentStageWorkflow";

class Plans implements AgentPlanRepository {
  constructor(private readonly plan: AgentPlan) {}
  async findByTask(): Promise<Result<AgentPlan | undefined>> { return ok(this.plan); }
  async save(): Promise<Result<void>> { return ok(undefined); }
  async deleteByTask(): Promise<Result<void>> { return ok(undefined); }
}

test("retries a failed stage in its existing worktree", async () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const tasks = new InMemoryTaskRepository();
  const created = Task.create({ id: "task" as TaskId, title: "Retry", now });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  for (const status of ["queued", "preparing", "running", "failed"] as const) created.value.transition(status, now);
  await tasks.save(created.value, -1);
  const executions = new InMemoryExecutionRepository();
  const oldAgent = { executionId: "old" as ExecutionId, threadId: "old-thread" as never, turnId: "old-turn" as never };
  await executions.save({ id: "execution" as TaskExecutionId, taskId: "task" as TaskId,
    workspace: { id: "workspace" as WorkspaceId, taskId: "task" as TaskId, repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task", branch: "branch", baseRef: "main" },
    agent: oldAgent, stage: { index: 1, total: 2, role: "reviewer" }, status: "failed", createdAt: now, updatedAt: now, version: 0 }, -1);
  const plan = AgentPlan.create({ taskId: "task" as TaskId, stages: agentPlanTemplate("reviewed"), updatedAt: now });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  let input: { cwd: string; prompt: string } | undefined;
  const nextAgent = { executionId: "new" as ExecutionId, threadId: "new-thread" as never, turnId: "new-turn" as never };
  const agents = { start: async (value: { cwd: string; prompt: string }) => { input = value; return nextAgent; }, interrupt: async () => undefined } as unknown as AgentRuntimePort;
  const retried = await new RetryAgentStageWorkflow(new TaskLifecycleService(tasks, { now: () => now }), agents, executions, new Plans(plan.value), { now: () => now }).execute("task" as TaskId);
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(retried.value.workspace.path, "/worktrees/task");
  assert.equal(retried.value.agent, nextAgent as AgentExecutionRef);
  assert.deepEqual(retried.value.previousAgents, [oldAgent]);
  assert.equal(input?.cwd, "/worktrees/task");
  assert.match(input?.prompt ?? "", /reviewer/);
  const task = await tasks.findById("task" as TaskId);
  assert.equal(task.ok && task.value?.snapshot().status, "running");
});
