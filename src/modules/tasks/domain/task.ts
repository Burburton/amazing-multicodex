import { Brand } from "../../../shared/core/brand";
import { AppError, Result, err, ok } from "../../../shared/core/result";

export type TaskId = Brand<string, "TaskId">;

export type TaskStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "running"
  | "awaitingApproval"
  | "validating"
  | "readyForReview"
  | "integrating"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskProps {
  readonly id: TaskId;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly statusReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface NewTaskProps {
  readonly id: TaskId;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly priority?: TaskPriority;
  readonly now: Date;
}

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["preparing", "cancelled"],
  preparing: ["running", "blocked", "failed", "cancelled"],
  running: ["awaitingApproval", "validating", "blocked", "failed", "cancelled"],
  awaitingApproval: ["running", "blocked", "failed", "cancelled"],
  validating: ["readyForReview", "running", "blocked", "failed", "cancelled"],
  readyForReview: ["integrating", "running", "cancelled"],
  integrating: ["completed", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: ["queued", "readyForReview", "cancelled"],
  failed: ["queued", "cancelled"],
  cancelled: ["queued"]
};

export class Task {
  private constructor(private props: TaskProps) {}

  static create(input: NewTaskProps): Result<Task> {
    const title = input.title.trim();
    if (title.length === 0) {
      return err(taskError("task.title-required", "Task title is required."));
    }
    if (title.length > 200) {
      return err(taskError("task.title-too-long", "Task title cannot exceed 200 characters."));
    }

    return ok(new Task({
      id: input.id,
      title,
      description: normalizeOptional(input.description),
      acceptanceCriteria: (input.acceptanceCriteria ?? [])
        .map(item => item.trim())
        .filter(Boolean),
      priority: input.priority ?? "normal",
      status: "draft",
      createdAt: input.now,
      updatedAt: input.now,
      version: 0
    }));
  }

  static restore(props: TaskProps): Task {
    return new Task({ ...props, acceptanceCriteria: [...props.acceptanceCriteria] });
  }

  snapshot(): TaskProps {
    return { ...this.props, acceptanceCriteria: [...this.props.acceptanceCriteria] };
  }

  transition(next: TaskStatus, now: Date, reason?: string): Result<void> {
    if (!transitions[this.props.status].includes(next)) {
      return err(taskError(
        "task.invalid-transition",
        `Cannot transition task from ${this.props.status} to ${next}.`,
        { current: this.props.status, next }
      ));
    }

    this.props = {
      ...this.props,
      status: next,
      statusReason: normalizeOptional(reason),
      updatedAt: now,
      version: this.props.version + 1
    };
    return ok(undefined);
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function taskError(code: string, message: string, context?: Record<string, string>): AppError {
  return { code, category: "validation", message, retryable: false, context };
}
