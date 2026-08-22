import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeSnapshot, AgentRuntimePort, AgentThreadId, AgentTurnId, ExecutionId } from "../../agents/public";
import { Result, ok } from "../../../shared/core/result";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { WorkspaceId } from "../../workspaces/public";
import { ReconcileRuntimeWorkflow } from "./reconcileRuntimeWorkflow";

function execution(id: string) {
  return {
    id: `${id}-execution` as TaskExecutionId, taskId: id as never,
    workspace: { id: `${id}-workspace` as WorkspaceId, taskId: id as never, repositoryRoot: "/repo", worktreeRoot: "/trees", path: `/trees/${id}`, branch: id, baseRef: "main" },
    agent: { executionId: `${id}-agent` as ExecutionId, threadId: `${id}-thread` as AgentThreadId, turnId: `${id}-turn` as AgentTurnId },
    status: "running" as const, createdAt: new Date(), updatedAt: new Date(), version: 0
  };
}

test("classifies active and terminal runtime turns and forwards terminal events", async () => {
  const executions = new InMemoryExecutionRepository();
  await executions.save(execution("active"), -1);
  await executions.save(execution("done"), -1);
  const snapshots = new Map<string, AgentRuntimeSnapshot>([
    ["active", { threadId: "active-thread" as AgentThreadId, turnId: "active-turn" as AgentTurnId, threadStatus: "active", turnStatus: "inProgress" }],
    ["done", { threadId: "done-thread" as AgentThreadId, turnId: "done-turn" as AgentTurnId, threadStatus: "idle", turnStatus: "completed", handoff: "done" }]
  ]);
  const agents = { inspect: async (agent: { threadId: AgentThreadId }): Promise<Result<AgentRuntimeSnapshot>> => ok(snapshots.get(agent.threadId.split("-")[0])!) } as unknown as AgentRuntimePort;
  const reconciled: AgentRuntimeSnapshot[] = [];
  const coordinator = { reconcile: async (snapshot: AgentRuntimeSnapshot) => { reconciled.push(snapshot); } } as never;
  const result = await new ReconcileRuntimeWorkflow(executions, agents, coordinator).execute();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.active, ["active"]);
  assert.deepEqual(result.value.completed, ["done"]);
  assert.deepEqual(reconciled.map(item => item.turnId), ["done-turn"]);
});
