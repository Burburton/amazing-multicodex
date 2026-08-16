import assert from "node:assert/strict";
import test from "node:test";
import { ActivityId } from "../../modules/activity/public";
import { TaskId } from "../../modules/tasks/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoActivityRepository } from "./mementoActivityRepository";

class FakeState implements KeyValueState {
  private readonly values = new Map<string, unknown>();
  constructor(value?: unknown) { if (value !== undefined) this.values.set("amazingMultiCodex.activity.v1", value); }
  get<T>(key: string, defaultValue: T): T { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  update(key: string, value: unknown): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
}

test("assigns ordered sequences and returns newest activity first", async () => {
  const repository = new MementoActivityRepository(new FakeState());
  for (const summary of ["first", "second"]) {
    await repository.append({
      id: summary as ActivityId,
      taskId: "task-1" as TaskId,
      kind: "lifecycle",
      summary,
      occurredAt: new Date("2026-08-15T12:00:00Z")
    });
  }
  const records = await repository.listByTask("task-1" as TaskId);
  assert.equal(records.ok, true);
  if (!records.ok) return;
  assert.deepEqual(records.value.map(record => record.summary), ["second", "first"]);
  assert.deepEqual(records.value.map(record => record.sequence), [2, 1]);
});

test("returns a typed error for malformed stored activity", async () => {
  const repository = new MementoActivityRepository(new FakeState([{ summary: "missing fields" }]));
  const records = await repository.listByTask("task-1" as TaskId);
  assert.equal(records.ok, false);
  if (!records.ok) assert.equal(records.error.code, "activity.state-invalid");
});
