import { AppError, Result, err, ok } from "../../shared/core/result";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { TaskDependency, TaskDependencyGraph, TaskDependencyRepository } from "../../modules/tasks/public";

const STORAGE_KEY = "amazingMultiCodex.dependencies.v1";
const MAX_DEPENDENCIES = 10_000;
const MAX_TASK_ID_LENGTH = 512;

export class MementoTaskDependencyRepository implements TaskDependencyRepository {
  constructor(private readonly state: KeyValueState) {}
  async list(): Promise<Result<readonly TaskDependency[]>> {
    try {
      const stored = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(stored) || stored.length > MAX_DEPENDENCIES || !stored.every(isDependency)) {
        return err(corruptState());
      }
      const dependencies = stored.map(item => ({ taskId: item.taskId, prerequisiteId: item.prerequisiteId }));
      if (!isValidGraph(dependencies)) return err(corruptState());
      return ok(dependencies);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }
  async replace(dependencies: readonly TaskDependency[]): Promise<Result<void>> {
    if (!isValidGraph(dependencies)) return err(invalidGraph());
    try {
      await this.state.update(STORAGE_KEY, [...dependencies]);
      return ok(undefined);
    } catch (cause) {
      return err(persistenceError(cause));
    }
  }
  async deleteByTask(taskId: TaskDependency["taskId"]): Promise<Result<void>> {
    const listed = await this.list();
    if (!listed.ok) return listed;
    return this.replace(listed.value.filter(edge => edge.taskId !== taskId && edge.prerequisiteId !== taskId));
  }
}

function isValidGraph(dependencies: readonly TaskDependency[]): boolean {
  if (dependencies.length > MAX_DEPENDENCIES || !dependencies.every(isDependency)) return false;
  const keys = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.taskId}\0${dependency.prerequisiteId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  try {
    new TaskDependencyGraph(dependencies.map(edge => [edge.taskId, edge.prerequisiteId]));
    return true;
  } catch {
    return false;
  }
}

function isDependency(value: unknown): value is TaskDependency {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.taskId === "string"
    && candidate.taskId.length > 0
    && candidate.taskId.length <= MAX_TASK_ID_LENGTH
    && typeof candidate.prerequisiteId === "string"
    && candidate.prerequisiteId.length > 0
    && candidate.prerequisiteId.length <= MAX_TASK_ID_LENGTH;
}

function corruptState(): AppError {
  return {
    code: "task.dependency-state-invalid",
    category: "internal",
    message: "Stored task dependencies are invalid.",
    retryable: false
  };
}

function invalidGraph(): AppError {
  return {
    code: "task.dependency-graph-invalid",
    category: "validation",
    message: "Task dependencies must be unique and acyclic.",
    retryable: false
  };
}

function persistenceError(cause: unknown): AppError {
  return { code: "task.dependency-persistence-failed", category: "unavailable", message: "Task dependencies could not be persisted.", retryable: true, cause };
}
