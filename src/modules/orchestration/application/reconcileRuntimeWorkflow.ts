import { Result, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId } from "../../tasks/public";
import { ExecutionRepository } from "../ports/executionRepository";
import { AgentEventCoordinator } from "./agentEventCoordinator";

export interface RuntimeReconciliationReport {
  readonly active: readonly TaskId[];
  readonly completed: readonly TaskId[];
  readonly failed: readonly { readonly taskId: TaskId; readonly message: string }[];
  readonly unavailable: readonly { readonly taskId: TaskId; readonly message: string }[];
}

export class ReconcileRuntimeWorkflow {
  constructor(
    private readonly executions: ExecutionRepository,
    private readonly agents: AgentRuntimePort,
    private readonly coordinator: AgentEventCoordinator
  ) {}

  async execute(): Promise<Result<RuntimeReconciliationReport>> {
    const listed = await this.executions.listActive();
    if (!listed.ok) return listed;
    const active: TaskId[] = [];
    const completed: TaskId[] = [];
    const failed: Array<{ readonly taskId: TaskId; readonly message: string }> = [];
    const unavailable: Array<{ readonly taskId: TaskId; readonly message: string }> = [];
    for (const execution of listed.value) {
      if (!execution.agent || !this.agents.inspect) {
        unavailable.push({ taskId: execution.taskId, message: "Runtime inspection is unavailable for this execution." });
        continue;
      }
      const snapshot = await this.agents.inspect(execution.agent);
      if (!snapshot.ok) {
        unavailable.push({ taskId: execution.taskId, message: snapshot.error.message });
        continue;
      }
      if (["completed", "interrupted", "failed"].includes(snapshot.value.turnStatus)) {
        await this.coordinator.reconcile(snapshot.value);
        if (snapshot.value.turnStatus === "completed") completed.push(execution.taskId);
        else failed.push({ taskId: execution.taskId, message: snapshot.value.error ?? `Turn ${snapshot.value.turnStatus}.` });
      } else {
        active.push(execution.taskId);
      }
    }
    return ok({ active, completed, failed, unavailable });
  }
}
