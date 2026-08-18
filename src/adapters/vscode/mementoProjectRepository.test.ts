import assert from "node:assert/strict";
import test from "node:test";
import { Project, ProjectId } from "../../modules/projects/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoProjectRepository } from "./mementoProjectRepository";

class FakeState implements KeyValueState {
  value: unknown = [];
  get<T>(_key: string, defaultValue: T): T { return (this.value ?? defaultValue) as T; }
  update(_key: string, value: unknown): Thenable<void> { this.value = value; return Promise.resolve(); }
}

test("persists projects and resolves normalized repository roots", async () => {
  const state = new FakeState();
  const repository = new MementoProjectRepository(state);
  const project = Project.create({
    id: "project" as ProjectId, name: "API", repositoryRoot: "/workspace/api", baseRef: "main",
    createdAt: new Date(0), updatedAt: new Date(0)
  });
  assert.equal(project.ok, true);
  if (!project.ok) return;
  assert.equal((await repository.save(project.value)).ok, true);
  const found = await repository.findByRepositoryRoot("/workspace/other/../api");
  assert.equal(found.ok && found.value?.snapshot().name, "API");
});

test("rejects duplicate repository registration", async () => {
  const state = new FakeState();
  const repository = new MementoProjectRepository(state);
  for (const id of ["first", "second"]) {
    const project = Project.create({
      id: id as ProjectId, name: id, repositoryRoot: "/workspace/api", baseRef: "main",
      createdAt: new Date(0), updatedAt: new Date(0)
    });
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const saved = await repository.save(project.value);
    assert.equal(saved.ok, id === "first");
    if (!saved.ok) assert.equal(saved.error.code, "project.repository-duplicate");
  }
});

test("removes only the requested project", async () => {
  const state = new FakeState();
  const repository = new MementoProjectRepository(state);
  for (const id of ["first", "second"]) {
    const project = Project.create({
      id: id as ProjectId, name: id, repositoryRoot: `/workspace/${id}`, baseRef: "main",
      createdAt: new Date(0), updatedAt: new Date(0)
    });
    assert.equal(project.ok, true);
    if (project.ok) assert.equal((await repository.save(project.value)).ok, true);
  }
  assert.equal((await repository.delete("first" as ProjectId)).ok, true);
  const listed = await repository.list();
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.value.map(project => project.snapshot().id), ["second"]);
});
