import { TaskProps, TaskStatus } from "../modules/tasks/public";

const statusLabels: Readonly<Record<TaskStatus, string>> = {
  draft: "Draft",
  queued: "Queued",
  preparing: "Preparing",
  running: "Running",
  awaitingApproval: "Awaiting approval",
  validating: "Validating",
  readyForReview: "Ready for review",
  integrating: "Integrating",
  completed: "Completed",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  deleting: "Deleting"
};

const statusOrder: Readonly<Record<TaskStatus, number>> = {
  awaitingApproval: 0,
  readyForReview: 1,
  blocked: 2,
  failed: 3,
  running: 4,
  preparing: 5,
  validating: 6,
  integrating: 7,
  queued: 8,
  draft: 9,
  completed: 10,
  cancelled: 11,
  deleting: 0
};

const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export function taskStatusLabel(status: TaskStatus): string {
  return statusLabels[status];
}

export function taskPriorityLabel(priority: TaskProps["priority"]): string {
  return `${priority[0]?.toUpperCase() ?? ""}${priority.slice(1)}`;
}

export function sortTasksForDisplay(tasks: readonly TaskProps[]): TaskProps[] {
  return [...tasks].sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status]
    || priorityOrder[left.priority] - priorityOrder[right.priority]
    || right.updatedAt.getTime() - left.updatedAt.getTime()
    || left.title.localeCompare(right.title)
  );
}

export function taskTooltip(task: TaskProps): string {
  const lines = [
    task.description || "No task description",
    `Status: ${taskStatusLabel(task.status)}`,
    `Priority: ${taskPriorityLabel(task.priority)}`
  ];
  if (task.statusReason) lines.push(`Reason: ${task.statusReason}`);
  lines.push(`Updated: ${task.updatedAt.toLocaleString()}`);
  return lines.join("\n\n");
}
