import { Clock } from "../../../shared/core/clock";
import { Result, ok } from "../../../shared/core/result";
import { AgentRuntimePort } from "../../agents/public";
import { TaskId, TaskRepository, TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository } from "../ports/executionRepository";
import { ResumeTaskWorkflow } from "./resumeTaskWorkflow";

export interface ReconnectRunningTasksReport {
  readonly resumed: readonly TaskId[];
  readonly skipped: readonly TaskId[];
  readonly failed: readonly { readonly taskId: TaskId; readonly message: string }[];
}

export class ReconnectRunningTasksWorkflow {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly lifecycle: TaskLifecycleService,
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly clock: Clock
  ) {}

  async execute(connected: ReadonlySet<TaskId> = new Set(), only?: ReadonlySet<TaskId>): Promise<Result<ReconnectRunningTasksReport>> {
    const listed = await this.tasks.list();
    if (!listed.ok) return listed;
    const resumed: TaskId[] = [];
    const skipped: TaskId[] = [];
    const failed: Array<{ readonly taskId: TaskId; readonly message: string }> = [];
    const resume = new ResumeTaskWorkflow(this.lifecycle, this.agents, this.executions, this.clock);
    for (const task of listed.value) {
      const snapshot = task.snapshot();
      if (snapshot.status !== "running") continue;
      if (only && !only.has(snapshot.id)) continue;
      if (connected.has(snapshot.id)) {
        skipped.push(snapshot.id);
        continue;
      }
      const result = await resume.execute({ taskId: snapshot.id });
      if (result.ok) resumed.push(snapshot.id);
      else failed.push({ taskId: snapshot.id, message: result.error.message });
    }
    return ok({ resumed, skipped, failed });
  }
}
