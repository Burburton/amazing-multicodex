import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { TaskDependency, TaskDependencyRepository } from "../../modules/tasks/public";

const STORAGE_KEY = "amazingMultiCodex.dependencies.v1";

export class MementoTaskDependencyRepository implements TaskDependencyRepository {
  constructor(private readonly state: KeyValueState) {}
  async list(): Promise<Result<readonly TaskDependency[]>> {
    return ok([...this.state.get<TaskDependency[]>(STORAGE_KEY, [])]);
  }
  async replace(dependencies: readonly TaskDependency[]): Promise<Result<void>> {
    try {
      await this.state.update(STORAGE_KEY, [...dependencies]);
      return ok(undefined);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }
}

function persistenceError(cause: unknown): AppError {
  return { code: "task.dependency-persistence-failed", category: "unavailable", message: "Task dependencies could not be persisted.", retryable: true, cause };
}

