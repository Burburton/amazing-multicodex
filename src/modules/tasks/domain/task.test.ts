import assert from "node:assert/strict";
import test from "node:test";
import { Task, TaskId } from "./task";

const now = new Date("2026-08-15T12:00:00.000Z");

test("creates a normalized draft task", () => {
  const result = Task.create({ id: "task-1" as TaskId, title: "  Build it  ", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.snapshot().title, "Build it");
  assert.equal(result.value.snapshot().status, "draft");
});

test("rejects task context that exceeds prompt and persistence bounds", () => {
  const description = Task.create({
    id: "description" as TaskId,
    title: "Task",
    description: "x".repeat(20_001),
    now
  });
  assert.equal(description.ok, false);
  if (!description.ok) assert.equal(description.error.code, "task.description-too-long");

  const count = Task.create({
    id: "count" as TaskId,
    title: "Task",
    acceptanceCriteria: Array.from({ length: 51 }, (_, index) => `criterion-${index}`),
    now
  });
  assert.equal(count.ok, false);
  if (!count.ok) assert.equal(count.error.code, "task.criteria-too-many");

  const criterion = Task.create({
    id: "criterion" as TaskId,
    title: "Task",
    acceptanceCriteria: ["x".repeat(2_001)],
    now
  });
  assert.equal(criterion.ok, false);
  if (!criterion.ok) assert.equal(criterion.error.code, "task.criterion-too-long");
});

test("rejects invalid task transitions", () => {
  const result = Task.create({ id: "task-1" as TaskId, title: "Build it", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const transition = result.value.transition("completed", now);
  assert.equal(transition.ok, false);
  if (transition.ok) return;
  assert.equal(transition.error.code, "task.invalid-transition");
});

test("increments version for valid transitions", () => {
  const result = Task.create({ id: "task-1" as TaskId, title: "Build it", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.transition("queued", now).ok, true);
  assert.equal(result.value.snapshot().version, 1);
});

test("revises normalized draft fields and locks them after queueing", () => {
  const result = Task.create({ id: "task-1" as TaskId, title: "Original", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const revised = result.value.revise({
    title: "  Revised  ",
    description: "  More context  ",
    acceptanceCriteria: ["  Works  "],
    priority: "high",
    now: new Date("2026-08-15T13:00:00Z")
  });
  assert.equal(revised.ok, true);
  assert.deepEqual(result.value.snapshot(), {
    id: "task-1",
    title: "Revised",
    description: "More context",
    acceptanceCriteria: ["Works"],
    priority: "high",
    status: "draft",
    createdAt: now,
    updatedAt: new Date("2026-08-15T13:00:00Z"),
    version: 1
  });
  assert.equal(result.value.transition("queued", now).ok, true);
  const locked = result.value.revise({
    title: "Too late", acceptanceCriteria: [], priority: "normal", now
  });
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.error.code, "task.revision-locked");
});

test("allows an integration-blocked task to return to review", () => {
  const result = Task.create({ id: "task-1" as TaskId, title: "Build it", now });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const status of ["queued", "preparing", "running", "validating", "readyForReview", "integrating", "blocked"] as const) {
    assert.equal(result.value.transition(status, now).ok, true);
  }
  assert.equal(result.value.transition("readyForReview", now, "integration-retry").ok, true);
});
