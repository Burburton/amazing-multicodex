import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { TaskDependency, TaskDependencyRepository } from "../../modules/tasks/public";

const STORAGE_KEY = "amazingMultiCodex.dependencies.v1";

export class MementoTaskDependencyRepository implements TaskDependencyRepository {
  constructor(private readonly state: KeyValueState) {}
  async list(): Promise<Result<readonly TaskDependency[]>> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || !stored.every(isDependency)) {
        return err(corruptState());
      }
      return ok(stored.map(item => ({ taskId: item.taskId, prerequisiteId: item.prerequisiteId })));
    } catch (cause) {
      return err(persistenceError(cause));
    }
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

function isDependency(value: unknown): value is TaskDependency {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.taskId === "string"
    && candidate.taskId.length > 0
    && typeof candidate.prerequisiteId === "string"
    && candidate.prerequisiteId.length > 0;
}

function corruptState(): AppError {
  return {
    code: "task.dependency-state-invalid",
    category: "internal",
    message: "Stored task dependencies are invalid.",
    retryable: false
  };
}

function persistenceError(cause: unknown): AppError {
  return { code: "task.dependency-persistence-failed", category: "unavailable", message: "Task dependencies could not be persisted.", retryable: true, cause };
}
