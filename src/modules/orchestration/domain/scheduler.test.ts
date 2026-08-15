import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { SchedulerPolicy, SchedulingCandidate } from "./scheduler";

const candidate = (
  taskId: string,
  priority: SchedulingCandidate["priority"],
  queuedAt: string,
  prerequisitesSatisfied = true
): SchedulingCandidate => ({
  taskId: taskId as TaskId,
  priority,
  queuedAt: new Date(queuedAt),
  prerequisitesSatisfied
});

test("selects runnable tasks by priority then FIFO within capacity", () => {
  const selected = new SchedulerPolicy().select([
    candidate("normal-old", "normal", "2026-01-01"),
    candidate("high-new", "high", "2026-01-03"),
    candidate("normal-new", "normal", "2026-01-02"),
    candidate("blocked", "urgent", "2026-01-01", false)
  ], 1, 3);
  assert.deepEqual(selected, ["high-new", "normal-old"]);
});

