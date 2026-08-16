import { Result } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { ActivityRecord, NewActivityRecord } from "../domain/activity";

export interface ActivityRepository {
  append(record: NewActivityRecord): Promise<Result<ActivityRecord>>;
  listByTask(taskId: TaskId, limit?: number): Promise<Result<readonly ActivityRecord[]>>;
}

