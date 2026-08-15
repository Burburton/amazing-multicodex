import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId } from "./task";

export class TaskDependencyGraph {
  private readonly prerequisites = new Map<TaskId, Set<TaskId>>();

  constructor(edges: ReadonlyArray<readonly [TaskId, TaskId]> = []) {
    for (const [taskId, prerequisiteId] of edges) {
      const result = this.add(taskId, prerequisiteId);
      if (!result.ok) throw new Error(result.error.message);
    }
  }

  add(taskId: TaskId, prerequisiteId: TaskId): Result<void> {
    if (taskId === prerequisiteId) {
      return err(dependencyError("task.dependency-self", "A task cannot depend on itself."));
    }
    if (this.dependsOn(prerequisiteId, taskId)) {
      return err(dependencyError("task.dependency-cycle", "The dependency would create a cycle."));
    }

    const dependencies = this.prerequisites.get(taskId) ?? new Set<TaskId>();
    dependencies.add(prerequisiteId);
    this.prerequisites.set(taskId, dependencies);
    return ok(undefined);
  }

  remove(taskId: TaskId, prerequisiteId: TaskId): void {
    this.prerequisites.get(taskId)?.delete(prerequisiteId);
  }

  list(taskId: TaskId): readonly TaskId[] {
    return [...(this.prerequisites.get(taskId) ?? [])];
  }

  isRunnable(taskId: TaskId, completed: ReadonlySet<TaskId>): boolean {
    return this.list(taskId).every(id => completed.has(id));
  }

  private dependsOn(taskId: TaskId, possiblePrerequisite: TaskId): boolean {
    const visited = new Set<TaskId>();
    const pending = [taskId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === possiblePrerequisite) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...this.list(current));
    }
    return false;
  }
}

function dependencyError(code: string, message: string): AppError {
  return { code, category: "conflict", message, retryable: false };
}

