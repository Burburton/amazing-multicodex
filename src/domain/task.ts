export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed";

export interface MultiCodexTask {
  readonly id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  agentRole?: string;
  worktreePath?: string;
  createdAt: number;
  updatedAt: number;
}

export function createTask(title: string, description?: string): MultiCodexTask {
  const now = Date.now();
  return {
    id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    description,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}
