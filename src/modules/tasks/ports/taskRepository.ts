import { Result } from "../../../shared/core/result";
import { Task, TaskId, TaskProps } from "../domain/task";

export interface TaskRepository {
  findById(id: TaskId): Promise<Result<Task | undefined>>;
  list(): Promise<Result<readonly Task[]>>;
  save(task: Task, expectedVersion: number): Promise<Result<void>>;
}

export interface TaskRecordMapper {
  toRecord(task: Task): TaskProps;
  toDomain(record: TaskProps): Task;
}

