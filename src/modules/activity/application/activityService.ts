import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { Result } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { ActivityKind, ActivityRecord } from "../domain/activity";
import { redactAndTruncateSensitiveText } from "../domain/sensitiveText";
import { ActivityRepository } from "../ports/activityRepository";

export interface RecordActivityCommand {
  readonly taskId: TaskId;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly detail?: string;
}

export class ActivityService {
  constructor(
    private readonly repository: ActivityRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  record(command: RecordActivityCommand): Promise<Result<ActivityRecord>> {
    return this.repository.append({
      id: this.ids.next() as ActivityRecord["id"],
      taskId: command.taskId,
      kind: command.kind,
      summary: redactAndTruncateSensitiveText(command.summary.trim(), 500),
      detail: command.detail ? redactAndTruncateSensitiveText(command.detail.trim(), 200_000) || undefined : undefined,
      occurredAt: this.clock.now()
    });
  }

  list(taskId: TaskId, limit = 100): Promise<Result<readonly ActivityRecord[]>> {
    return this.repository.listByTask(taskId, limit);
  }
}
