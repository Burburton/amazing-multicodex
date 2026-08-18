import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { ProjectId } from "../../projects/public";
import { TaskId, TaskProps } from "../domain/task";
import { TaskDependencyRepository } from "../ports/taskDependencyRepository";
import { TaskRepository } from "../ports/taskRepository";

export class ReassignTaskHandler {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly dependencies: TaskDependencyRepository,
    private readonly clock: Clock
  ) {}

  async execute(taskId: TaskId, projectId: ProjectId): Promise<Result<TaskProps>> {
    const [found, edges, allTasks] = await Promise.all([
      this.tasks.findById(taskId), this.dependencies.list(), this.tasks.list()
    ]);
    if (!found.ok) return found;
    if (!edges.ok) return edges;
    if (!allTasks.ok) return allTasks;
    if (!found.value) return err(notFound());
    const linkedIds = edges.value.flatMap(edge => {
      if (edge.taskId === taskId) return [edge.prerequisiteId];
      if (edge.prerequisiteId === taskId) return [edge.taskId];
      return [];
    });
    const projects = new Map(allTasks.value.map(task => [task.snapshot().id, task.snapshot().projectId]));
    if (linkedIds.some(id => projects.get(id) !== projectId)) return err(crossProject());
    const expectedVersion = found.value.snapshot().version;
    const assigned = found.value.assignProject(projectId, this.clock.now());
    if (!assigned.ok) return assigned;
    const saved = await this.tasks.save(found.value, expectedVersion);
    return saved.ok ? ok(found.value.snapshot()) : saved;
  }
}

function notFound(): AppError {
  return { code: "task.not-found", category: "validation", message: "Task was not found.", retryable: false };
}
function crossProject(): AppError {
  return { code: "task.project-dependency-conflict", category: "conflict", message: "Remove this task's dependencies before moving it; dependencies cannot cross projects.", retryable: false };
}
