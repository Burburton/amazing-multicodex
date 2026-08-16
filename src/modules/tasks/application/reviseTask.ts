import { Clock } from "../../../shared/core/clock";
import { AppError, Result, err } from "../../../shared/core/result";
import { TaskId, TaskPriority, TaskProps } from "../domain/task";
import { TaskRepository } from "../ports/taskRepository";

export interface ReviseTaskCommand {
  readonly taskId: TaskId;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: TaskPriority;
}

export class ReviseTaskHandler {
  constructor(private readonly repository: TaskRepository, private readonly clock: Clock) {}

  async execute(command: ReviseTaskCommand): Promise<Result<TaskProps>> {
    const found = await this.repository.findById(command.taskId);
    if (!found.ok) return found;
    if (!found.value) return err(notFound(command.taskId));
    const task = found.value;
    const expectedVersion = task.snapshot().version;
    const revised = task.revise({ ...command, now: this.clock.now() });
    if (!revised.ok) return revised;
    const saved = await this.repository.save(task, expectedVersion);
    return saved.ok ? { ok: true, value: task.snapshot() } : saved;
  }
}

function notFound(taskId: TaskId): AppError {
  return {
    code: "task.not-found",
    category: "validation",
    message: "Task was not found.",
    retryable: false,
    context: { taskId }
  };
}
