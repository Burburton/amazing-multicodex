import { ActivityRecord, ActivityService } from "../../activity/public";
import { Result, ok } from "../../../shared/core/result";
import { TaskDependencyService, TaskId, TaskLifecycleService, TaskProps } from "../../tasks/public";
import { TaskExecutionRecord, ExecutionRepository } from "../ports/executionRepository";

export interface TaskPrerequisiteSummary {
  readonly taskId: TaskId;
  readonly title: string;
  readonly status: TaskProps["status"];
}

export interface TaskDetailProjection {
  readonly task: TaskProps;
  readonly prerequisites: readonly TaskPrerequisiteSummary[];
  readonly latestExecution?: TaskExecutionRecord;
  readonly activity: readonly ActivityRecord[];
}

export class TaskDetailQuery {
  constructor(
    private readonly tasks: TaskLifecycleService,
    private readonly dependencies: TaskDependencyService,
    private readonly executions: ExecutionRepository,
    private readonly activity: ActivityService
  ) {}

  async execute(taskId: TaskId, activityLimit = 100): Promise<Result<TaskDetailProjection>> {
    const [task, edges, execution, activity] = await Promise.all([
      this.tasks.get(taskId),
      this.dependencies.listFor(taskId),
      this.executions.findLatestByTask(taskId),
      this.activity.list(taskId, activityLimit)
    ]);
    if (!task.ok) return task;
    if (!edges.ok) return edges;
    if (!execution.ok) return execution;
    if (!activity.ok) return activity;

    const resolved = await Promise.all(edges.value.map(edge => this.tasks.get(edge.prerequisiteId)));
    const failed = resolved.find(result => !result.ok);
    if (failed && !failed.ok) return failed;
    const prerequisites: TaskPrerequisiteSummary[] = resolved.flatMap(result => result.ok ? [{
      taskId: result.value.id,
      title: result.value.title,
      status: result.value.status
    }] : []);
    return ok({ task: task.value, prerequisites, latestExecution: execution.value, activity: activity.value });
  }
}
