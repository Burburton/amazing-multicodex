import { TaskId, TaskPriority } from "../../tasks/public";

export interface SchedulingCandidate {
  readonly taskId: TaskId;
  readonly priority: TaskPriority;
  readonly queuedAt: Date;
  readonly prerequisitesSatisfied: boolean;
}

const priorityWeight: Readonly<Record<TaskPriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3
};

export class SchedulerPolicy {
  select(
    candidates: readonly SchedulingCandidate[],
    activeCount: number,
    concurrencyLimit: number
  ): readonly TaskId[] {
    const capacity = Math.max(0, concurrencyLimit - activeCount);
    return candidates
      .filter(candidate => candidate.prerequisitesSatisfied)
      .sort((left, right) =>
        priorityWeight[right.priority] - priorityWeight[left.priority]
        || left.queuedAt.getTime() - right.queuedAt.getTime()
        || left.taskId.localeCompare(right.taskId)
      )
      .slice(0, capacity)
      .map(candidate => candidate.taskId);
  }
}

