import { Result } from "../../../shared/core/result";
import { TaskId } from "../domain/task";

export interface TaskDependency {
  readonly taskId: TaskId;
  readonly prerequisiteId: TaskId;
}

export interface TaskDependencyRepository {
  list(): Promise<Result<readonly TaskDependency[]>>;
  replace(dependencies: readonly TaskDependency[]): Promise<Result<void>>;
}

export interface TaskDependencyDeletionRepository {
  deleteByTask(taskId: TaskId): Promise<Result<void>>;
}
