import assert from "node:assert/strict";
import test from "node:test";
import { TaskProps } from "../modules/tasks/public";
import { projectMetrics } from "./projectMetrics";

const task = (status: TaskProps["status"]): TaskProps => ({
  id: `${status}-1` as TaskProps["id"], projectId: "project-1" as TaskProps["projectId"], title: status,
  description: "", acceptanceCriteria: [], priority: "normal", status, createdAt: new Date("2026-08-21T00:00:00Z"),
  updatedAt: new Date("2026-08-21T00:00:00Z"), version: 1, statusReason: undefined,
});

test("projects aggregate health and stage duration metrics", () => {
  const metrics = projectMetrics([
    task("running"), task("failed"), task("completed"), task("queued")
  ], new Map([["running-1" as TaskProps["id"], [{ index: 0, total: 1, role: "implementer", startedAt: new Date("2026-08-21T00:00:00Z"), completedAt: new Date("2026-08-21T00:01:00Z"), outcome: "completed" }]]]));
  assert.deepEqual(metrics, { total: 4, active: 1, attention: 1, completed: 1, failedStages: 1, runningAgents: 1, averageStageDurationMs: 60_000 });
});
