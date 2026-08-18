import assert from "node:assert/strict";
import test from "node:test";
import { TaskId, TaskProps, TaskStatus } from "../modules/tasks/public";
import { groupProjectTasks } from "./projectPresentation";

function task(id: string, status: TaskStatus): TaskProps {
  return { id: id as TaskId, title: id, acceptanceCriteria: [], priority: "normal", status, createdAt: new Date(0), updatedAt: new Date(0), version: 0 };
}

test("groups project tasks by operator intent in stable order", () => {
  const groups = groupProjectTasks([task("done", "completed"), task("run", "running"), task("review", "readyForReview"), task("queue", "queued")]);
  assert.deepEqual(groups.map(group => [group.id, group.tasks.map(item => item.id)]), [
    ["attention", ["review"]], ["active", ["run"]], ["queued", ["queue"]], ["completed", ["done"]]
  ]);
});
