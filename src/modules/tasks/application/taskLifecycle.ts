import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err } from "../../../shared/core/result";
import { TaskId, TaskProps, TaskStatus } from "../domain/task";
import { TaskRepository } from "../ports/taskRepository";

export class TaskLifecycleService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly clock: Clock
  ) {}

  async get(taskId: TaskId): Promise<Result<TaskProps>> {
    const found = await this.repository.findById(taskId);
    if (!found.ok) return found;
    if (!found.value) return err(taskNotFound(taskId));
    return { ok: true, value: found.value.snapshot() };
  }

  async transition(taskId: TaskId, next: TaskStatus, reason?: string): Promise<Result<TaskProps>> {
    const found = await this.repository.findById(taskId);
    if (!found.ok) return found;
    if (!found.value) return err(taskNotFound(taskId));
    const task = found.value;
    const before = task.snapshot().version;
    const transitioned = task.transition(next, this.clock.now(), reason);
    if (!transitioned.ok) return transitioned;
    const saved = await this.repository.save(task, before);
    if (!saved.ok) return saved;
    return { ok: true, value: task.snapshot() };
  }
}

function taskNotFound(id: TaskId): AppError {
  return {
    code: "task.not-found",
    category: "validation",
    message: "Task was not found.",
    retryable: false,
    context: { id }
  };
}

