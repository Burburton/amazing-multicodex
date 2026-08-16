import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../modules/tasks/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoTaskDependencyRepository } from "./mementoTaskDependencyRepository";

class FakeState implements KeyValueState {
  constructor(private value: unknown = []) {}
  get<T>(_key: string, defaultValue: T): T { return (this.value ?? defaultValue) as T; }
  update(_key: string, value: unknown): Thenable<void> { this.value = value; return Promise.resolve(); }
}

test("persists dependency edges without sharing the caller array", async () => {
  const state = new FakeState();
  const repository = new MementoTaskDependencyRepository(state);
  const edges = [{ taskId: "task" as TaskId, prerequisiteId: "first" as TaskId }];
  assert.equal((await repository.replace(edges)).ok, true);
  edges.push({ taskId: "task" as TaskId, prerequisiteId: "second" as TaskId });

  const listed = await repository.list();
  assert.equal(listed.ok, true);
  if (listed.ok) assert.equal(listed.value.length, 1);
});

test("reports invalid persisted dependency state", async () => {
  const repository = new MementoTaskDependencyRepository(new FakeState([{ taskId: "task" }]));
  const listed = await repository.list();
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.code, "task.dependency-state-invalid");
});
