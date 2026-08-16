import assert from "node:assert/strict";
import test from "node:test";
import { Task, TaskId } from "../../modules/tasks/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoTaskRepository } from "./mementoTaskRepository";

class FakeState implements KeyValueState {
  private readonly values = new Map<string, unknown>();
  constructor(value?: unknown) { if (value !== undefined) this.values.set("amazingMultiCodex.tasks.v2", value); }
  get<T>(key: string, defaultValue: T): T { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  update(key: string, value: unknown): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
}

test("round-trips tasks without leaking serialized date representation", async () => {
  const repository = new MementoTaskRepository(new FakeState());
  const created = Task.create({
    id: "task-1" as TaskId,
    title: "Persist me",
    now: new Date("2026-08-15T12:00:00Z")
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal((await repository.save(created.value, -1)).ok, true);
  const found = await repository.findById("task-1" as TaskId);
  assert.equal(found.ok, true);
  if (!found.ok || !found.value) return;
  assert.equal(found.value.snapshot().createdAt instanceof Date, true);
  assert.equal(found.value.snapshot().title, "Persist me");
});

test("returns a typed error for malformed stored task state", async () => {
  const repository = new MementoTaskRepository(new FakeState([{ id: "task-1", title: "Incomplete" }]));
  const listed = await repository.list();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "task.state-invalid");
});
