import { TaskProps, TaskStatus } from "../modules/tasks/public";

export type ProjectTaskGroupId = "metrics" | "attention" | "active" | "queued" | "draft" | "completed" | "other";
export interface ProjectTaskGroup { readonly id: ProjectTaskGroupId; readonly label: string; readonly tasks: readonly TaskProps[] }

const attention = new Set<TaskStatus>(["blocked", "failed", "readyForReview", "deleting"]);
const active = new Set<TaskStatus>(["preparing", "running", "awaitingApproval", "validating", "integrating"]);

export function projectTaskGroup(status: TaskStatus): ProjectTaskGroupId {
  if (attention.has(status)) return "attention";
  if (active.has(status)) return "active";
  if (status === "queued") return "queued";
  if (status === "draft") return "draft";
  if (["completed", "cancelled"].includes(status)) return "completed";
  return "other";
}

export function groupProjectTasks(tasks: readonly TaskProps[]): readonly ProjectTaskGroup[] {
  const definitions: ReadonlyArray<readonly [ProjectTaskGroupId, string]> = [
    ["attention", "Needs attention"], ["active", "Active"], ["queued", "Queued"],
    ["draft", "Drafts"], ["completed", "Completed / cancelled"], ["other", "Other"]
  ];
  return definitions.map(([id, label]) => ({ id, label, tasks: tasks.filter(task => projectTaskGroup(task.status) === id) }))
    .filter(group => group.tasks.length > 0);
}
