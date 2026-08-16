import { TaskId } from "../../tasks/public";

export function workspaceBranch(taskId: TaskId, title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const idSuffix = taskId.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toLowerCase();
  return `multicodex/${slug || "task"}-${idSuffix || "unknown"}`;
}

