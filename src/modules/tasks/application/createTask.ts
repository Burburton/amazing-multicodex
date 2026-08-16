import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { Result } from "../../../shared/core/result";
import { Task, TaskId, TaskPriority, TaskProps } from "../domain/task";
import { TaskRepository } from "../ports/taskRepository";
import { ProjectId } from "../../projects/public";

export interface CreateTaskCommand {
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly priority?: TaskPriority;
}

export class CreateTaskHandler {
  constructor(
    private readonly repository: TaskRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  async execute(command: CreateTaskCommand): Promise<Result<TaskProps>> {
    const created = Task.create({
      id: this.ids.next() as TaskId,
      projectId: command.projectId,
      title: command.title,
      description: command.description,
      acceptanceCriteria: command.acceptanceCriteria,
      priority: command.priority,
      now: this.clock.now()
    });
    if (!created.ok) return created;

    const saved = await this.repository.save(created.value, -1);
    if (!saved.ok) return saved;
    return { ok: true, value: created.value.snapshot() };
  }
}
