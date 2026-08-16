import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskDependencyService, TaskId, TaskRepository } from "../../tasks/public";
import { SchedulerPolicy } from "../domain/scheduler";
import { ExecutionRepository } from "../ports/executionRepository";
import { StartTaskWorkflow, StartTaskWorkflowCommand } from "./startTaskWorkflow";
import { ProjectId } from "../../projects/public";

export type DispatchQueuedTasksCommand = Omit<StartTaskWorkflowCommand, "taskId"> & {
  readonly projectId?: ProjectId;
  readonly includeUnassigned?: boolean;
};

export interface DispatchQueuedTasksReport {
  readonly selected: readonly TaskId[];
  readonly started: readonly TaskId[];
  readonly failures: readonly { taskId: TaskId; error: AppError }[];
}

export class DispatchQueuedTasksWorkflow {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly executions: ExecutionRepository,
    private readonly dependencies: TaskDependencyService,
    private readonly scheduler: SchedulerPolicy,
    private readonly starter: StartTaskWorkflow
  ) {}

  async execute(command: DispatchQueuedTasksCommand): Promise<Result<DispatchQueuedTasksReport>> {
    const [listed, active] = await Promise.all([this.tasks.list(), this.executions.listActive()]);
    if (!listed.ok) return listed;
    if (!active.ok) return active;

    const queued = listed.value.filter(task => {
      const snapshot = task.snapshot();
      return snapshot.status === "queued" && (snapshot.projectId === command.projectId
        || (command.includeUnassigned === true && snapshot.projectId === undefined));
    });
    const readiness = await Promise.all(queued.map(async task => {
      const snapshot = task.snapshot();
      const ready = await this.dependencies.prerequisitesSatisfied(snapshot.id);
      return ready.ok ? ok({
        taskId: snapshot.id,
        priority: snapshot.priority,
        queuedAt: snapshot.updatedAt,
        prerequisitesSatisfied: ready.value
      }) : ready;
    }));
    const failed = readiness.find(result => !result.ok);
    if (failed && !failed.ok) return err(failed.error);
    const candidates = readiness.flatMap(result => result.ok ? [result.value] : []);

    const selected = this.scheduler.select(candidates, active.value.length, command.concurrencyLimit);
    const started: TaskId[] = [];
    const failures: { taskId: TaskId; error: AppError }[] = [];
    for (const taskId of selected) {
      const { projectId: _projectId, includeUnassigned: _includeUnassigned, ...startCommand } = command;
      const result = await this.starter.execute({ ...startCommand, taskId });
      if (result.ok) started.push(taskId);
      else failures.push({ taskId, error: result.error });
    }
    return ok({ selected, started, failures });
  }
}
