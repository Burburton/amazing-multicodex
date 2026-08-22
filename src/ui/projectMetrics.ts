import { TaskProps } from "../modules/tasks/public";
import { AgentStageHistoryEntry } from "../modules/orchestration/public";

export interface ProjectMetrics {
  readonly total: number;
  readonly active: number;
  readonly attention: number;
  readonly completed: number;
  readonly failedStages: number;
  readonly runningAgents: number;
  readonly averageStageDurationMs?: number;
}

export function projectMetrics(tasks: readonly TaskProps[], histories: ReadonlyMap<TaskProps["id"], readonly AgentStageHistoryEntry[]> = new Map()): ProjectMetrics {
  const active = tasks.filter(task => ["preparing", "running", "awaitingApproval", "validating", "integrating"].includes(task.status)).length;
  const attention = tasks.filter(task => ["blocked", "failed", "readyForReview", "deleting"].includes(task.status)).length;
  const completed = tasks.filter(task => task.status === "completed").length;
  const runningAgents = tasks.filter(task => ["preparing", "running", "awaitingApproval"].includes(task.status)).length;
  const durations = tasks.flatMap(task => histories.get(task.id) ?? [])
    .filter(stage => stage.completedAt)
    .map(stage => stage.completedAt!.getTime() - stage.startedAt.getTime())
    .filter(duration => duration >= 0);
  return {
    total: tasks.length, active, attention, completed,
    failedStages: tasks.filter(task => task.status === "failed").length,
    runningAgents,
    averageStageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : undefined
  };
}
