import assert from "node:assert/strict";
import test from "node:test";
import { TaskId, TaskProps, TaskStatus } from "../modules/tasks/public";
import { sortTasksForDisplay, taskStatusLabel, taskTooltip } from "./taskPresentation";

test("task presentation prioritizes attention and active work", () => {
  const tasks = [
    task("done", "completed", "urgent", 4),
    task("queued low", "queued", "low", 3),
    task("review", "readyForReview", "normal", 2),
    task("approval", "awaitingApproval", "low", 1),
    task("queued urgent", "queued", "urgent", 0)
  ];

  assert.deepEqual(sortTasksForDisplay(tasks).map(item => item.title), [
    "approval", "review", "queued urgent", "queued low", "done"
  ]);
  assert.deepEqual(tasks.map(item => item.title), ["done", "queued low", "review", "approval", "queued urgent"]);
});

test("task presentation humanizes status and includes failure context", () => {
  const failed = { ...task("Broken", "failed", "high", 1), statusReason: "validation.failed" };
  assert.equal(taskStatusLabel("readyForReview"), "Ready for review");
  assert.match(taskTooltip(failed), /Reason: validation\.failed/);
  assert.match(taskTooltip(failed), /Priority: High/);
});

function task(title: string, status: TaskStatus, priority: TaskProps["priority"], minute: number): TaskProps {
  const date = new Date(Date.UTC(2026, 0, 1, 0, minute));
  return {
    id: title as TaskId,
    title,
    acceptanceCriteria: [],
    priority,
    status,
    createdAt: date,
    updatedAt: date,
    version: 0
  };
}
