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

test("rejects duplicate persisted task identities", async () => {
  const record = {
    id: "task-1", title: "Task", acceptanceCriteria: [], priority: "normal", status: "draft",
    createdAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  };
  const listed = await new MementoTaskRepository(new FakeState([record, record])).list();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "task.state-invalid");
});

test("serializes concurrent saves so different tasks are not lost", async () => {
  const repository = new MementoTaskRepository(new FakeState());
  const first = Task.create({ id: "task-1" as TaskId, title: "First", now: new Date("2026-08-15T12:00:00Z") });
  const second = Task.create({ id: "task-2" as TaskId, title: "Second", now: new Date("2026-08-15T12:00:00Z") });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const saved = await Promise.all([repository.save(first.value, -1), repository.save(second.value, -1)]);
  assert.equal(saved.every(result => result.ok), true);
  const listed = await repository.list();
  assert.equal(listed.ok && listed.value.length, 2);
});

test("rejects persisted state beyond the task capacity", async () => {
  const template = {
    title: "Task", acceptanceCriteria: [], priority: "normal", status: "draft",
    createdAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  };
  const records = Array.from({ length: 10_001 }, (_, index) => ({ ...template, id: `task-${index}` }));

  const listed = await new MementoTaskRepository(new FakeState(records)).list();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "task.state-invalid");
});

test("refuses to add a task after reaching storage capacity", async () => {
  const records = Array.from({ length: 10_000 }, (_, index) => ({
    id: `task-${index}`, title: "Task", acceptanceCriteria: [], priority: "normal", status: "draft",
    createdAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:00:00.000Z", version: 0
  }));
  const repository = new MementoTaskRepository(new FakeState(records));
  const created = Task.create({ id: "new-task" as TaskId, title: "New", now: new Date("2026-08-15T12:00:00Z") });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const saved = await repository.save(created.value, -1);
  assert.equal(saved.ok, false);
  if (!saved.ok) assert.equal(saved.error.code, "task.capacity-exceeded");
});
