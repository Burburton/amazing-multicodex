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

    const prerequisites: TaskPrerequisiteSummary[] = [];
    for (const edge of edges.value) {
      const prerequisite = await this.tasks.get(edge.prerequisiteId);
      if (!prerequisite.ok) return prerequisite;
      prerequisites.push({
        taskId: prerequisite.value.id,
        title: prerequisite.value.title,
        status: prerequisite.value.status
      });
    }
    return ok({ task: task.value, prerequisites, latestExecution: execution.value, activity: activity.value });
  }
}
