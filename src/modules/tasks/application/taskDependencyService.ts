import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AsyncOperationQueue } from "../../../shared/core/asyncOperationQueue";
import { TaskDependencyGraph } from "../domain/dependencyGraph";
import { TaskId } from "../domain/task";
import { TaskDependency, TaskDependencyRepository } from "../ports/taskDependencyRepository";
import { TaskRepository } from "../ports/taskRepository";

export class TaskDependencyService {
  private readonly mutations = new AsyncOperationQueue();
  constructor(
    private readonly dependencies: TaskDependencyRepository,
    private readonly tasks: TaskRepository
  ) {}

  async add(taskId: TaskId, prerequisiteId: TaskId): Promise<Result<void>> {
    return this.mutations.run(() => this.addOnce(taskId, prerequisiteId));
  }

  private async addOnce(taskId: TaskId, prerequisiteId: TaskId): Promise<Result<void>> {
    const [task, prerequisite] = await Promise.all([
      this.tasks.findById(taskId),
      this.tasks.findById(prerequisiteId)
    ]);
    if (!task.ok) return task;
    if (!prerequisite.ok) return prerequisite;
    if (!task.value || !prerequisite.value) return err(notFound());
    if (task.value.snapshot().status !== "draft") return err(notDraft(taskId));
    const listed = await this.dependencies.list();
    if (!listed.ok) return listed;
    const graph = new TaskDependencyGraph(listed.value.map(edge => [edge.taskId, edge.prerequisiteId]));
    const added = graph.add(taskId, prerequisiteId);
    if (!added.ok) return added;
    if (listed.value.some(edge => edge.taskId === taskId && edge.prerequisiteId === prerequisiteId)) return ok(undefined);
    return this.dependencies.replace([...listed.value, { taskId, prerequisiteId }]);
  }

  async remove(taskId: TaskId, prerequisiteId: TaskId): Promise<Result<void>> {
    return this.mutations.run(() => this.removeOnce(taskId, prerequisiteId));
  }

  private async removeOnce(taskId: TaskId, prerequisiteId: TaskId): Promise<Result<void>> {
    const task = await this.tasks.findById(taskId);
    if (!task.ok) return task;
    if (!task.value) return err(notFound());
    if (task.value.snapshot().status !== "draft") return err(notDraft(taskId));
    const listed = await this.dependencies.list();
    if (!listed.ok) return listed;
    return this.dependencies.replace(listed.value.filter(edge =>
      edge.taskId !== taskId || edge.prerequisiteId !== prerequisiteId
    ));
  }

  async prerequisitesSatisfied(taskId: TaskId): Promise<Result<boolean>> {
    const listed = await this.dependencies.list();
    if (!listed.ok) return listed;
    const prerequisiteIds = listed.value
      .filter(edge => edge.taskId === taskId)
      .map(edge => edge.prerequisiteId);
    for (const id of prerequisiteIds) {
      const prerequisite = await this.tasks.findById(id);
      if (!prerequisite.ok) return prerequisite;
      if (prerequisite.value?.snapshot().status !== "completed") return ok(false);
    }
    return ok(true);
  }

  async listFor(taskId: TaskId): Promise<Result<readonly TaskDependency[]>> {
    const listed = await this.dependencies.list();
    return listed.ok ? ok(listed.value.filter(edge => edge.taskId === taskId)) : listed;
  }
}

function notFound(): AppError {
  return { code: "task.dependency-not-found", category: "validation", message: "Both tasks must exist before adding a dependency.", retryable: false };
}

function notDraft(taskId: TaskId): AppError {
  return {
    code: "task.dependencies-locked",
    category: "conflict",
    message: "Task dependencies can only be changed while the task is a draft.",
    retryable: false,
    context: { taskId }
  };
}
